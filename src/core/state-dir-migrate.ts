/**
 * Bringing this secretary's old records into its own folder, once. Before ids, every secretary on a PC kept its work
 * sessions and run-jobs in one shared folder (~/.claude/usage); from ids until 2026-11-09 each kept them in
 * ~/.secretary/state/<id>; now in ~/.secretary/<id>/state (core/paths.ts secretaryStateDir, scripts/lib/common.ps1
 * Get-SecretaryStateDir). The session-start hook calls ensureStateDir: the first time, the records of the folder before
 * (state/<id>, all this secretary's) and, if that folder never took them, the shared folder's lines and entries that are
 * this secretary's (its id) or no one's (written before records carried an id) are copied in, put in front of what the new
 * files already hold (a run-job may have written there first, so the order things start in does not matter), and a mark
 * file says it is done.
 * The old files stay as they are: another secretary on this PC may still read or write the shared ones (an older copy),
 * or bring in its own share later; the lines without an id may be anyone's, so each secretary takes them. The shared
 * folder's old run-job records go only after they are compared with every secretary's records (legacyRunJobCleanup).
 * Not copied: run-job-active/ (only a running run-job's file means something, and that run deletes its own old file),
 * bg-jobs/ and watch/ (scripts/lib/detached-job.ps1 Get-BgJobDir and workspace/watch-check.ts read the old places when the
 * new one has none, for the detached jobs and watchers started before).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { pidAlive } from './windows-process.ts';
import { LEGACY_USAGE_DIR, legacySecretaryStateDir, SECRETARY_HOME, secretaryStateDir, USAGE_DIR } from './paths.ts';
import { readSecretaryId } from '../setup/secretary-id.ts';

/** In the secretary's folder once its old records are in. */
export const STATE_MOVED_MARK = '.moved-from-usage';
/** The records that move: line files and keyed files. */
export const MOVED_LINES = ['run-job-calls.jsonl', 'worker-reuse.jsonl'] as const;
export const MOVED_ENTRIES = ['worker-sessions.json', 'run-job-sessions.json'] as const;
/** Another process may be moving at the same moment; a lock older than this was left by one that died. */
const LOCK_STALE_MS = 60_000;

/** A record is this secretary's when it carries its id, or no id at all. */
const ours = (j: unknown, id: string): boolean => {
  const sid = j && typeof j === 'object' ? (j as { secretary_id?: unknown }).secretary_id : undefined;
  return typeof sid !== 'string' || sid === '' || sid.toUpperCase() === id;
};

const readText = (f: string): string | null => {
  try {
    return fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
};
const readObject = (f: string): Record<string, unknown> => {
  const t = readText(f);
  if (!t?.trim()) return {};
  try {
    const j = JSON.parse(t);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
};
/** Written whole beside it and renamed over it, so a reader never sees half. */
const writeWhole = (f: string, text: string) => {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, f);
};

/**
 * run-job-sessions.json keys: "<provider>|<folder>|<model>" (before ids, and now in a secretary's own folder) or, for a
 * while, "<id>|<provider>|<folder>|<model>" in the shared file. A key with this id loses it; one with another id is not ours.
 */
function runJobKey(key: string, id: string): string | null {
  const parts = key.split('|');
  if (parts.length < 4) return key;
  return parts[0].toUpperCase() === id ? parts.slice(1).join('|') : null;
}
const atOf = (v: unknown) => Date.parse(String((v as { at?: unknown } | null)?.at ?? '')) || 0;

/** Copies this secretary's records (id) from `from` into `to`. Returns the files it wrote. */
export function copyOwnRecords(id: string, from: string, to: string): string[] {
  id = id.toUpperCase();
  const wrote: string[] = [];
  fs.mkdirSync(to, { recursive: true });
  for (const name of MOVED_LINES) {
    const old = readText(path.join(from, name));
    if (!old) continue;
    const mine = old.split(/\r?\n/).filter((l) => {
      if (!l.trim()) return false;
      try {
        return ours(JSON.parse(l), id);
      } catch {
        return false; // a line cut while being written
      }
    });
    if (!mine.length) continue;
    const now = readText(path.join(to, name)) ?? '';
    writeWhole(path.join(to, name), mine.join('\n') + '\n' + now);
    wrote.push(name);
  }
  for (const name of MOVED_ENTRIES) {
    const old = readObject(path.join(from, name));
    const taken: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(old)) {
      if (!ours(v, id)) continue;
      const key = name === 'run-job-sessions.json' ? runJobKey(k, id) : k;
      if (key === null) continue;
      if (!(key in taken) || atOf(v) > atOf(taken[key])) taken[key] = v;
    }
    if (!Object.keys(taken).length) continue;
    // What the new file already holds is newer than anything in the old one.
    const merged = { ...taken, ...readObject(path.join(to, name)) };
    writeWhole(path.join(to, name), JSON.stringify(merged, null, 2));
    wrote.push(name);
  }
  return wrote;
}

