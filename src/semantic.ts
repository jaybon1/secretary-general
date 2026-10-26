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
 *
 * Any caller that finds the helper gone starts it again at once; the state file doubles
 * as the start lock, so simultaneous prompts start one. A clean exit (idle, server gone)
 * removes the state file and is restarted silently. A real failure (the model would not
 * load, or a state file left behind by a crash) leaves a down file next to the database,
 * which tells each session once (embedderNotice), and a line in the failure log.
 * The helper deletes the down file and logs the recovery once it answers.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DB_PATH, PROJECT_ROOT, TIMEZONE } from './config.ts';
import { openDb } from './db.ts';
import { Store } from './store.ts';

/** Korean fine-tune of bge-m3 (q8 ONNX build), same size and speed; downloaded into models/ on first start. */
export const EMBED_MODEL = 'jaybon1840/BGE-m3-ko-onnx';
/**
 * Vectors are keyed by model and by what was embedded, so changing either re-embeds
 * everything once: the helper drops vectors under any other key when it starts.
 */
export const VECTOR_KEY = `${EMBED_MODEL}:content+tags`;
const MODEL_DIR = process.env.SECRETARY_EMBED_MODEL_DIR ?? path.join(PROJECT_ROOT, 'models');
/** One helper per database, so a test or second copy never talks to the wrong one. */
const STATE_FILE = `${DB_PATH}.embedder.json`;
const DOWN_FILE = `${DB_PATH}.embedder-down.json`;
export const FAILURE_LOG = `${DB_PATH}.embedder-failures.log`;
/** The failure log keeps this many last lines. */
export const FAILURE_LOG_LINES = 500;
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

/** Written on a real failure; deleted by the helper once it answers. */
export interface DownState {
  /** When the first failure of this outage happened. */
  since: string;
  failedAt: string;
  /** First line of the last failure. */
  error: string;
  /** Failures in a row in this outage. */
  failures: number;
  /** Sessions already told about this outage. */
  told: string[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const readState = () => readJson<HelperState>(STATE_FILE);
export const readDown = () => readJson<DownState>(DOWN_FILE);

// Best effort: the prompt hook runs these, and a failed write must not cost the memory injection.
// The worst case is a session told twice or a failure left out of the log.
function writeDown(d: DownState): void {
  try {
    fs.writeFileSync(DOWN_FILE, JSON.stringify(d));
  } catch {}
}

function clearDown(): void {
  try {
    fs.rmSync(DOWN_FILE, { force: true });
  } catch {}
}

const LOG_TIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Appends one line to the failure log, keeping the last FAILURE_LOG_LINES. */
function logLine(now: number, text: string): void {
  try {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(FAILURE_LOG, 'utf8').split('\n').filter(Boolean);
    } catch {}
    lines.push(`${LOG_TIME.format(now)} ${text}`);
    fs.writeFileSync(FAILURE_LOG, lines.slice(-FAILURE_LOG_LINES).join('\n') + '\n');
  } catch {}
}

const firstLine = (s: string) => s.split('\n')[0].slice(0, 300).replace(/\.$/, '');

/** A guess at the cause from the error text and free memory, so the log can be read without the stack. */
export function failureCause(error: string, freeMb: number): string {
  if (/bad_alloc|out of memory|ENOMEM|failed to allocate|allocation failed/i.test(error)) return '메모리 부족';
  if (/onnxruntime_binding|ERR_DLOPEN_FAILED|\.dll|specified module could not be found/i.test(error)) return '실행 라이브러리 로드 실패(VC++ 재배포 패키지?)';
  if (/Could not locate file|ENOENT|no such file|not found/i.test(error)) return '모델 파일 없음';
  if (/protobuf|corrupt|invalid model|Load model .* failed|Unexpected end|JSON/i.test(error)) return '모델 파일 깨짐';
  if (/^비정상 종료/.test(error)) return freeMb < 1500 ? '비정상 종료(메모리 부족 의심)' : '비정상 종료';
  return freeMb < 1500 ? '원인 미상(메모리 부족 의심)' : '원인 미상';
}

/** Records a real failure: the down file (so sessions are told) and a line in the failure log. */
export function noteFailure(err: unknown, now = Date.now(), freeMb = Math.round(os.freemem() / 2 ** 20)): DownState {
  const down = readDown();
  const at = new Date(now).toISOString();
  const error = firstLine(err instanceof Error ? err.message : String(err));
  const next: DownState = { since: down?.since ?? at, failedAt: at, error, failures: (down?.failures ?? 0) + 1, told: down?.told ?? [] };
  writeDown(next);
  logLine(now, `실패 · 연속 ${next.failures}번째 · ${failureCause(error, freeMb)} · 남은 메모리 ${freeMb}MB · ${error}`);
  return next;
}

/** Ends an outage: drops the down file and logs the recovery. No-op without an outage. */
export function noteRecovery(now = Date.now()): void {
  const down = readDown();
  if (!down) return;
  clearDown();
  logLine(now, `회복 · 연속 실패 ${down.failures}번 뒤`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Returns the helper's pid, or undefined if it could not be spawned. */
function startHelper(): number | undefined {
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'embed-server'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  // A spawn error arrives as an event; unhandled, it would crash the hook.
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

export type HelperStatus = 'off' | 'ready' | 'loading' | 'started';

/**
 * Starts the helper at once if it is gone. 'ready' carries the port; 'loading' means a
 * helper is starting (by this caller earlier, another caller, or the server).
 */
export function ensureHelper(now = Date.now(), start = startHelper): { status: HelperStatus; port?: number } {
  if (disabled()) return { status: 'off' };
  const state = readState();
  if (state && alive(state.pid)) return state.port === null ? { status: 'loading' } : { status: 'ready', port: state.port };
  if (state) {
    // A clean exit removes the state file; one left behind means the helper died (crash, killed).
    if (readState()?.pid === state.pid) {
      noteFailure(`비정상 종료(pid ${state.pid})`, now);
      fs.rmSync(STATE_FILE, { force: true });
    }
  }
  // The start lock: only one caller creates the state file, so prompts arriving together start one helper.
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: null }), { flag: 'wx' });
  } catch {
    return { status: 'loading' };
  }
  const pid = start();
  if (pid) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid, port: null }));
    return { status: 'started' };
  }
  fs.rmSync(STATE_FILE, { force: true });
  noteFailure('도우미 프로세스를 띄우지 못함', now);
  return { status: 'started' };
}

