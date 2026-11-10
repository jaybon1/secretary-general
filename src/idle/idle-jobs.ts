/**
 * The secretary's idle jobs: work done in the background once talk has paused, so no command or
 * waiting is needed. Windows Task Scheduler ('Secretary Idle Jobs (<secretary id>)',scripts/scheduled/install-scheduled-tasks.ps1 -Task idle-jobs)
 * runs `node src/cli.ts idle-jobs` every 5 minutes; it lives apart from every chat session
 * and the secretary server, so /clear, more talk or a server restart do not stop it.
 *
 *   - situation board: rewritten once talk has paused BOARD_IDLE_MS and something was said since.
 *   - memory consolidation: run once CONSOLIDATE_MIN entries are waiting and talk has paused
 *     CONSOLIDATE_IDLE_MS. The run is the staff member memory-consolidation's (memory/consolidate-run.ts, the same one /consolidate
 *     starts): its report waits in the DB; the next answer carries one line asking the user to say "기억 정리 확인", and
 *     that prompt gets the report so the secretary goes through it with the user (memory/consolidate-notice.ts).
 *
 * Each tick checks the DB only (no model) unless a job is due. A job records itself in meta while it
 * runs, so overlapping ticks (a consolidation can outlast 5 minutes) do not start it twice.
 */
import { boardBehind, boardJobRunning, runBoardUpdate } from '../session-continuity/situation-board.ts';
import { CONSOLIDATE_MARK_PREFIXES, type ConsolidateReport } from '../memory/consolidate-notice.ts';
import { consolidateFailedRecently, consolidateRunning, runConsolidate } from '../memory/consolidate-run.ts';
import { NUDGED_PREFIX as CONTEXT_NUDGED_PREFIX } from '../hooks/context-size-nudge.ts';
import { pruneIngestOffsets } from '../log/ingest-transcript.ts';
import type { Store } from '../store/store.ts';
import { lastActivityMs } from '../log/catch-up.ts';
import { GUARD_SESSION_PREFIXES } from '../mistake-guards/stop-guard.ts';

export const BOARD_IDLE_MS = 10 * 60 * 1000;
export const CONSOLIDATE_IDLE_MS = 30 * 60 * 1000;
export const CONSOLIDATE_MIN = 60;
/** "Tell this session once" marks of sessions quiet this long are dropped by the idle tick. */
const SESSION_MARK_KEEP_MS = 7 * 24 * 3600 * 1000;

export interface IdleDeps {
  now?: number;
  dirs?: string[];
  updateBoard?: (store: Store) => Promise<unknown>;
  /** null: another consolidation was running and nothing started. */
  consolidate?: (store: Store) => Promise<ConsolidateReport | null>;
}

/** One tick: runs whatever is due and says what it did (for the log and a manual run). */
export async function runIdleJobs(store: Store, deps: IdleDeps = {}): Promise<string[]> {
  const now = deps.now ?? Date.now();
  // Housekeeping, DB only: marks of long-quiet sessions and read positions of deleted transcripts.
  store.pruneSessionMeta([...CONSOLIDATE_MARK_PREFIXES, CONTEXT_NUDGED_PREFIX, ...GUARD_SESSION_PREFIXES], SESSION_MARK_KEEP_MS, now);
  pruneIngestOffsets(store);
  const idle = now - lastActivityMs(store, deps.dirs);
  const did: string[] = [];
  const idleMin = Math.floor(idle / 60_000);
  if (idle >= BOARD_IDLE_MS && boardBehind(store) && !boardJobRunning(store)) {
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