export interface StateDirs {
  root?: string;
  home?: string;
  /** The shared folder before ids (~/.claude/usage). */
  legacyUsageDir?: string;
  /** The shared folder now (~/.secretary/usage): a copy without an id keeps its records there. */
  usageDir?: string;
}

/**
 * This secretary's records folder, with its old records brought in the first time (the mark file): those of
 * ~/.secretary/state/<id> first, then, unless that folder had taken them already (its own mark), its share of
 * ~/.claude/usage (older, so in front). A copy without an id keeps using the shared folder. Never throws: a failure is
 * told on stderr and tried again next session.
 */
export function ensureStateDir(o: StateDirs = {}): string { // legacy-name: state-dir
  const root = o.root ?? PROJECT_ROOT;
  const home = o.home ?? SECRETARY_HOME;
  const legacyUsageDir = o.legacyUsageDir ?? LEGACY_USAGE_DIR;
  const usageDir = o.usageDir ?? USAGE_DIR;
  const dir = secretaryStateDir(root, home, usageDir);
  const id = readSecretaryId(root);
  if (!id || dir === usageDir) return dir;
  const mark = path.join(dir, STATE_MOVED_MARK);
  if (fs.existsSync(mark)) return dir;
  const lock = path.join(dir, `${STATE_MOVED_MARK}.lock`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
    } catch {
      // Another process is moving them; one that died long ago left its lock.
      if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return dir;
      fs.writeFileSync(lock, '');
    }
    try {
      if (fs.existsSync(mark)) return dir;
      const before = legacySecretaryStateDir(root, home);
      const from: string[] = [];
      const wrote: string[] = [];
      if (before && fs.existsSync(before)) {
        wrote.push(...copyOwnRecords(id, before, dir));
        from.push(before);
      }
      // The folder before took the shared one's records itself (its mark), so they are in already.
      if (!before || !fs.existsSync(path.join(before, STATE_MOVED_MARK))) {
        wrote.push(...copyOwnRecords(id, legacyUsageDir, dir));
        from.push(legacyUsageDir);
      }
      fs.writeFileSync(mark, `${new Date().toISOString()} ${from.join(' + ')} → ${dir}: ${[...new Set(wrote)].join(', ') || '옮길 기록 없음'}\n`, 'utf8');
    } finally {
      fs.rmSync(lock, { force: true });
    }
  } catch (e) {
    process.stderr.write(`[secretary] 비서 기록 폴더(${dir})로 옛 기록을 옮기지 못함: ${(e as Error).message}\n`);
  }
  return dir;
}

export interface CleanupItem {
  /** The file or run-job-active entry in the old shared folder. */
  file: string;
  /** Whether it can go: everything in it is in some secretary's records now (or, for run-job-active, its run ended). */
  removable: boolean;
  /** What was compared, in a line. */
  why: string;
}

/** Every secretary's records folder on this PC, now (<home>/<id>/state) and from before 2026-11-09 (<home>/state/<id>). */
export function allStateDirs(home = SECRETARY_HOME): string[] {
  const dirs: string[] = [];
  const sub = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const name of sub(home)) if (fs.existsSync(path.join(home, name, 'state'))) dirs.push(path.join(home, name, 'state'));
  for (const name of sub(path.join(home, 'state'))) dirs.push(path.join(home, 'state', name));
  return dirs;
}

