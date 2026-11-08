/**
 * This PC's own settings files (scripts/*.local.json, never committed): read and written through here, so a test run
 * never takes this PC's values. test/env.ts sets NO_LOCAL_ENV; then the copy's own scripts/*.local.json (the one the
 * tests run from) reads as missing and cannot be written, while the same names under any other folder (a test's temp
 * copy) work as always. Eval runs (a temp copy with its own local files) do not set it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, type JsonRead } from './json-file.ts';

export const NO_LOCAL_ENV = 'SECRETARY_TEST_NO_LOCAL';

/**
 * This copy's folder, found from this file and not from core/config.ts: test/env.ts imports this module first, and
 * config.ts must load only after a test has set its own SECRETARY_DB (embedder-down.test.ts).
 */
const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Whether `file` is one of this copy's own local settings files and the test mark is set. */
export function isShieldedLocal(file: string, env = process.env, root = OWN_ROOT): boolean {
  if (!env[NO_LOCAL_ENV] || !/\.local\.json$/i.test(file)) return false;
  return path.dirname(path.resolve(file)).toLowerCase() === path.join(root, 'scripts').toLowerCase();
}

/** readJson, except that under the test mark this copy's own local file reads as missing. */
export function readLocalJson<T>(file: string): JsonRead<T> {
  if (isShieldedLocal(file)) return { ok: false, missing: true, error: 'ENOENT (시험: 이 PC 설정은 읽지 않음)' };
  return readJson<T>(file);
}

/** Writes a local settings file as UTF-8 without a BOM; refused under the test mark for this copy's own. */
export function writeLocalJson(file: string, value: unknown): void {
  if (isShieldedLocal(file)) throw new Error(`시험 중에는 이 PC 설정 파일을 쓰지 않음: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
