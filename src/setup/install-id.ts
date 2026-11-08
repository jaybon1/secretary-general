/**
 * Each install of the secretary has its own short id: a few random letters in `.secretary-id` at the top of its folder,
 * made the first time it is needed (the install check at session start, scripts/tasks/install-tasks.ps1, an update)
 * and kept from then on. It is not part of any release or of git (.gitignore; the release builder, its file list and
 * the update leave it out), so an update or a moved folder keeps it.
 *
 * The id has one shape everywhere: upper case, in the file, task names, the folder variable and a workspace's
 * secretary.json (workspace/secretary-link.ts). A file written in lower case (by an earlier build) reads the same and is
 * written again in upper case the next time this copy makes sure of its id (ensureInstallId).
 *
 * What it is for:
 * - Scheduled task names end with it, e.g. 'Secretary Idle Jobs (A3F9)' (setup/features.ts scheduledTaskNames,
 *   install-tasks.ps1): two secretaries on one PC never share a task. A task under the old name without it is moved
 *   to the new name by install-tasks.ps1 when it runs this copy's files. The task scheduler compares names in any case.
 * - Telling a left-behind copy from another secretary (setup/other-copy.ts): a secretary folder elsewhere with the same
 *   id is this one's old copy (it was moved or copied from there); another id is another secretary. Without an id on
 *   either side the package.json name decides, as before.
 *
 * The PowerShell side (scripts/lib/common.ps1 Read-SecretaryId, Get-SecretaryId) reads and makes the same file the
 * same way.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INSTALL_ID_FILE = '.secretary-id';
/** Upper-case letters and digits without the look-alikes (0/O, 1/I/L). */
export const INSTALL_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INSTALL_ID_LENGTH = 4;
/** What a kept id may look like once upper-cased (a hand-written or lower-case one too). */
export const INSTALL_ID_PATTERN = /^[A-Z0-9]{4,12}$/;

export const installIdPath = (root: string) => path.join(root, INSTALL_ID_FILE);

/** What root's file holds, trimmed; null when there is none. */
function rawId(root: string): string | null {
  try {
    return fs.readFileSync(installIdPath(root), 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return null;
  }
}

/** root's id in upper case (a lower-case file reads the same); null when there is none or the file does not hold one. */
export function readInstallId(root: string): string | null {
  const id = rawId(root)?.toUpperCase();
  return id && INSTALL_ID_PATTERN.test(id) ? id : null;
}

export function newInstallId(): string {
  return Array.from({ length: INSTALL_ID_LENGTH }, () => INSTALL_ID_ALPHABET[crypto.randomInt(INSTALL_ID_ALPHABET.length)]).join('');
}

/**
 * root's id, made and written first when there is none. A file not in the one shape (lower case, a BOM, CRLF) is written
 * again as `<ID>\n`; only this copy's own folder comes here (reading another secretary's id never writes it).
 * A folder that can't be written gives null for a new id.
 */
export function ensureInstallId(root: string): { id: string | null; created: boolean } {
  const id = readInstallId(root);
  if (id) {
    try {
      if (fs.readFileSync(installIdPath(root), 'utf8') !== `${id}\n`) fs.writeFileSync(installIdPath(root), `${id}\n`);
    } catch {}
    return { id, created: false };
  }
  const made = newInstallId();
  try {
    fs.writeFileSync(installIdPath(root), `${made}\n`);
    return { id: made, created: true };
  } catch {
    return { id: null, created: false };
  }
}

/** A scheduled task's registered name: its name in features.json and the id, e.g. 'Secretary Idle Jobs (A3F9)'. */
export const taskNameWith = (base: string, id: string | null): string => (id ? `${base} (${id.toUpperCase()})` : base);
