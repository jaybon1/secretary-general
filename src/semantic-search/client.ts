/**
 * 의미 검색의 진입점: 의미 검색 서버를 띄우고(ensureServer) 묻는 쪽(semanticClient). 장애 기록·알림은 semantic-search/outage.ts,
 * 의미 검색 서버 프로세스(모델 받기·서버)는 semantic-search/semantic-search-server.ts, 이름과 파일 위치는 semantic-search/config.ts에 있고, 바깥은 여기서만 가져다 쓴다.
 *
 * Semantic search: finds memories that mean the same thing in different words.
 *
 * The embedding model (BGE-m3-ko, ~570 MB) takes seconds to load, too slow for a hook
 * that runs as a fresh process on every prompt. So a small server process keeps it
 * loaded and callers ask it over localhost (~0.15 s).
 *
 * The secretary server (scripts/remote-server/remote-server.ps1) starts the server bound to itself:
 * it stays up as long as the server does and stops with it. Without the server, the
 * first caller on the secretary's side (allowServerStart) starts it in the background, and
 * it exits after SECRETARY_SEMANTIC_SEARCH_IDLE_MIN minutes without requests. Callers wait
 * for it (semanticClient: START_WAIT_MS to come up, SEARCH_TIMEOUT_MS to answer) rather
 * than fall back to word search at once.
 *
 * The server owns the vectors: before each search it embeds any memory that has
 * none yet, so memories saved from anywhere get picked up.
 *
 * A caller on the secretary's side that finds the server gone starts it again at once (the
 * others wait: allowServerStart); the state file doubles
 * as the start lock, so simultaneous prompts start one. A clean exit (idle, server gone)
 * removes the state file and is restarted silently. A real failure (the model would not
 * load, or a state file left behind by a crash) leaves a down file next to the database,
 * which tells each session once (outageNotice), and a line in the failure log.
 * The server deletes the down file and logs the recovery once it answers.
 *
 * When the model files are missing or broken, restarting alone cannot help: the next
 * start downloads them again from MODEL_REPO first (once per outage, inside the server
 * process that holds the start lock, so the prompt hook never waits for it). If the
 * model still fails after that, the server is no longer restarted until the user asks
 * (retryServer) or the model files change.
 *
 * A failure for lack of memory (or one that only looks like it) is not restarted at all:
 * starting again would likely fail the same way and squeeze the PC further. Each session
 * is told how much the server needs and how much is free, and asked whether to start it;
 * it waits for the user (retryServer) and stops again if memory runs out again.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { scriptPath } from '../core/paths.ts';
import { disabled, readState, STATE_FILE } from './config.ts';
import { isModelCause, logLine, modelFingerprint, noteFailure, readDown, writeDown } from './outage.ts';
import { noteAnswered, noteMiss } from './misses.ts';
import { pidAlive } from '../core/windows-process.ts';
import { CLI } from '../core/names.ts';

export {
  disabled,
  EMBED_MODEL,
  FAILURE_LOG,
  FAILURE_LOG_LINES,
  SERVER_NEED_MB,
  MODEL_FILES,
  MODEL_PATH,
  VECTOR_KEY,
} from './config.ts';
export {
  ASK_GUIDE,
  LOW_MEMORY_NOTE,
  NOTICE,
  RESTART_GUIDE,
  STOPPED_NOTE,
  STOPPED_NOTICE,
  outageNotice,
  failureCause,
  freeMemMb,
  serverNeedMb,
  lowMemoryNotice,
  modelFingerprint,
  noteFailure,
  noteRecovery,
  noticeTag,
  readDown,
  retryServer,
  type DownState,
} from './outage.ts';
export { runServer, searchWith } from './semantic-search-server.ts';
export { missLogFile, missNotice, MISS_LOG_ENV, noteMiss } from './misses.ts';

export interface SemanticHits {
  /** Median similarity over all memories searched: the baseline a real match must clear. */
  median: number;
  hits: Array<{ id: number; sim: number }>;
}

export type SemanticSearch = (query: string, opts: { includeInvalid?: boolean; limit: number }) => Promise<SemanticHits | null>;

