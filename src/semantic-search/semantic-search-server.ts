/**
 * 의미 검색 서버 프로세스 자체(cli semantic-search-server): 모델 파일 다시 받기, 모델 불러오기, 기억 벡터 채우기, localhost 검색 서버.
 * 설계 전체 설명은 semantic-search/client.ts 맨 위에 있다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../store/schema.ts';
import { IDLE_MS, MEMORY_FILE, MODEL_DIR, MODEL_FILES, MODEL_PATH, MODEL_REPO, EMBED_MODEL, STATE_FILE, VECTOR_KEY, readState } from './config.ts';
import { logLine, noteFailure, noteRecovery, readDown, REFETCH_FAILED, writeDown } from './outage.ts';
import type { SemanticHits } from './client.ts';
import { Store } from '../store/store.ts';
import { pidAlive } from '../core/windows-process.ts';

type Embed = (texts: string[]) => Promise<Float32Array[]>;

/** HF's file list: size, and the hash to check (sha256 for large files, git's blob sha1 for the rest). */
async function repoFiles(signal: AbortSignal): Promise<Map<string, { size: number; sha256?: string; sha1: string }>> {
  const res = await fetch(`https://huggingface.co/api/models/${MODEL_REPO}/tree/main?recursive=true`, { signal });
  if (!res.ok) throw new Error(`${REFETCH_FAILED}: ${MODEL_REPO} 파일 목록 HTTP ${res.status}`);
  const list = (await res.json()) as Array<{ path: string; size: number; oid: string; lfs?: { oid: string } }>;
  return new Map(list.map((f) => [f.path, { size: f.size, sha256: f.lfs?.oid, sha1: f.oid }]));
}

/**
 * Downloads the model files from MODEL_REPO into a folder beside the model, checks each
 * against HF's size and hash, then moves them over the model's files. Returns the bytes fetched.
 */
async function refetchModel(): Promise<number> {
  const signal = AbortSignal.timeout(30 * 60_000);
  const tmp = `${MODEL_PATH}.download`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const files = await repoFiles(signal);
    let bytes = 0;
    for (const f of MODEL_FILES) {
      const want = files.get(f);
      if (!want) throw new Error(`${REFETCH_FAILED}: ${MODEL_REPO}에 ${f} 없음`);
      const res = await fetch(`https://huggingface.co/${MODEL_REPO}/resolve/main/${f}`, { signal });
      if (!res.ok || !res.body) throw new Error(`${REFETCH_FAILED}: ${f} HTTP ${res.status}`);
      const dest = path.join(tmp, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const sha256 = crypto.createHash('sha256');
      const sha1 = crypto.createHash('sha1').update(`blob ${want.size}\0`);
      const out = fs.createWriteStream(dest);
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        sha256.update(chunk);
        sha1.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      const ok = size === want.size && (want.sha256 ? sha256.digest('hex') === want.sha256 : sha1.digest('hex') === want.sha1);
      if (!ok) throw new Error(`${REFETCH_FAILED}: ${f} 크기·해시가 맞지 않음(${size}B)`);
      bytes += size;
    }
    // Only after every file checked out: a failed download leaves the old files as they were.
    for (const f of MODEL_FILES) {
      fs.mkdirSync(path.dirname(path.join(MODEL_PATH, f)), { recursive: true });
      fs.renameSync(path.join(tmp, f), path.join(MODEL_PATH, f));
    }
    return bytes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw msg.startsWith(REFETCH_FAILED) ? err : new Error(`${REFETCH_FAILED}: ${msg}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

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
 * Claims the state file; false if another live server already holds it. A server
 * bound to the secretary server replaces an on-demand one, which would otherwise
 * idle out and leave the server without a server.
 */
function claim(parent: number | undefined): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: null, parent }), { flag: 'wx' });
      return true;
    } catch {
      const other = readState();
      // The caller that started this server holds the file with its own pid until it learns this one (client.ts
      // startServer waits for Start-Process on Windows): the file is this server's to take.
      if (other && other.port === null && other.pid === Number(process.env.SECRETARY_SEMANTIC_SEARCH_SERVER_STARTER)) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: null, parent }));
        return true;
      }
      if (other && other.pid !== process.pid && pidAlive(other.pid)) {
        if (!parent || (other.parent && pidAlive(other.parent))) return false;
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

let recordedMb = 0;
/** This server's peak memory so far, kept in MEMORY_FILE as what a start needs (for the low-memory notice). */
function recordPeak(): void {
  const needMb = Math.round(process.resourceUsage().maxRSS / 1024);
  if (needMb <= recordedMb) return;
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ needMb, at: new Date().toISOString() }));
    recordedMb = needMb;
  } catch {}
}

export async function runServer(parent?: number, refetch = false): Promise<void> {
  if (!claim(parent)) return;
  process.on('exit', release);
  // Embedding takes the CPU for a moment on every prompt; below normal keeps the PC responsive meanwhile.
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
  const store = new Store(openDb());
  store.dropVectorsExcept(VECTOR_KEY);
  try {
    if (refetch) {
      // Marked before the download, so one that dies half-way is not started again.
      const down = readDown();
      if (down) writeDown({ ...down, refetched: true });
      logLine(Date.now(), `모델 파일 다시 받기 시작 · ${MODEL_REPO}`);
      const bytes = await refetchModel();
      logLine(Date.now(), `모델 파일 다시 받음 · ${Math.round(bytes / 2 ** 20)}MB · 크기·해시 확인`);
    }
    const embed = await loadModel();
    // Embed existing memories up front so the first real search is quick. The model only
    // allocates its working memory on the first run, so it runs once even with nothing to embed.
    await backfill(store, embed);
    await embed(['warm-up']);
    recordPeak();

    let idle: NodeJS.Timeout | undefined;
    const resetIdle = () => {
      clearTimeout(idle);
      if (!parent) idle = setTimeout(() => process.exit(0), IDLE_MS);
    };
    if (parent) setInterval(() => pidAlive(parent) || process.exit(0), 30_000);
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
            recordPeak();
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
