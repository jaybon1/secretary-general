/**
 * The secretary's idle jobs: work done in the background once talk has paused, so no command or
 * waiting is needed. Windows Task Scheduler ('Secretary Idle Jobs (<secretary id>)',scripts/scheduled/install-scheduled-tasks.ps1 -Task idle-jobs)
 * runs `node src/cli.ts idle-jobs` every 5 minutes; it lives apart from every chat session
 * and the secretary server, so /clear, more talk or a server restart do not stop it.
 *
 *   - situation board: rewritten once talk has paused BOARD_IDLE_MS and something was said since, or its headings
 *     renamed (no model) when the format's headings changed and nothing was said since.
 *   - memory consolidation: run once CONSOLIDATE_MIN entries are waiting and talk has paused
 *     CONSOLIDATE_IDLE_MS. The run is the staff member memory-consolidation's (memory/consolidate-run.ts, the same one /consolidate
 *     starts): its report waits in the DB; the next answer carries one line asking the user to say "기억 정리 확인", and
 *     that prompt gets the report so the secretary goes through it with the user (memory/consolidate-notice.ts).
 *
 *   - calendar: the to-do summary's events fetched every 30 minutes whether talk paused or not, when a key is set
 *     (todo-summary/calendar.ts; no model).
 *
 *   - detached jobs' records: the folders of jobs started with -Detach (bg-jobs/<id>, scripts/lib/detached-job.ps1) that
 *     ended over BG_JOB_KEEP_MS ago are deleted (2026-11-17 the user's call: nobody looked at an ended one again).
 *
 * Each tick checks the DB only (no model) unless a job is due. A job records itself in meta while it
 * runs, so overlapping ticks (a consolidation can outlast 5 minutes) do not start it twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { boardBehind, boardHeadingsStale, boardJobRunning, runBoardUpdate } from '../session-continuity/situation-board.ts';
import { CONSOLIDATE_MARK_PREFIXES, CONSOLIDATE_STEP, type ConsolidateReport } from '../memory/consolidate-notice.ts';
import { consolidateFailedRecently, consolidateRunning, runConsolidate } from '../memory/consolidate-run.ts';
import { NUDGED_PREFIX as CONTEXT_NUDGED_PREFIX } from '../hooks/context-size-nudge.ts';
import { pruneIngestOffsets } from '../log/ingest-transcript.ts';
import type { Store } from '../store/store.ts';
import { lastActivityMs } from '../log/catch-up.ts';
import { GUARD_SESSION_PREFIXES } from '../mistake-guards/stop-guard.ts';
import { calendarDue, fetchCalendar, type FetchRecord } from '../todo-summary/calendar.ts';
import { TODO_MARK_PREFIXES } from '../todo-summary/todo-summary.ts';
import { readJsonStrict } from '../core/json-file.ts';
import { pidAlive } from '../core/windows-process.ts';

export const BOARD_IDLE_MS = 10 * 60 * 1000;
export const CONSOLIDATE_IDLE_MS = 30 * 60 * 1000;
/** Entries waiting before an idle consolidation starts: the same count the /consolidate nudge steps by (consolidate-notice.ts). */
export const CONSOLIDATE_MIN = CONSOLIDATE_STEP;
/** "Tell this session once" marks of sessions quiet this long are dropped by the idle tick. */
const SESSION_MARK_KEEP_MS = 7 * 24 * 3600 * 1000;

export interface IdleDeps {
  now?: number;
  dirs?: string[];
  updateBoard?: (store: Store) => Promise<unknown>;
  /** null: another consolidation was running and nothing started. */
  consolidate?: (store: Store) => Promise<ConsolidateReport | null>;
  /** The calendar fetch, when one is due (calendarDue); 'skipped' without a key. */
  fetchCalendar?: (store: Store) => Promise<FetchRecord | 'skipped'>;
  calendarDue?: (store: Store, now: number) => boolean;
  /** The detached jobs' records folder to tidy (cli: <this secretary's state folder>/bg-jobs); none given, none tidied. */
  bgJobsRoot?: string;
}

