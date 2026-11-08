/**
 * 의미 검색의 입구: 도우미를 띄우고(ensureHelper) 묻는 쪽(semanticClient). 장애 기록·알림은 semantic/outage.ts,
 * 도우미 프로세스(모델 받기·서버)는 semantic/helper-server.ts, 이름과 파일 위치는 semantic/config.ts에 있고, 바깥은 여기서만 가져다 쓴다.
 *
 * Semantic search: finds memories that mean the same thing in different words.
 *
 * The embedding model (BGE-m3-ko, ~570 MB) takes seconds to load, too slow for a hook
 * that runs as a fresh process on every prompt. So a small helper process keeps it
 * loaded and callers ask it over localhost (~0.15 s).
 *
 * The secretary server (scripts/server/remote-server.ps1) starts the helper bound to itself:
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
import fs from 'node:fs';
import { scriptPath } from '../core/paths.ts';
import { disabled, readState, STATE_FILE } from './config.ts';
import { isModelCause, logLine, modelFingerprint, noteFailure, readDown, writeDown } from './outage.ts';
import { pidAlive } from '../core/process.ts';

export {
  EMBED_MODEL,
  FAILURE_LOG,
  FAILURE_LOG_LINES,
  HELPER_NEED_MB,
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
  embedderNotice,
  failureCause,
  freeMemMb,
  helperNeedMb,
  lowMemoryNotice,
  modelFingerprint,
  noteFailure,
  noteRecovery,
  noticeTag,
  readDown,
  retryEmbedder,
  type DownState,
} from './outage.ts';
export { runHelper, searchWith } from './helper-server.ts';

export interface SemanticHits {
  /** Median similarity over all memories searched: the baseline a real match must clear. */
  median: number;
  hits: Array<{ id: number; sim: number }>;
}

export type SemanticSearch = (query: string, opts: { includeInvalid?: boolean; limit: number }) => Promise<SemanticHits | null>;

/** Returns the helper's pid, or undefined if it could not be spawned. With refetch, it downloads the model files first. */
function startHelper(refetch: boolean): number | undefined {
  const args = [scriptPath('cli'), 'embed-server', ...(refetch ? ['--refetch'] : [])];
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
  if (state && pidAlive(state.pid)) return state.port === null ? { status: 'loading' } : { status: 'ready', port: state.port };
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
