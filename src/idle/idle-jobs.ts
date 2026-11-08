/**
 * The secretary's idle jobs: work done in the background once talk has paused, so no command or
 * waiting is needed. Windows Task Scheduler ('Secretary Idle Jobs (<install id>)',scripts/tasks/install-tasks.ps1 -Task idle-jobs)
 * runs `node src/cli.ts secretary-idle-jobs` every 5 minutes; it lives apart from every chat session
 * and the secretary server, so /clear, more talk or a server restart do not stop it.
 *
 *   - situation board: rewritten once talk has paused BOARD_IDLE_MS and something was said since.
 *   - memory consolidation: run once CONSOLIDATE_MIN entries are waiting and talk has paused
 *     CONSOLIDATE_IDLE_MS. `claude -p` on account a (Haiku medium) follows the consolidate skill with
 *     the memory write tools (run-job -MemoryWrite, the only job allowed to write memories). Its report
 *     waits in the DB; the next answer carries one line asking the user to say "기억 정리 확인", and that
 *     prompt gets the report so the secretary goes through it with the user (memory/consolidate-notice.ts).
 *
 * Each tick checks the DB only (no model) unless a job is due. A job records itself in meta while it
 * runs, so overlapping ticks (a consolidation can outlast 5 minutes) do not start it twice.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardBehind, boardJobRunning, runBoardUpdate } from '../board/situation-board.ts';
import { skillFile } from '../core/paths.ts';
import { CONSOLIDATE_MARK_PREFIXES, saveConsolidateReport, type ConsolidateReport } from '../memory/consolidate-notice.ts';
import { NUDGED_PREFIX as CONTEXT_NUDGED_PREFIX } from '../hooks/context-size-nudge.ts';
import { pruneIngestOffsets } from '../log/ingest-transcript.ts';
import { finishJob, jobFailedWithin, jobRunning, readJob, type JobRecord } from './job-record.ts';
import { IDLE_MODEL_ARGS, runJobScript, stripSessionLine } from './run-job-launcher.ts';
import type { Store } from '../store/store.ts';
import { nowIso } from '../core/kst-time.ts';
import { lastActivityMs } from '../log/catch-up.ts';
import { GUARD_SESSION_PREFIXES } from '../guards/stop-guard.ts';

export const BOARD_IDLE_MS = 10 * 60 * 1000;
export const CONSOLIDATE_IDLE_MS = 30 * 60 * 1000;
export const CONSOLIDATE_MIN = 60;
/** A consolidation runs batch after batch until the backlog is empty; generous, then treated as dead. */
const CONSOLIDATE_TIMEOUT_MS = 45 * 60 * 1000;
/** After a failed consolidation, wait this long before trying again (do not hammer a broken setup). */
const RETRY_AFTER_FAIL_MS = 60 * 60 * 1000;
const CONSOLIDATE_JOB_KEY = 'consolidate_job';
/** "Tell this session once" marks of sessions quiet this long are dropped by the idle tick. */
const SESSION_MARK_KEEP_MS = 7 * 24 * 3600 * 1000;

export function consolidateRunning(store: Store, now = Date.now()): boolean {
  return jobRunning(readJob(store, CONSOLIDATE_JOB_KEY), CONSOLIDATE_TIMEOUT_MS + 60_000, now);
}

export interface IdleDeps {
  now?: number;
  dirs?: string[];
  updateBoard?: (store: Store) => Promise<unknown>;
  consolidate?: (store: Store) => Promise<ConsolidateReport>;
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
  if (idle >= CONSOLIDATE_IDLE_MS && pending >= CONSOLIDATE_MIN && !consolidateRunning(store, now) && !recentFailure(store, now)) {
    const report = await (deps.consolidate ?? runConsolidate)(store);
    did.push(report.ok ? 'consolidate' : 'consolidate-failed');
  }
  if (did.length) store.logUsage('idle_jobs', 0, { did, idleMin, pending });
  return did.length ? did : [`할 일 없음 (대화 멈춘 지 ${idleMin}분, 정리 대기 ${pending}건)`];
}

function recentFailure(store: Store, now: number): boolean {
  return jobFailedWithin(readJob(store, CONSOLIDATE_JOB_KEY), RETRY_AFTER_FAIL_MS, now);
}

/** The consolidate skill's steps (frontmatter removed) under a header for running unattended. */
export function consolidatePrompt(): string {
  const skill = fs.readFileSync(skillFile('consolidate'), 'utf8');
  const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  return [
    '이 일은 개인 비서의 쉬는 시간 기억 정리다. 사람이 보고 있지 않으니 묻지 말고 아래 절차를 끝까지 한다.',
    '- 도구는 secretary 기억 도구만 쓴다. 도구가 지연 로딩돼 있으면 ToolSearch로 먼저 불러온다.',
    '- 그 사이 비서도 대화 중에 기억을 저장하고 큰 일 판을 고칠 수 있다. 비슷한 기억·바뀐 줄로 거부되면 절차에 적힌 대로 처리한다.',
    '- 마지막 답은 아래 6번 형식의 보고만 쓴다(비서가 나중에 사용자와 함께 읽는다).',
    '',
    body,
  ].join('\n');
}

/** cli secretary-idle-jobs (or by hand): one consolidation run, its report saved for "기억 정리 확인". */
export async function runConsolidate(store: Store, run: (promptFile: string) => Promise<string> = runConsolidateJob): Promise<ConsolidateReport> {
  const job: JobRecord = { startedAt: nowIso(), pid: process.pid };
  store.setJson(CONSOLIDATE_JOB_KEY, job);
  const fromLogId = store.consolidatedThrough();
  const file = path.join(os.tmpdir(), `secretary-consolidate-${process.pid}.txt`);
  let report: ConsolidateReport;
  try {
    fs.writeFileSync(file, consolidatePrompt(), 'utf8');
    const out = stripSessionLine(await run(file));
    const through = store.consolidatedThrough();
    report =
      through > fromLogId
        ? { at: nowIso(), ok: true, text: out, fromLogId, throughLogId: through }
        : { at: nowIso(), ok: false, text: `정리 위치가 그대로다(#${fromLogId}). 정리 작업의 마지막 말: ${out.slice(0, 500)}`, fromLogId, throughLogId: through };
  } catch (err) {
    report = { at: nowIso(), ok: false, text: (err as Error).message, fromLogId, throughLogId: store.consolidatedThrough() };
  } finally {
    fs.rmSync(file, { force: true });
  }
  finishJob(store, CONSOLIDATE_JOB_KEY, job, report.ok, report.ok ? undefined : report.text.slice(0, 300));
  saveConsolidateReport(store, report);
  return report;
}

function runConsolidateJob(promptFile: string): Promise<string> {
  return runJobScript([...IDLE_MODEL_ARGS, '-MemoryWrite'], promptFile, CONSOLIDATE_TIMEOUT_MS);
}
