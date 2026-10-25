/**
 * Semantic search: finds memories that mean the same thing in different words.
 *
 * The embedding model (BGE-m3-ko, ~570 MB) takes seconds to load, too slow for a hook
 * that runs as a fresh process on every prompt. So a small helper process keeps it
 * loaded and callers ask it over localhost (~0.15 s).
 *
 * The secretary server (scripts/remote-server.ps1) starts the helper bound to itself:
 * it stays up as long as the server does and stops with it. Without the server, the
 * first caller starts it in the background (getting no semantic results that time),
 * and it exits after SECRETARY_EMBED_IDLE_MIN minutes without requests.
 *
 * The helper owns the vectors: before each search it embeds any memory that has
 * none yet, so memories saved from anywhere get picked up.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DB_PATH, PROJECT_ROOT } from './config.ts';
import { openDb } from './db.ts';
import { Store } from './store.ts';

/** Korean fine-tune of bge-m3 (q8 ONNX build), same size and speed; downloaded into models/ on first start. */
export const EMBED_MODEL = 'jaybon1840/BGE-m3-ko-onnx';
/**
 * Vectors are keyed by model and by what was embedded, so changing either re-embeds
 * everything once: the helper drops vectors under any other key when it starts.
 */
export const VECTOR_KEY = `${EMBED_MODEL}:content+tags`;
const MODEL_DIR = path.join(PROJECT_ROOT, 'models');
/** One helper per database, so a test or second copy never talks to the wrong one. */
const STATE_FILE = `${DB_PATH}.embedder.json`;
const IDLE_MS = (Number(process.env.SECRETARY_EMBED_IDLE_MIN) || 60) * 60_000;
const disabled = () => process.env.SECRETARY_EMBED === 'off';

export interface SemanticHits {
  /** Median similarity over all memories searched: the baseline a real match must clear. */
  median: number;
  hits: Array<{ id: number; sim: number }>;
}

export type SemanticSearch = (query: string, opts: { includeInvalid?: boolean; limit: number }) => Promise<SemanticHits | null>;

interface HelperState {
  pid: number;
  /** null while the model is still loading. */
  port: number | null;
  /** The process this helper lives and dies with; absent for an on-demand helper. */
  parent?: number;
}

function readState(): HelperState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as HelperState;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function startHelper(): void {
  spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'embed-server'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  }).unref();
}

/**
 * Client side. Returns null (callers fall back to word search) whenever the helper
 * isn't ready: not running yet, still loading, or too slow to answer.
 */
export function semanticClient(timeoutMs: number): SemanticSearch {
  return async (query, opts) => {
    if (disabled()) return null;
    const state = readState();
    if (!state || !alive(state.pid)) {
      startHelper();
      return null;
    }
    if (state.port === null) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/search`, {
        method: 'POST',
        body: JSON.stringify({ query, ...opts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok ? ((await res.json()) as SemanticHits) : null;
    } catch {
      return null;
    }
  };
}

// ---- helper process ---------------------------------------------------------

type Embed = (texts: string[]) => Promise<Float32Array[]>;

async function loadModel(): Promise<Embed> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = MODEL_DIR;
  const extract = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
  return async (texts) => {
    const out: Float32Array[] = [];
    // Small batches keep peak memory down on a modest CPU.
    for (let i = 0; i < texts.length; i += 8) {
      const t = await extract(texts.slice(i, i + 8), { pooling: 'cls', normalize: true });
      for (const row of t.tolist() as number[][]) out.push(Float32Array.from(row));
    }
    return out;
  };
}

/**
 * Claims the state file; false if another live helper already holds it. A helper
 * bound to the secretary server replaces an on-demand one, which would otherwise
 * idle out and leave the server without a helper.
 */
function claim(parent: number | undefined): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: null, parent }), { flag: 'wx' });
      return true;
    } catch {
      const other = readState();
      if (other && other.pid !== process.pid && alive(other.pid)) {
        if (!parent || (other.parent && alive(other.parent))) return false;
        process.kill(other.pid);
      }
      fs.rmSync(STATE_FILE, { force: true });
    }
  }
  return false;
}

function release(): void {
  if (readState()?.pid === process.pid) fs.rmSync(STATE_FILE, { force: true });
}

async function backfill(store: Store, embed: Embed): Promise<void> {
  const missing = store.memoriesWithoutVector(VECTOR_KEY);
  if (missing.length === 0) return;
  // Tags carry names the sentence may not (a workspace, a task number), so meaning search sees them too.
  const vectors = await embed(missing.map((m) => (m.tags ? `${m.content}\n${m.tags}` : m.content)));
  store.saveVectors(VECTOR_KEY, missing.map((m, i) => ({ id: m.id, vector: vectors[i] })));
}

export async function searchWith(store: Store, embed: Embed, query: string, opts: { includeInvalid?: boolean; limit: number }): Promise<SemanticHits> {
  await backfill(store, embed);
  const [q] = await embed([query]);
  const scored = store
    .vectors(VECTOR_KEY, opts.includeInvalid)
    .map(({ id, vector }) => ({ id, sim: dot(q, vector) }))
    .sort((a, b) => b.sim - a.sim);
  const median = scored.length ? scored[scored.length >> 1].sim : 0;
  return { median, hits: scored.slice(0, opts.limit) };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export async function runHelper(parent?: number): Promise<void> {
  if (!claim(parent)) return;
  process.on('exit', release);
  const store = new Store(openDb());
  store.dropVectorsExcept(VECTOR_KEY);
  try {
    const embed = await loadModel();
    // Embed existing memories up front so the first real search is quick.
    await backfill(store, embed);

    let idle: NodeJS.Timeout | undefined;
    const resetIdle = () => {
      clearTimeout(idle);
      if (!parent) idle = setTimeout(() => process.exit(0), IDLE_MS);
    };
    if (parent) setInterval(() => alive(parent) || process.exit(0), 30_000);
    let queue = Promise.resolve();
    const server = http.createServer((req, res) => {
      resetIdle();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // One search at a time: the model and the vector writes aren't shared safely.
        queue = queue.then(async () => {
          try {
            const { query, includeInvalid, limit } = JSON.parse(body) as { query: string; includeInvalid?: boolean; limit: number };
            const result = await searchWith(store, embed, String(query), { includeInvalid, limit: Number(limit) || 10 });
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500).end(String(err));
          }
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port, parent }));
      resetIdle();
    });
  } catch (err) {
    release();
    throw err;
  }
}