export const NOTICE = '의미 검색 도우미가 꺼져 있어 다시 띄우는 중이에요. 살아날 때까지 기다려 주세요(그래도 진행하면 단어 검색만 씁니다)';

/**
 * One line for the prompt hook during a real outage, once per session; '' otherwise
 * (no outage, or a helper that only idled out). Call it after the search.
 */
export function embedderNotice(sessionId: string, now = Date.now()): string {
  if (disabled()) return '';
  const down = readDown();
  if (!down) return '';
  try {
    const state = readState();
    if (state?.port != null && alive(state.pid)) {
      // Up already, but the helper's own recovery note was missed: the outage is over.
      noteRecovery(now);
      return '';
    }
    if (down.told.includes(sessionId)) return '';
    writeDown({ ...down, told: [...down.told, sessionId] });
    return `<secretary-embedder>${NOTICE}</secretary-embedder>`;
  } catch {
    // A hand-edited or half-written down file: say nothing rather than break the hook.
    return '';
  }
}

/**
 * Client side. Returns null (callers fall back to word search) whenever the helper
 * isn't ready: not running yet, still loading, down, or too slow to answer.
 */
export function semanticClient(timeoutMs: number): SemanticSearch {
  return async (query, opts) => {
    let status: HelperStatus;
    let port: number | undefined;
    try {
      ({ status, port } = ensureHelper());
    } catch {
      // A state file we could not write (locked, permissions): word search this time.
      return null;
    }
    if (status !== 'ready') return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
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
      noteRecovery();
      resetIdle();
    });
  } catch (err) {
    // Release first: the state file must be gone before the down file says "failed", or a
    // caller in between would also count it as a crash.
    release();
    noteFailure(err);
    throw err;
  }
}
