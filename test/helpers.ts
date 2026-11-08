// First: the test environment (temp paths for what tests start, no model calls), before core/config.ts loads.
import './env.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/store/schema.ts';
import { Store } from '../src/store/store.ts';

const made: string[] = [];
const dbs: DatabaseSync[] = [];

/** A new folder under %TEMP%, by its long path (not an 8.3 short one), removed when the test process ends. */
export function tempDir(prefix = 'secretary-test-'): string {
  return keepTidy(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
}

/** A folder the test made itself (before this file loaded), removed with the others. */
export function keepTidy(dir: string): string {
  made.push(dir);
  return dir;
}

/**
 * Deletes a test folder. Links in it (a node_modules junction to the real one) are cut first, link only, so what they
 * point at is never entered; then the folder goes. Best effort: a file still open (a database) stays.
 */
export function removeTempDir(dir: string): void {
  const cutLinks = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        try {
          fs.unlinkSync(p);
        } catch {
          try {
            fs.rmdirSync(p); // a Windows junction
          } catch {}
        }
      } else if (e.isDirectory()) cutLinks(p);
    }
  };
  cutLinks(dir);
  // Only once no link is left: rm would not follow one, but this keeps it that way whatever rm does.
  const linkLeft = (d: string): boolean =>
    fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isSymbolicLink() || (e.isDirectory() && linkLeft(path.join(d, e.name))));
  try {
    if (linkLeft(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {}
}

// Each test file's folders go when its process ends, its databases closed first (so Windows lets them go).
process.on('exit', () => {
  for (const db of dbs) {
    try {
      if (db.isOpen) db.close();
    } catch {}
  }
  for (const dir of made) removeTempDir(dir);
});

/** openDb for a test: the connection is closed when the test process ends, if the test has not closed it. */
export function testDb(file: string, upTo?: number): DatabaseSync {
  const db = upTo === undefined ? openDb(file) : openDb(file, upTo);
  dbs.push(db);
  return db;
}

/** A store on `file` (a new database in a temp folder by default), closed when the test process ends. */
export function testStore(file = path.join(tempDir(), 'test.db'), upTo?: number): Store {
  return new Store(testDb(file, upTo));
}

export const tempStore = (): Store => testStore();

let said = 0;
/** One logged message of `session`, each a moment after the one before. */
export function say(s: Store, session: string, role: 'user' | 'assistant', content: string): void {
  said++;
  s.appendLog([{ session_id: session, message_uuid: `say${said}`, role, content, created_at: new Date(Date.now() + said).toISOString() }]);
}

/** `count` user messages logged at `at`. */
export function talk(s: Store, count: number, at = Date.now()): void {
  s.appendLog(Array.from({ length: count }, () => ({ session_id: 'talk', message_uuid: `talk${said++}`, role: 'user' as const, content: '말', created_at: new Date(at).toISOString() })));
}

/** Writes a file, making its folder. */
export function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Writes each file (relative path → text) under dir. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [p, t] of Object.entries(files)) write(path.join(dir, p), t);
}

/** git in `repo` as a fixed test user, line endings kept as written. */
export const gitIn =
  (repo: string) =>
  (...args: string[]): Buffer =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args]);
