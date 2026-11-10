/**
 * 의미 검색의 입구: 의미 검색 서버를 띄우고(ensureServer) 묻는 쪽(semanticClient). 장애 기록·알림은 semantic-search/outage.ts,
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
 * first caller starts it in the background (getting no semantic results that time),
 * and it exits after SECRETARY_SEMANTIC_SEARCH_IDLE_MIN minutes without requests.
 *
 * The server owns the vectors: before each search it embeds any memory that has
 * none yet, so memories saved from anywhere get picked up.
 *
 * Any caller that finds the server gone starts it again at once; the state file doubles
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

export type ServerStatus = 'off' | 'ready' | 'loading' | 'started' | 'stopped' | 'low-memory';

/**
 * Starts the server at once if it is gone. 'ready' carries the port; 'loading' means a
 * helper is starting or downloading the model (by this caller earlier, another caller,
 * or the server); 'stopped' means it failed even after a download, 'low-memory' that it ran
 * out of memory; both wait for the user.
 */
export function ensureServer(now = Date.now(), start: (refetch: boolean) => number | undefined = startServer): { status: ServerStatus; port?: number } {
  if (disabled()) return { status: 'off' };
  const state = readState();
  if (state && pidAlive(state.pid)) return state.port === null ? { status: 'loading' } : { status: 'ready', port: state.port };
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

/**
 * Client side. Returns null (callers fall back to word search) whenever the server
 * isn't ready: not running yet, still loading, down, or too slow to answer.
 */
export function semanticClient(timeoutMs: number): SemanticSearch {
  return async (query, opts) => {
    let status: ServerStatus;
    let port: number | undefined;
    try {
      ({ status, port } = ensureServer());
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
