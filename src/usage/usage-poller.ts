/**
 * The usage reader (feature 'usage-poll'): every 5 minutes, for each provider checked in the usage settings
 * (usage-settings.ts: the usage-poll section of this-secretary.local.json, which the dashboard's /settings page writes) whose usage can be read,
 * runs scripts/usage/usage-query.ps1 -Provider <name> (no tokens), which writes the provider's usage file in ~/.secretary/usage
 * (usage/usage-files.ts usageKey): subscription-<account>.json for a Claude subscription whose login can be read (the account,
 * not the provider's name, names it), else <name>.json.
 * One at a time (a small PC), and a round still going makes the next one wait its turn.
 *
 *   node src/cli.ts usage-poll [--parent <PID>]
 *
 * The secretary server (scripts/remote-server/remote-server.ps1, account a) starts it with --parent: it ends when that window
 * does, ends at once when the feature is off in features.json, and when another reader runs on this PC (one lock file
 * in ~/.secretary/usage, as every secretary on the PC shares the usage files, one per account). It writes no log file.
 *
 * The usage guard (scripts/usage/usage-guard.mjs) still refreshes a record older than 5 minutes on its own, as a
 * backup when this is off. Both leave a .refresh mark named like the usage file (subscription-<account>.refresh or
 * <name>.refresh) with the start time in milliseconds: the guard starts
 * nothing for 5 minutes after one, and this skips a provider whose reading started under BUSY_MS ago (the guard's,
 * still running), so the same provider is never read twice at once.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { NO_MODEL_ENV } from '../core/no-model-calls.ts';
import { scriptPath, USAGE_DIR } from '../core/paths.ts';
import { pidAlive } from '../core/windows-process.ts';
import { featureOn, readFeatures } from '../setup/features.ts';
import { FEATURE } from '../core/names.ts';
import { failureWait, readFailure, recordFailure, refreshFile } from './usage-files.ts';
import { readProviders } from './provider-usage.ts';
import { readUsageChoice } from './usage-settings.ts';

export const FEATURE_ID = FEATURE.usagePoll;

export const POLL_MS = 5 * 60_000;
/** A reading that started this recently is taken as still running (usage-query.ps1 gives up on one account after 90 s). */
export const BUSY_MS = 150_000;
const FIRST_MS = 15_000;

export interface PollerDeps {
  /** The providers to read this round (checked and readable), asked each round so a saved choice counts at once. */
  names: () => string[];
  /** Reads one provider; resolves when its file is written (or the reading gave up). */
  run: (name: string) => Promise<unknown>;
  usageDir?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/** The provider's refresh mark, named like its usage file (subscription-<account>.refresh, usage/usage-files.ts refreshFile). */
export const refreshMark = (name: string, usageDir = USAGE_DIR) => refreshFile(name, usageDir);

export class UsagePoller {
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly d: PollerDeps;

  constructor(d: PollerDeps) {
    this.d = d;
  }

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  /** Whether someone (the usage guard, or a round of this) started reading it under BUSY_MS ago. */
  busy(name: string): boolean {
    try {
      const at = Number(fs.readFileSync(refreshMark(name, this.d.usageDir), 'utf8'));
      const age = this.now - at;
      return Number.isFinite(at) && age >= 0 && age < BUSY_MS;
    } catch {
      return false;
    }
  }

  private mark(name: string): void {
    const file = refreshMark(name, this.d.usageDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(this.now));
  }

  /**
   * One round; the names it read. A round still going when the next is due: the next one does nothing. A provider whose
   * readings keep failing (an API key login, whose /usage gives no usage; no claude) waits longer each time
   * (usage/usage-files.ts failureWait) instead of being tried every 5 minutes for ever.
   */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const read: string[] = [];
    try {
      for (const name of this.d.names()) {
        if (this.busy(name) || failureWait(name, this.d.usageDir, this.now) > 0) continue;
        const started = this.now;
        try {
          this.mark(name);
          await this.d.run(name);
          read.push(name);
        } catch (e) {
          const why = (e as Error).message.split('\n')[0].slice(0, 200);
          this.d.log?.(`사용량 조회 실패(${name}): ${why}`);
          // usage-query.ps1 writes the failure itself when it gets that far; one that failed before (did not start, crashed) is written here.
          const f = readFailure(name, this.d.usageDir);
          if (!f || Date.parse(f.at) < started - 1000) {
            try {
              recordFailure(name, why, this.d.usageDir, this.now);
            } catch {}
          }
        }
      }
    } finally {
      this.running = false;
    }
    return read;
  }