/**
 * On Windows the server is started through PowerShell's Start-Process (ShellExecute), the way the secretary server
 * starts its own, so it inherits no handles. Node's spawn always lets a child inherit every inheritable handle of the
 * caller, even with stdio 'ignore' and detached, and a caller several processes down (run-job → claude -p → memory MCP
 * server) holds the output pipe of whoever waits for run-job. A server started there kept that pipe open for its whole
 * idle hour, so the run-job's caller never saw the output end (reproduced on a database copy 2026-11-09: the run-job
 * finished in seconds and its caller waited until the server was killed). Returns the server's pid; undefined on failure.
 */
export function startServerArgs(refetch: boolean): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const args = [scriptPath('cli'), CLI.semanticSearchServer, ...(refetch ? ['--refetch'] : [])];
  // Start-Process -ArgumentList joins the array with spaces, so each argument is quoted here (paths can have spaces).
  const command = '$p = Start-Process -FilePath $env:SECRETARY_SEMANTIC_SEARCH_SERVER_EXE -ArgumentList $env:SECRETARY_SEMANTIC_SEARCH_SERVER_ARGS -WindowStyle Hidden -PassThru; $p.Id';
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    env: {
      ...process.env,
      SECRETARY_SEMANTIC_SEARCH_SERVER_EXE: process.execPath,
      SECRETARY_SEMANTIC_SEARCH_SERVER_ARGS: args.map((a) => `"${a}"`).join(' '),
      // The server may claim the state file before this caller writes its pid (semantic-search-server.ts claim).
      SECRETARY_SEMANTIC_SEARCH_SERVER_STARTER: String(process.pid),
    },
  };
}

function startServer(refetch: boolean): number | undefined {
  if (process.platform === 'win32') {
    const { file, args, env } = startServerArgs(refetch);
    const r = spawnSync(file, args, { env, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
    const pid = Number(String(r.stdout ?? '').trim().split(/\s+/).pop());
    return r.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }
  const args = [scriptPath('cli'), CLI.semanticSearchServer, ...(refetch ? ['--refetch'] : [])];
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

export type ServerStatus = 'off' | 'ready' | 'loading' | 'started' | 'stopped' | 'low-memory' | 'absent';

/**
 * Who starts the server again (2026-11-13 the user's call): only the secretary's side — its prompt hook
 * (hooks/run-hook.ts), its own memory MCP server (not --readonly, not a staff member's: mcp/server.ts), the secretary
 * server (scripts/remote-server, --parent) and the watch script the secretary runs. A run-job's or work session's
 * read-only server, the memory consolidation and the evaluation runner (its own test database starts its own server)
 * only wait. Before this every caller started it, and a start from deep inside a run-job is what once held the run-job's
 * output pipe open (startServerArgs). Off until the process says so.
 */
let startAllowed = false;
export function allowServerStart(on = true): void {
  startAllowed = on;
}
export const serverStartAllowed = () => startAllowed;

/** How long one search waits for a server that is up (every feature but the consolidation's, which waits on its own). */
export const SEARCH_TIMEOUT_MS = 30_000;
/** How long a feature waits for a server that is gone or still loading (the secretary's side starts it at once). */
export const START_WAIT_MS = 90_000;
const START_POLL_MS = 1_000;

/**
 * Starts the server at once if it is gone. 'ready' carries the port; 'loading' means a
 * helper is starting or downloading the model (by this caller earlier, another caller,
 * or the server); 'stopped' means it failed even after a download, 'low-memory' that it ran
 * out of memory; both wait for the user.
 */
export function ensureServer(now = Date.now(), start: (refetch: boolean) => number | undefined = startServer, may = true): { status: ServerStatus; port?: number } {
  if (disabled()) return { status: 'off' };
  const state = readState();
  if (state && pidAlive(state.pid)) return state.port === null ? { status: 'loading' } : { status: 'ready', port: state.port };
  // A caller that does not start the server leaves its files to the one that does, and waits.
  if (!may) {
    const down = readDown();
    return { status: down?.lowMemory ? 'low-memory' : down?.stoppedAt && modelFingerprint() === down.stoppedAt ? 'stopped' : 'absent' };
  }
  if (state) {
    // A clean exit removes the state file; one left behind means the server died (crash, killed).
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
  // The start lock: only one caller creates the state file, so prompts arriving together start one server.
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: null }), { flag: 'wx' });
  } catch {
    return { status: 'loading' };
  }
  const pid = start(refetch);
  if (pid) {
    // Only over this caller's own placeholder: the server may already have taken the file (Windows start).
    if (readState()?.pid === process.pid) fs.writeFileSync(STATE_FILE, JSON.stringify({ pid, port: null }));
    return { status: 'started' };
  }
  if (readState()?.pid === process.pid) fs.rmSync(STATE_FILE, { force: true });
  noteFailure('의미 검색 서버 프로세스를 띄우지 못함', now);
  return { status: 'started' };
}