/**
 * The old shared folder's run-job records (~/.claude/usage: run-job-calls.jsonl, run-job-sessions.json, run-job-active/),
 * compared with every secretary's records (allStateDirs): a line file can go when each of its lines is in some
 * secretary's file of the same name (a line cut while being written counts as nothing); run-job-sessions.json when each
 * entry's key (without its secretary id) is in some secretary's file with the same or a later time; a run-job-active
 * file when its run-job's process is gone. Only says; legacyRunJobCleanup removes.
 */
export function planLegacyRunJobCleanup(legacyUsageDir = LEGACY_USAGE_DIR, stateDirs = allStateDirs(), alive: (pid: number) => boolean = pidAlive): CleanupItem[] {
  const items: CleanupItem[] = [];
  const calls = path.join(legacyUsageDir, 'run-job-calls.jsonl');
  const old = readText(calls);
  if (old !== null) {
    const have = new Set(stateDirs.flatMap((d) => (readText(path.join(d, 'run-job-calls.jsonl')) ?? '').split(/\r?\n/).map((l) => l.trim())));
    const lines = old.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const whole = lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    const missing = whole.filter((l) => !have.has(l));
    items.push({ file: calls, removable: !missing.length, why: `줄 ${whole.length}개 중 비서 기록에 없는 줄 ${missing.length}개${lines.length > whole.length ? `, 잘린 줄 ${lines.length - whole.length}개` : ''}` });
  }
  const sessions = path.join(legacyUsageDir, 'run-job-sessions.json');
  if (fs.existsSync(sessions)) {
    const now = stateDirs.map((d) => readObject(path.join(d, 'run-job-sessions.json')));
    const entries = Object.entries(readObject(sessions));
    const missing = entries.filter(([k, v]) => {
      const parts = k.split('|');
      const key = parts.length >= 4 ? parts.slice(1).join('|') : k;
      return !now.some((m) => key in m && atOf(m[key]) >= atOf(v));
    });
    items.push({ file: sessions, removable: !missing.length, why: `항목 ${entries.length}개 중 비서 기록에 없거나 더 새로운 항목 ${missing.length}개` });
  }
  const active = path.join(legacyUsageDir, 'run-job-active');
  let names: string[] = [];
  try {
    names = fs.readdirSync(active).filter((n) => n.endsWith('.json'));
  } catch {}
  for (const n of names) {
    const file = path.join(active, n);
    const pid = Number((readObject(file) as { pid?: unknown }).pid ?? n.replace(/\.json$/, ''));
    const running = Number.isInteger(pid) && pid > 0 && alive(pid);
    items.push({ file, removable: !running, why: running ? `pid ${pid} 아직 돎` : `pid ${Number.isInteger(pid) ? pid : '?'} 끝남` });
  }
  return items;
}

/**
 * Removes what planLegacyRunJobCleanup says can go (dryRun: removes nothing), and run-job-active/ once empty. Returns the
 * plan with what was done. Not called by anything on its own: the secretary runs it once its records have moved
 * (`node -e "import('./src/core/state-dir-migrate.ts').then(m => console.log(m.legacyRunJobCleanup({ dryRun: true })))"`).
 */
export function legacyRunJobCleanup(o: { dryRun?: boolean; legacyUsageDir?: string; stateDirs?: string[]; alive?: (pid: number) => boolean } = {}): (CleanupItem & { removed: boolean })[] { // legacy-name: usage-dir
  const legacyUsageDir = o.legacyUsageDir ?? LEGACY_USAGE_DIR;
  const plan = planLegacyRunJobCleanup(legacyUsageDir, o.stateDirs ?? allStateDirs(), o.alive ?? pidAlive);
  const done = plan.map((i) => {
    if (o.dryRun || !i.removable) return { ...i, removed: false };
    try {
      fs.rmSync(i.file, { force: true });
      return { ...i, removed: true };
    } catch {
      return { ...i, removed: false };
    }
  });
  if (!o.dryRun) {
    try {
      fs.rmdirSync(path.join(legacyUsageDir, 'run-job-active'));
    } catch {}
  }
  return done;
}
