/**
 * The release's file list: `release-files.json` at the top of a general release, written by the release builder
 * (scripts/dist/dist.mjs build) with every file it ships and a hash of its content. The original has none.
 *
 * Who reads it:
 * - test/ps1-syntax.test.ts: a listed file is the secretary's own (its BOM or parse problem fails), any other is the
 *   user's (a warning). Without the list it falls back to features.json.
 * - scripts/update.mjs (release only): a file whose hash still matches the user's list was not changed by the user,
 *   even where the git tag of that version differs (it keeps its own copy of fileHash; a test compares them).
 * - the install check (setup/check-items.ts, item 'release-files'): listed files that are gone.
 * - node bin/dist.mjs check: the list matches the folder.
 *
 * The hash is SHA-256 of the content as an update compares it: a UTF-8 text without its BOM and with LF line ends
 * (editors and zip tools change those without changing the file); a binary file (one with a NUL byte) as it is.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from '../core/json-file.ts';

export const RELEASE_FILES = 'release-files.json';

export interface ReleaseFiles {
  about?: string;
  /** The release version (VERSION), e.g. v8. */
  version: string;
  /** The original's commit it was built from. */
  original?: string;
  /** Relative path (forward slashes) → fileHash of its content. */
  files: Record<string, string>;
}

export function fileHash(bytes: Buffer): string {
  const content = bytes.includes(0) ? bytes : Buffer.from(bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** root's list; null when there is none (the original) or it does not read. */
export function readReleaseFiles(root: string): ReleaseFiles | null {
  const list = readJsonFile<ReleaseFiles>(path.join(root, RELEASE_FILES));
  return list && typeof list.files === 'object' && list.files ? list : null;
}

/** Listed files not in root (the install check: a half-unpacked zip, a file removed by mistake). */
export function missingReleaseFiles(root: string, list: ReleaseFiles): string[] {
  return Object.keys(list.files).filter((p) => !fs.existsSync(path.join(root, ...p.split('/'))));
}

/** Listed files whose content differs from the list's hash: the ones the user changed. */
export function changedReleaseFiles(root: string, list: ReleaseFiles): string[] {
  return Object.entries(list.files).filter(([p, hash]) => {
    const f = path.join(root, ...p.split('/'));
    return fs.existsSync(f) && fileHash(fs.readFileSync(f)) !== hash;
  }).map(([p]) => p);
}
