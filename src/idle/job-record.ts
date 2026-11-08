/**
 * A background job's record in meta (the board rewrite, the idle consolidation): written when it starts,
 * rewritten with done/ok/error/ms when it ends. A record still not done after its time limit belongs to a
 * job that was killed or crashed, so another may start.
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

/** Started, not done, and younger than `limitMs`. */
export function jobRunning(job: JobRecord | undefined, limitMs: number, now = Date.now()): boolean {
  return !!job && !job.done && now - Date.parse(job.startedAt) < limitMs;
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
