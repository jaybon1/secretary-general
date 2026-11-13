/**
 * One memory consolidation run, the same way whoever starts it: the idle jobs once talk has paused (idle/idle-jobs.ts,
 * by 'idle'), or the user's /consolidate (the consolidate skill runs `node src/cli.ts memory-consolidation
 * --detach`, by 'manual'). It runs as the staff member memory-consolidation (src/staff/memory-consolidation.json:
 * model, tools, time limit; its steps in the skill's references/procedure.md) in its own empty folder
 * (workspaces/_staff/memory-consolidation), through run-job -Staff memory-consolidation. Its report waits in the DB until "기억 정리 확인"
 * (memory/consolidate-notice.ts), with the counts of what it wrote under it (memory/consolidate-tally.ts: counted by the
 * program, not the model); a line per run goes to the folder's runs-<secretary id>.jsonl.
 *
 * Only one runs at a time: the start is claimed in one DB transaction (checked and recorded together), and a record
 * whose process is gone does not hold the next one off (staff/job-record.ts).
 *
 * In the memory-consolidation feature, not the idle jobs one: with the idle jobs turned off, /consolidate still runs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertModelCallsAllowed } from '../core/no-model-calls.ts';
import { PROJECT_ROOT } from '../core/config.ts';
import { nowIso } from '../core/kst-time.ts';
import { scriptPath } from '../core/paths.ts';
import { finishJob, jobFailedWithin, jobRunning, readJob, type JobRecord } from '../staff/job-record.ts';
import { runJobScript, stripSessionLine } from '../staff/launch.ts';
import { transaction } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { fixStaffFolder, readStaff, recordStaffRun, staffInstructions, type StaffConfig } from '../staff/staff.ts';
import { saveConsolidateReport, type ConsolidateReport } from './consolidate-notice.ts';
import { readTally, startTally, tallyLine } from './consolidate-tally.ts';
import { CLI, STAFF } from '../core/names.ts';

export const CONSOLIDATE_STAFF = STAFF.memoryConsolidation;
const CONSOLIDATE_JOB_KEY = 'consolidate_job';

export type ConsolidateBy = 'idle' | 'manual';
export interface ConsolidateJob extends JobRecord {
  by?: ConsolidateBy;
}

const staff = (root = PROJECT_ROOT) => readStaff(CONSOLIDATE_STAFF, root);
/** A run may take the staff member's time limit; a record older than that (and a minute) is a dead one. */
const limitMs = (w: StaffConfig) => (w.timeoutMinutes + 1) * 60_000;

export function consolidateJob(store: Store): ConsolidateJob | undefined {
  return readJob<ConsolidateJob>(store, CONSOLIDATE_JOB_KEY);
}

export function consolidateRunning(store: Store, now = Date.now(), alive?: (pid: number) => boolean): boolean {
  return jobRunning(consolidateJob(store), limitMs(staff()), now, alive);
}

/** A run failed less than the staff member's retry wait ago (the idle tick does not hammer a broken setup). */
export function consolidateFailedRecently(store: Store, now = Date.now()): boolean {
  return jobFailedWithin(consolidateJob(store), (staff().retryAfterFailMinutes ?? 0) * 60_000, now);
}

/** The staff member's instructions (references/procedure.md of the consolidate skill). */
export function consolidatePrompt(root = PROJECT_ROOT): string {
  return staffInstructions(staff(root), root).trim();
}

/**
 * Claims the start: in one transaction, nothing running → this run's record. Returns the record, or null when another
 * run holds it (its record is in `consolidateJob`).
 */
export function claimConsolidate(store: Store, by: ConsolidateBy, pid = process.pid, alive?: (pid: number) => boolean): ConsolidateJob | null {
  const limit = limitMs(staff());
  return transaction(store.db, () => {
    if (jobRunning(consolidateJob(store), limit, Date.now(), alive)) return null;
    const job: ConsolidateJob = { startedAt: nowIso(), pid, by };
    store.setJson(CONSOLIDATE_JOB_KEY, job);
    return job;
  });
}

export interface ConsolidateRun {
  /** null: another consolidation was running, nothing started. */
  report: ConsolidateReport | null;
  running?: ConsolidateJob;
}

/** One consolidation run (claimed first), its report saved for "기억 정리 확인". */
export async function runConsolidate(
  store: Store,
  by: ConsolidateBy = 'manual',
  run: (promptFile: string, w: StaffConfig) => Promise<string> = runConsolidateJob,
): Promise<ConsolidateRun> {
  const w = staff();
  const job = claimConsolidate(store, by);
  if (!job) return { report: null, running: consolidateJob(store) };
  const fromLogId = store.consolidatedThrough();
  // What this run writes is counted by its own memory server (memory/consolidate-tally.ts) and put under its report.
  startTally(store);
  const file = path.join(os.tmpdir(), `secretary-consolidate-${process.pid}.txt`);
  let report: ConsolidateReport;
  try {
    // Its folder and role (workspaces/_staff/memory-consolidation) are made here when missing, so a new install needs no step first.
    fixStaffFolder(w);
    fs.writeFileSync(file, consolidatePrompt(), 'utf8');
    const out = stripSessionLine(await run(file, w));
    const through = store.consolidatedThrough();
    report =
      through > fromLogId
        ? { at: nowIso(), ok: true, by, text: out, fromLogId, throughLogId: through }
        : { at: nowIso(), ok: false, by, text: `정리 위치가 그대로다(#${fromLogId}). 정리 작업의 마지막 말: ${out.slice(0, 500)}`, fromLogId, throughLogId: through };
  } catch (err) {
    report = { at: nowIso(), ok: false, by, text: (err as Error).message, fromLogId, throughLogId: store.consolidatedThrough() };
  } finally {
    fs.rmSync(file, { force: true });
  }
  report.text += `\n\n${tallyLine(readTally(store))}`;
  const done = finishJob(store, CONSOLIDATE_JOB_KEY, job, report.ok, report.ok ? undefined : report.text.slice(0, 300));
  saveConsolidateReport(store, report);
  recordStaffRun(w, { at: report.at, by, ok: report.ok, fromLogId, throughLogId: report.throughLogId, ms: done.ms, pid: process.pid });
  return { report };
}

function runConsolidateJob(promptFile: string, w: StaffConfig): Promise<string> {
  return runJobScript(['-Staff', CONSOLIDATE_STAFF], promptFile, w.timeoutMinutes * 60_000);
}

/**
 * /consolidate: starts the run in a detached process (like the board rewrite) and returns at once. The child claims
 * the start itself; a run already going is told here and nothing is started.
 */
export function spawnConsolidate(store: Store): { started: boolean; pid?: number; running?: ConsolidateJob } {
  if (consolidateRunning(store)) return { started: false, running: consolidateJob(store) };
  assertModelCallsAllowed('consolidate');
  const child = spawn(process.execPath, ['--no-warnings', scriptPath('cli'), CLI.memoryConsolidation], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: PROJECT_ROOT,
  });
  child.unref();
  return { started: true, pid: child.pid };
}
