/**
 * This PC's own settings files (this-secretary.local.json, read through core/this-secretary.ts, and the separate scripts/*.local.json
 * it was merged from; never committed): read and written through here, so a test run never takes this PC's values.
 * test/env.ts sets NO_LOCAL_ENV; then the copy's own files (the ones the
 * tests run from) read as missing and cannot be written, while the same names under any other folder (a test's temp
 * copy) work as always. Eval runs (a temp copy with its own local files) do not set it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, type JsonRead } from './json-file.ts';

export const NO_LOCAL_ENV = 'SECRETARY_TEST_NO_LOCAL';

/**
 * This copy's folder, found from this file and not from core/config.ts: test/env.ts imports this module first, and
 * config.ts must load only after a test has set its own SECRETARY_DB (semantic-search-outage.test.ts).
 */
const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Whether `file` is one of this copy's own local settings files and the test mark is set: this-secretary.local.json at the top
 * (core/this-secretary.ts) and the separate scripts/*.local.json it was made from.
 */
export function isShieldedLocal(file: string, env = process.env, root = OWN_ROOT): boolean {
  if (!env[NO_LOCAL_ENV] || !/\.local\.json$/i.test(file)) return false;
  const dir = path.dirname(path.resolve(file)).toLowerCase();
  return dir === path.join(root, 'scripts').toLowerCase() || dir === path.resolve(root).toLowerCase();
}

/** readJson, except that under the test mark this copy's own local file reads as missing. */
export function readLocalJson<T>(file: string): JsonRead<T> {
  if (isShieldedLocal(file)) return { ok: false, missing: true, error: 'ENOENT (시험: 이 PC 설정은 읽지 않음)' };
  return readJson<T>(file);
}

/** Writes a local settings file as UTF-8 without a BOM; refused under the test mark for this copy's own. */
export function writeLocalJson(file: string, value: unknown): void {
  if (isShieldedLocal(file)) throw new Error(`시험 중에는 이 비서 설정 파일을 쓰지 않음: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * This PC's own files whose names changed on 2026-11-09 (old → new, relative to the secretary folder). Never in git or a
 * release, so nothing else moves them: every cli command (src/cli.ts, hooks and the semantic-search server among them) and
 * the secretary's own MCP server do it first, before anything they run can make a new one (moveRenamedLocalFiles); the
 * session-start hook too. A release's update moves its own the same way (scripts/update.mjs LOCAL_FILE_MOVES).
 */
export const RENAMED_LOCAL_FILES: Readonly<Record<string, string>> = { // legacy-name: local-files
  'scripts/guards.local.json': 'scripts/mistake-guards.local.json',
};
/** The semantic-search server's files beside the database: <db>.embedder… → <db>.semantic-search-server… (2026-11-09). */
export const RENAMED_DB_FILES: Readonly<Record<string, string>> = { // legacy-name: local-files
  '.embedder.json': '.semantic-search-server.json',
  '.embedder-down.json': '.semantic-search-server-down.json',
  '.embedder-failures.log': '.semantic-search-server-failures.log',
  '.embedder-memory.json': '.semantic-search-server-memory.json',
};

/** Those files as [old, new] absolute paths for this copy (root) and its database (dbPath). */
function renamedPairs(root: string, dbPath: string): [string, string][] {
  return [
    ...Object.entries(RENAMED_LOCAL_FILES).map(([a, b]): [string, string] => [path.join(root, ...a.split('/')), path.join(root, ...b.split('/'))]),
    ...Object.entries(RENAMED_DB_FILES).map(([a, b]): [string, string] => [dbPath + a, dbPath + b]),
  ];
}

/**
 * Renames those files where the old one is there and the new one is not. A new one already there (made before any move
 * ran: the order above keeps that from happening) wins and the old one is left as it is, so nothing is lost; the install
 * check says so (leftoverRenamedFiles). Under the test mark this copy's own scripts files are left alone. Never throws;
 * returns what moved, "old → new".
 */
export function moveRenamedLocalFiles(root: string, dbPath: string, env = process.env): string[] {
  const moved: string[] = [];
  for (const [from, to] of renamedPairs(root, dbPath)) {
    if (isShieldedLocal(from, env, root) || !fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
      moved.push(`${from} → ${to}`);
    } catch {}
  }
  return moved;
}

/**
 * The old-name files the move left because their new one was already there (the new one is read, the old one no
 * longer): [old, new] absolute paths, for the install check (setup/check-items.ts 'renamed-local-files').
 */
export function leftoverRenamedFiles(root: string, dbPath: string, env = process.env): [string, string][] {
  return renamedPairs(root, dbPath).filter(([from, to]) => !isShieldedLocal(from, env, root) && fs.existsSync(from) && fs.existsSync(to));
}