const firstLine = (s: string) => s.split(/\r?\n/)[0].slice(0, 120);

/** Why a status that is not 'ready' gives no semantic results, as the miss record says it. */
const STATUS_MISS: Record<Exclude<ServerStatus, 'ready' | 'off'>, string> = {
  started: '서버가 꺼져 있어 지금 띄움',
  loading: '서버가 모델을 불러오는 중',
  stopped: '서버 멈춤(모델 파일 문제, 사용자 확인 필요)',
  'low-memory': '서버 멈춤(메모리 부족, 사용자 확인 필요)',
  absent: '서버가 꺼져 있음(여기서는 띄우지 않고 비서 쪽이 띄우기를 기다림)',
};
/** Statuses that end the wait at once: only the user can bring the server back. */
const FINAL: ReadonlySet<ServerStatus> = new Set(['stopped', 'low-memory']);

/** Whether the server answers now (starting it when it is gone), without a search: the consolidation's wait polls it. */
export function semanticReady(): boolean {
  try {
    return ensureServer(Date.now(), startServer, startAllowed).status === 'ready';
  } catch {
    return false;
  }
}

export interface WaitOptions {
  /** How long to wait for a server that is gone or loading (polling; the secretary's side starts it first). 0: not at all. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Client side. Waits up to `wait.waitMs` for a server that is gone (started at once when this process may: allowServerStart)
 * or still loading, then up to `timeoutMs` for its answer. Returns null (callers fall back to word search) when it never
 * answers: stopped for the user (no wait), still not up, too slow, an error. Each such miss is recorded with `feature`, the
 * caller's name (misses.ts), and told to `onMiss`; semantic search turned off by setting is no miss.
 */
export function semanticClient(timeoutMs: number, feature: string, onMiss?: (reason: string) => void, wait: WaitOptions = {}): SemanticSearch {
  const miss = (reason: string) => {
    noteMiss(feature, reason);
    onMiss?.(reason);
    return null;
  };
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (query, opts) => {
    let status: ServerStatus;
    let port: number | undefined;
    const started = Date.now();
    for (;;) {
      try {
        ({ status, port } = ensureServer(Date.now(), startServer, startAllowed));
      } catch (err) {
        // A state file we could not write (locked, permissions): word search this time.
        return miss(`상태 파일을 못 씀(${firstLine((err as Error).message)})`);
      }
      if (status === 'off' || status === 'ready' || FINAL.has(status)) break;
      const left = (wait.waitMs ?? 0) - (Date.now() - started);
      if (left <= 0) break;
      await sleep(Math.min(wait.pollMs ?? START_POLL_MS, left));
    }
    if (status === 'off') return null;
    if (status !== 'ready') {
      const waited = Date.now() - started;
      return miss(`${STATUS_MISS[status]}${waited >= 1000 ? `, ${Math.round(waited / 1000)}초 기다림` : ''}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: 'POST',
        body: JSON.stringify({ query, ...opts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return miss(`오류(HTTP ${res.status})`);
      const hits = (await res.json()) as SemanticHits;
      noteAnswered(feature);
      return hits;
    } catch (err) {
      const e = err as Error;
      return miss(e.name === 'TimeoutError' || e.name === 'AbortError' ? `시간 초과(${timeoutMs}ms)` : `오류(${firstLine(e.message)})`);
    }
  };
}
