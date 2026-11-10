/**
 * A background job's record in meta (the board rewrite, the consolidation): written when it starts, rewritten with
 * done/ok/error/ms when it ends. A record still not done after its time limit belongs to a job that was killed or
 * crashed, so another may start; so does one whose process (pid, when recorded) is gone (2026-11-09: a dead
 * consolidation held the next one off for 46 minutes).
 */
import type { Store } from '../store/store.ts';

export interface JobRecord {
  startedAt: string;
  pid?: number;
  done?: boolean;
  ok?: boolean;
  error?: string;
  ms?: number;
}

export function readJob<T extends JobRecord>(store: Store, key: string): T | undefined {
  return store.getJson<T>(key);
}

/** Whether a process with this id is there (one that is there but not ours to signal counts too). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Started, not done, younger than `limitMs`, and its process (when recorded) still there. */
export function jobRunning(job: JobRecord | undefined, limitMs: number, now = Date.now(), alive: (pid: number) => boolean = processAlive): boolean {
  if (!job || job.done || now - Date.parse(job.startedAt) >= limitMs) return false;
  return typeof job.pid === 'number' ? alive(job.pid) : true;
}

/** Ended in failure and started less than `withinMs` ago. */
export function jobFailedWithin(job: JobRecord | undefined, withinMs: number, now = Date.now()): boolean {
  return !!job?.done && !job.ok && now - Date.parse(job.startedAt) < withinMs;
}

/** Saves the ended record (ms counted from startedAt) and returns it. */
export function finishJob<T extends JobRecord>(store: Store, key: string, job: T, ok: boolean, error?: string, extra: Partial<T> = {}): T {
  const done = { ...job, done: true, ok, error, ms: Date.now() - Date.parse(job.startedAt), ...extra };
  store.setJson(key, done);
  return done;
}
