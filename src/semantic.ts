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
 *
 * When the model files are missing or broken, restarting alone cannot help: the next
 * start downloads them again from MODEL_REPO first (once per outage, inside the helper
 * process that holds the start lock, so the prompt hook never waits for it). If the
 * model still fails after that, the helper is no longer restarted until the user asks
 * (retryEmbedder) or the model files change.
 *
 * A failure for lack of memory (or one that only looks like it) is not restarted at all:
 * starting again would likely fail the same way and squeeze the PC further. Each session
 * is told how much the helper needs and how much is free, and asked whether to start it;
 * it waits for the user (retryEmbedder) and stops again if memory runs out again.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DB_PATH, PROJECT_ROOT, TIMEZONE } from './config.ts';
import { openDb } from './db.ts';
import { Store } from './store.ts';

/** Korean fine-tune of bge-m3 (q8 ONNX build), same size and speed; downloaded into models/ on first start. */
export const EMBED_MODEL = 'jaybon1840/BGE-m3-ko-onnx';
const MODEL_REPO = process.env.SECRETARY_EMBED_MODEL_REPO ?? EMBED_MODEL;
/** What loadModel reads, relative to the model folder. */
const MODEL_FILES = ['config.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
/**
 * Vectors are keyed by model and by what was embedded, so changing either re-embeds
 * everything once: the helper drops vectors under any other key when it starts.
 */
export const VECTOR_KEY = `${EMBED_MODEL}:content+tags`;
const MODEL_DIR = process.env.SECRETARY_EMBED_MODEL_DIR ?? path.join(PROJECT_ROOT, 'models');
const MODEL_PATH = path.join(MODEL_DIR, ...EMBED_MODEL.split('/'));
/** One helper per database, so a test or second copy never talks to the wrong one. */
const STATE_FILE = `${DB_PATH}.embedder.json`;
const DOWN_FILE = `${DB_PATH}.embedder-down.json`;
export const FAILURE_LOG = `${DB_PATH}.embedder-failures.log`;
/** The failure log keeps this many last lines. */
export const FAILURE_LOG_LINES = 500;
/** The running helper records its own peak memory here (recordPeak), as what a start needs. */
const MEMORY_FILE = `${DB_PATH}.embedder-memory.json`;
/**
 * Used until the helper has recorded its own: peak working set of the server-bound helper
 * (model loaded, memories embedded) measured on this PC on 2026-10-27 was 1508 MB.
 */
export const HELPER_NEED_MB = 1500;
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
  /** The model files were downloaded again in this outage (that is done once). */
  refetched?: boolean;
  /** Still failing after the download: not restarted while the model files look like this (modelFingerprint). */
  stoppedAt?: string;
  /** Failed for lack of memory: not restarted until the user asks. Free memory then, and what the helper needs. */
  lowMemory?: { freeMb: number; needMb: number };
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

/** What the helper needs: its own last recorded peak, else the measured constant. */
export function helperNeedMb(): number {
  const n = readJson<{ needMb: number }>(MEMORY_FILE)?.needMb;
  return typeof n === 'number' && n > 0 ? n : HELPER_NEED_MB;
}

/** Free physical memory in MB; SECRETARY_FREE_MB stands in for it in tests. */
export function freeMemMb(): number {
  const v = Number(process.env.SECRETARY_FREE_MB);
  return v > 0 ? v : Math.round(os.freemem() / 2 ** 20);
}

const firstLine = (s: string) => s.split('\n')[0].slice(0, 300).replace(/\.$/, '');

/** A guess at the cause from the error text and free memory, so the log can be read without the stack. */
export function failureCause(error: string, freeMb: number): string {
  if (error.startsWith(REFETCH_FAILED)) return REFETCH_FAILED;
  if (/bad_alloc|out of memory|ENOMEM|failed to allocate|allocation failed/i.test(error)) return '메모리 부족';
  if (/onnxruntime_binding|ERR_DLOPEN_FAILED|\.dll|specified module could not be found/i.test(error)) return '실행 라이브러리 로드 실패(VC++ 재배포 패키지?)';
  if (/Could not locate file|ENOENT|no such file|not found/i.test(error)) return '모델 파일 없음';
  if (/protobuf|corrupt|invalid model|Load model .* failed|Unexpected end|JSON/i.test(error)) return '모델 파일 깨짐';
  const low = freeMb < helperNeedMb();
  if (/^비정상 종료/.test(error)) return low ? '비정상 종료(메모리 부족 의심)' : '비정상 종료';
  return low ? '원인 미상(메모리 부족 의심)' : '원인 미상';
}

const REFETCH_FAILED = '모델 다시 받기 실패';
const isModelCause = (error: string) => ['모델 파일 없음', '모델 파일 깨짐', REFETCH_FAILED].includes(failureCause(error, Infinity));
export const STOPPED_NOTE = '다시 받았는데도 실패, 사용자 확인 필요';
export const LOW_MEMORY_NOTE = '메모리 부족으로 멈춤, 사용자 확인 필요';

/** Size and time of each model file: a change means someone replaced them, worth another try. */
export function modelFingerprint(): string {
  return MODEL_FILES.map((f) => {
    try {
      const st = fs.statSync(path.join(MODEL_PATH, f));
      return `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return '-';
    }
  }).join('|');
}

/**
 * Records a real failure: the down file (so sessions are told) and a line in the failure log.
 * A model failure after the files were downloaded again, or a lack of memory, stops the restarts,
 * and every session is told anew.
 */
export function noteFailure(err: unknown, now = Date.now(), freeMb = freeMemMb()): DownState {
  const down = readDown();
  const at = new Date(now).toISOString();
  const error = firstLine(err instanceof Error ? err.message : String(err));
  const next: DownState = { ...down, since: down?.since ?? at, failedAt: at, error, failures: (down?.failures ?? 0) + 1, told: down?.told ?? [] };
  const cause = failureCause(error, freeMb);
  const stop = !!next.refetched && isModelCause(error);
  if (stop) Object.assign(next, { stoppedAt: modelFingerprint(), told: [] });
  const lowMemory = cause.includes('메모리 부족');
  next.lowMemory = lowMemory ? { freeMb, needMb: helperNeedMb() } : undefined;
  if (lowMemory) next.told = [];
  writeDown(next);
  const note = stop ? ` · ${STOPPED_NOTE}` : lowMemory ? ` · ${LOW_MEMORY_NOTE}` : '';
  logLine(now, `실패 · 연속 ${next.failures}번째 · ${cause} · 남은 메모리 ${freeMb}MB · ${error}${note}`);
  return next;
}

/** The user asked to try again: allows one more start, and one more download if the model fails. */
export function retryEmbedder(now = Date.now()): void {
  const down = readDown();
  if (!down?.stoppedAt && !down?.lowMemory) return;
  writeDown({ ...down, refetched: false, stoppedAt: undefined, lowMemory: undefined, told: [] });
  logLine(now, '사용자 요청으로 다시 시도');
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

/** Returns the helper's pid, or undefined if it could not be spawned. With refetch, it downloads the model files first. */
function startHelper(refetch: boolean): number | undefined {
  const args = [path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'embed-server', ...(refetch ? ['--refetch'] : [])];
  const child = spawn(process.execPath, args, {
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

export type HelperStatus = 'off' | 'ready' | 'loading' | 'started' | 'stopped' | 'low-memory';

/**
 * Starts the helper at once if it is gone. 'ready' carries the port; 'loading' means a
 * helper is starting or downloading the model (by this caller earlier, another caller,
 * or the server); 'stopped' means it failed even after a download, 'low-memory' that it ran
 * out of memory; both wait for the user.
 */
export function ensureHelper(now = Date.now(), start: (refetch: boolean) => number | undefined = startHelper): { status: HelperStatus; port?: number } {
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
  const down = readDown();
  if (down?.lowMemory) return { status: 'low-memory' };
  if (down?.stoppedAt) {
    if (modelFingerprint() === down.stoppedAt) return { status: 'stopped' };
    writeDown({ ...down, stoppedAt: undefined });
    logLine(now, '모델 파일이 바뀌어 다시 시도');
  }
  const refetch = !!down && !down.refetched && isModelCause(down.error);
  // The start lock: only one caller creates the state file, so prompts arriving together start one helper.
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: null }), { flag: 'wx' });
  } catch {
    return { status: 'loading' };
  }
  const pid = start(refetch);
  if (pid) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid, port: null }));
    return { status: 'started' };
  }
  fs.rmSync(STATE_FILE, { force: true });
  noteFailure('도우미 프로세스를 띄우지 못함', now);
  return { status: 'started' };
}

export const NOTICE = '의미 검색 도우미가 꺼져 있어 다시 띄우는 중이에요. 살아날 때까지 기다려 주세요(그래도 진행하면 단어 검색만 씁니다)';
export const STOPPED_NOTICE = `의미 검색 도우미가 모델 파일을 ${STOPPED_NOTE}. 다시 띄우지 않고 단어 검색만 씁니다`;

/** The ask after a lack of memory: what the helper needs (rounded up) and what is free now. */
export function lowMemoryNotice(needMb: number, freeMb: number): string {
  const need = (Math.ceil(needMb / 102.4) / 10).toFixed(1);
  const free = (freeMb / 1024).toFixed(1);
  return `메모리가 부족해 의미 검색 도우미가 꺼졌어요(도우미에 약 ${need}GB 필요, 지금 남은 메모리 약 ${free}GB). 그동안 단어 검색만 씁니다. 다시 켤까요?`;
}

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
    const text = down.lowMemory ? lowMemoryNotice(down.lowMemory.needMb, freeMemMb()) : down.stoppedAt ? STOPPED_NOTICE : NOTICE;
    return `<secretary-embedder>${text}</secretary-embedder>`;
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

let recordedMb = 0;
/** This helper's peak memory so far, kept in MEMORY_FILE as what a start needs (for the low-memory notice). */
function recordPeak(): void {
  const needMb = Math.round(process.resourceUsage().maxRSS / 1024);
  if (needMb <= recordedMb) return;
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ needMb, at: new Date().toISOString() }));
    recordedMb = needMb;
  } catch {}
}

export async function runHelper(parent?: number, refetch = false): Promise<void> {
  if (!claim(parent)) return;
  process.on('exit', release);
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
