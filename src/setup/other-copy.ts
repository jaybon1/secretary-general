/**
 * One PC may hold more than one secretary (a second copy, a general release next to the original). Settings outside
 * the folder are then shared: the user settings' usage hook and status line, scheduled tasks under an old name without
 * the install id, the SECRETARY_DIR variable (one per user: the secretary that set it first keeps it). Before the install check (setup/check-items.ts) or scripts/usage/install-usage-guard.mjs calls
 * such a setting this copy's "old path" and offers to point it here, it asks whose the path is:
 *
 * - inside this copy's folder → this copy's (an old layout: fix it);
 * - the nearest folder up from the path that is a secretary folder (package.json named "secretary", which every copy and
 *   release has, or an install id file) is its owner. When both folders have an install id (setup/install-id.ts), the
 *   same id → this copy's left-behind copy (this one was moved or copied from there): an old path of this copy (fix
 *   it); another id → another secretary's. Without an id on either side → another secretary's (the package.json name
 *   alone, as before). Another secretary's is left alone, even if its file is gone (that copy's own check and install
 *   scripts fix it there);
 * - no secretary folder up from it (the folder was moved or deleted) → nobody's now: an old path of this copy, which was
 *   moved here (fix it).
 *
 * scripts/tasks/install-tasks.ps1 (Get-OtherSecretary in scripts/lib/common.ps1) judges a registered task the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from '../core/json-file.ts';
import { entryPath, type EntryName } from '../core/paths.ts';
import { installIdPath, readInstallId } from './install-id.ts';

/** The package name every secretary folder carries (the original and each release). */
export const SECRETARY_PACKAGE = 'secretary';

export type Whose = 'this' | 'other' | 'old';

export interface Owner {
  whose: Whose;
  /** For 'other': the other secretary's folder (null when the path could not be read as a full path). */
  folder?: string | null;
  /** For 'old': this secretary's left-behind copy (a secretary folder elsewhere with the same install id). */
  copy?: string;
}

/** Same folder or inside it, on Windows rules (any case, either slash). */
export function within(p: string, dir: string): boolean {
  const norm = (s: string) => path.resolve(s).replace(/[\\/]+$/, '').toLowerCase();
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

export const isSecretaryFolder = (dir: string): boolean =>
  readJsonFile<{ name?: string }>(path.join(dir, 'package.json'))?.name === SECRETARY_PACKAGE || fs.existsSync(installIdPath(dir));

/** The nearest secretary folder at or above p; null when there is none (the folder is gone or holds no secretary). */
export function secretaryAbove(p: string): string | null {
  let dir = path.resolve(p);
  for (;;) {
    if (fs.existsSync(dir) && isSecretaryFolder(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Whose a path (a file a setting runs, or a folder) is, seen from the copy at root. A relative path is not judged: another's. */
export function ownerOf(p: string, root: string): Owner {
  if (!path.isAbsolute(p)) return { whose: 'other', folder: null };
  if (within(p, root)) return { whose: 'this' };
  const folder = secretaryAbove(p);
  if (!folder) return { whose: 'old' };
  // The same folder written another way (a short 8.3 name, a junction): this copy.
  const real = (s: string) => {
    try {
      return fs.realpathSync.native(s).toLowerCase();
    } catch {
      return path.resolve(s).toLowerCase();
    }
  };
  if (real(folder) === real(root)) return { whose: 'this' };
  const mine = readInstallId(root);
  if (mine && readInstallId(folder) === mine) return { whose: 'old', copy: folder };
  return { whose: 'other', folder };
}

/** %VAR%, $env:VAR and ${env:VAR} filled in from env; left as written when not set. */
export function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s
    .replace(/%([^%\s]+)%/g, (all, v: string) => env[v] ?? all)
    .replace(/\$\{env:([\w]+)\}|\$env:([\w]+)/gi, (all, a?: string, b?: string) => env[(a ?? b)!] ?? all);
}

/**
 * The path of the script `name` in a command line (quoted or not), env variables filled in; null when the command does
 * not name it. E.g. `node "C:/s/bin/usage-guard.mjs"` → C:/s/bin/usage-guard.mjs.
 */
export function scriptInCommand(cmd: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`"([^"]*?${esc})"|'([^']*?${esc})'|([^\\s"']*?${esc})(?=$|[\\s"'])`, 'i').exec(cmd);
  const found = m?.[1] ?? m?.[2] ?? m?.[3];
  return found ? expandEnv(found) : null;
}

/**
 * Whose a usage hook or status line command is: this copy's bin entry, an old path of this copy (its old layout, or a
 * folder it was moved from), another secretary's on this PC (its file there, or gone), another program's, or none.
 */
export type HookKind = { kind: 'none' | 'this' | 'old' | 'foreign' } | { kind: 'other' | 'other-gone'; folder: string };

export function hookKind(cmd: string | undefined, name: EntryName, root: string): HookKind {
  if (!cmd) return { kind: 'none' };
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  if (norm(cmd).includes(norm(entryPath(name, root)))) return { kind: 'this' };
  const file = scriptInCommand(cmd, name);
  if (!file) return { kind: 'foreign' };
  const owner = ownerOf(file, root);
  if (owner.whose !== 'other') return { kind: 'old' };
  return { kind: path.isAbsolute(file) && fs.existsSync(file) ? 'other' : 'other-gone', folder: owner.folder ?? file };
}
