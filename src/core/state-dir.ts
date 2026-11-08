/**
 * Bringing this secretary's old records into its own folder, once. Before ids, every secretary on a PC kept its work
 * sessions and run-jobs in one shared folder (~/.claude/usage); now each keeps them in ~/.secretary/state/<id>
 * (core/paths.ts secretaryStateDir, scripts/lib/common.ps1 Get-SecretaryStateDir). The session-start hook calls
 * ensureStateDir: the first time, the old files' lines and entries that are this secretary's (its id) or no one's (written
 * before records carried an id) are copied in, put in front of what the new files already hold (a run-job may have
 * written there first), and a mark file says it is done.
 * The old files stay as they are: another secretary on this PC may still read or write them (an older copy), or bring in
 * its own share later; the lines without an id may be anyone's, so each secretary takes them.
 * Not copied: run-job-active/ (only a running run-job's file means something, and that run deletes its own old file),
 * bg-jobs/ and watch/ (scripts/lib/bg-job.ps1 Get-BgJobDir and workspace/watch-check.ts read the old place when the new
 * one has none, for the detached jobs and watchers started before).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { SECRETARY_HOME, secretaryStateDir, USAGE_DIR } from './paths.ts';
import { readInstallId } from '../setup/install-id.ts';

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

/**
 * This secretary's records folder, with its old records brought in the first time (the mark file). A copy without an id
 * keeps using the shared folder. Never throws: a failure is told on stderr and tried again next session.
 */
export function ensureStateDir(root = PROJECT_ROOT, home = SECRETARY_HOME, usageDir = USAGE_DIR): string {
  const dir = secretaryStateDir(root, home, usageDir);
  const id = readInstallId(root);
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
      const wrote = copyOwnRecords(id, usageDir, dir);
      fs.writeFileSync(mark, `${new Date().toISOString()} ${usageDir} → ${dir}: ${wrote.join(', ') || '옮길 기록 없음'}\n`, 'utf8');
    } finally {
      fs.rmSync(lock, { force: true });
    }
  } catch (e) {
    process.stderr.write(`[secretary] 비서 기록 폴더(${dir})로 옛 기록을 옮기지 못함: ${(e as Error).message}\n`);
  }
  return dir;
}