  start(intervalMs = POLL_MS, firstMs = FIRST_MS): void {
    const go = () => void this.tick();
    this.timers.push(setTimeout(go, firstMs), setInterval(go, intervalMs));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

/** Whether the feature is on in this copy's features.json (on without the file, like every feature). */
export function pollOn(root = PROJECT_ROOT): boolean {
  const f = (readFeatures(root) ?? []).find((x) => x.id === FEATURE_ID);
  return !f || featureOn(f);
}

/**
 * The one-reader-per-PC lock: the reader's PID. Only here: every secretary on this PC (account b's server too) runs from
 * a copy that reads it, so no reader takes the old ~/.claude/usage/usage-poll.pid any more (taken there too until 2026-11-10).
 */
export const lockFile = (usageDir = USAGE_DIR) => path.join(usageDir, 'usage-poll.pid');

/** Takes the lock; false while a live process holds it. A lock left by a reader that died is taken over. */
export function claimLock(file: string, pid = process.pid, alive: (pid: number) => boolean = pidAlive): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let other = NaN;
      try {
        other = Number(fs.readFileSync(file, 'utf8').trim());
      } catch {}
      if (other > 0 && other !== pid && alive(other)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

/** Lets the lock go, if it is still this process's. */
export function releaseLock(file: string, pid = process.pid): void {
  try {
    if (Number(fs.readFileSync(file, 'utf8').trim()) === pid) fs.rmSync(file, { force: true });
  } catch {}
}

/** The providers to read this round: checked in the usage settings and readable. */
export function checkedReadable(root = PROJECT_ROOT): string[] {
  const list = readProviders(root);
  const checked = new Set(readUsageChoice(list, root).checked);
  return list.filter((p) => p.usage !== 'none' && checked.has(p.name)).map((p) => p.name);
}

/**
 * node src/cli.ts usage-poll [--parent <PID>]: 'off' (the feature is off), 'running' (another reader holds the lock,
 * or the parent is gone), else it starts reading and keeps the process alive ('started').
 */
export function runUsagePoll(parent?: number, o: { root?: string; usageDir?: string } = {}): 'off' | 'running' | 'started' {
  const root = o.root ?? PROJECT_ROOT;
  if (!pollOn(root)) return 'off';
  if (parent && !pidAlive(parent)) return 'running';
  const lock = lockFile(o.usageDir);
  if (!claimLock(lock)) return 'running';
  process.on('exit', () => releaseLock(lock));
  if (parent) {
    setInterval(() => {
      if (!pidAlive(parent)) process.exit(0);
    }, 5000);
  }
  new UsagePoller({
    names: () => checkedReadable(root),
    run: (name) => runUsageScript(name, root),
    usageDir: o.usageDir,
    log: (line) => console.error(`사용량 조회: ${line}`),
  }).start();
  // The timers are unref'd (a test may start one); this one keeps the reader alive.
  setInterval(() => {}, 1 << 30);
  return 'started';
}

/** The real reading: usage-query.ps1 for one provider, without a window, at most 3 minutes. Never in tests (the no-model mark). */
export function runUsageScript(name: string, root = PROJECT_ROOT): Promise<void> {
  if (process.env[NO_MODEL_ENV]) return Promise.reject(new Error('시험 중에는 사용량을 실제로 조회하지 않음'));
  return new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('usageQuery', root), '-Provider', name],
      { timeout: 180_000, windowsHide: true, maxBuffer: 1 << 20 },
      (e, out) => {
        if (e) return reject(e);
        if (/사용량을 읽지 못했어요|시간 초과|조회 안 됨|없는 공급자/.test(out)) return reject(new Error(out.trim().split('\n')[0]));
        resolve();
      },
    ),
  );
}