/** An ended detached job's records are kept this long after it ended. */
export const BG_JOB_KEEP_MS = 30 * 24 * 3600 * 1000;


/** The newest change in a folder (its files, or the folder itself when empty). */
function newestMs(dir: string): number {
  let ms = fs.statSync(dir).mtimeMs;
  for (const f of fs.readdirSync(dir)) {
    try {
      ms = Math.max(ms, fs.statSync(path.join(dir, f)).mtimeMs);
    } catch {}
  }
  return ms;
}

/**
 * Deletes the records of detached jobs that ended over `keepMs` ago; returns their ids. Ended means: exit.txt is there
 * (the launch script writes it last; ended when it was written), or job.json's process is gone without one (it died;
 * ended at the folder's last change). A job without exit.txt whose process is there, or without a readable pid, is
 * never touched: it may still be running.
 */
export function pruneBgJobs(root: string, now = Date.now(), keepMs = BG_JOB_KEEP_MS, alive: (pid: number) => boolean = pidAlive): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const exit = path.join(dir, 'exit.txt');
      let ended: number;
      if (fs.existsSync(exit)) ended = fs.statSync(exit).mtimeMs;
      else {
        const pid = Number((readJsonStrict(path.join(dir, 'job.json')) as { pid?: unknown }).pid);
        if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
        ended = newestMs(dir);
      }
      if (now - ended < keepMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(e.name);
    } catch {
      // Unreadable job.json, a file in use: kept, tried again next tick.
    }
  }
  return removed;
}

/** One tick: runs whatever is due and says what it did (for the log and a manual run). */
export async function runIdleJobs(store: Store, deps: IdleDeps = {}): Promise<string[]> {
  const now = deps.now ?? Date.now();
  // Housekeeping, DB only: marks of long-quiet sessions and read positions of deleted transcripts.
  store.pruneSessionMeta([...CONSOLIDATE_MARK_PREFIXES, CONTEXT_NUDGED_PREFIX, ...GUARD_SESSION_PREFIXES, ...TODO_MARK_PREFIXES], SESSION_MARK_KEEP_MS, now);
  pruneIngestOffsets(store);
  const idle = now - lastActivityMs(store, deps.dirs);
  const did: string[] = [];
  if (deps.bgJobsRoot) {
    const gone = pruneBgJobs(deps.bgJobsRoot, now);
    if (gone.length) did.push(`bg-jobs-pruned ${gone.length}`);
  }
  // First: it takes a second or two, and the board or a consolidation below can take minutes.
  if ((deps.calendarDue ?? ((s: Store, n: number) => calendarDue(s, n)))(store, now)) {
    const r = await (deps.fetchCalendar ?? fetchCalendar)(store);
    if (r !== 'skipped') did.push(r.ok ? 'calendar' : 'calendar-failed');
  }
  const idleMin = Math.floor(idle / 60_000);
  if (idle >= BOARD_IDLE_MS && (boardBehind(store) || boardHeadingsStale(store)) && !boardJobRunning(store)) {
    await (deps.updateBoard ?? runBoardUpdate)(store);
    did.push('board');
  }
  const pending = store.stats().unconsolidated;
  if (idle >= CONSOLIDATE_IDLE_MS && pending >= CONSOLIDATE_MIN && !consolidateRunning(store, now) && !consolidateFailedRecently(store, now)) {
    const report = await (deps.consolidate ?? (async (s: Store) => (await runConsolidate(s, 'idle')).report))(store);
    did.push(report === null ? 'consolidate-already-running' : report.ok ? 'consolidate' : 'consolidate-failed');
  }
  if (did.length) store.logUsage('idle_jobs', 0, { did, idleMin, pending });
  return did.length ? did : [`할 일 없음 (대화 멈춘 지 ${idleMin}분, 정리 대기 ${pending}건)`];
}
