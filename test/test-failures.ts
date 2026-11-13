/**
 * The record of failed tests (2026-11-12 decision): test/run-tests.mjs adds one line per failed test, {at, branch, commit, file,
 * name} (the branch and short commit hash the run was on: gitRevision), to
 * test-failures.jsonl in this secretary's records folder (~/.secretary/<id>/logs, src/core/paths.ts secretaryLogDir). Run in a
 * git worktree (a work copy without its own .secretary-id), it is the original work tree's id and folder (recordRoot).
 * A test that passes is not written. When the tests without a `[늘 남김]` mark are cut down (secretary-dev skill), this
 * file says which ones ever caught a failure. Nothing here may fail a test run: every error is passed over.
 *
 * This file is also the node --test reporter that run-tests.mjs adds beside the usual one (its default export): node
 * hands it every test event and writes the lines it gives to a file of that run, which run-tests.mjs then adds to the record.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FAILURES_FILE = 'test-failures.jsonl';
/** Another file for the record: test/env.ts points it into the test's own temp folder, so a test that starts run-tests.mjs (the release test) leaves this PC's record alone. */
export const FAILURES_ENV = 'SECRETARY_TEST_FAILURES_FILE';

interface TestEvent {
  type: string;
  data?: { name?: string; file?: string; details?: { type?: string; error?: { failureType?: string } } };
}

/** The record line of a failed test, null for any other event: a suite, and a test that failed only because one inside it did, are left out (the inner one is written). */
export function failureLine(event: TestEvent, root: string, now = new Date(), rev: Revision = { branch: '', commit: '' }): string | null {
  if (event.type !== 'test:fail' || !event.data) return null;
  const { name, file, details } = event.data;
  if (details?.type === 'suite' || details?.error?.failureType === 'subtestsFailed') return null;
  const rel = file ? path.relative(root, file).replaceAll('\\', '/') : '';
  return JSON.stringify({ at: now.toISOString(), branch: rev.branch, commit: rev.commit, file: rel, name: name ?? '' });
}

export interface Revision {
  branch: string;
  commit: string;
}

/** The branch and short commit hash root is on (HEAD; the run may also have changes not committed yet), '' for what git does not give (outside git, a detached HEAD's branch). */
export function gitRevision(root: string): Revision {
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  return { branch: git('branch', '--show-current'), commit: git('rev-parse', '--short', 'HEAD') };
}

export default async function* failureReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  let rev: Revision | undefined;
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    rev ??= gitRevision(process.cwd());
    const line = failureLine(event, process.cwd(), new Date(), rev);
    if (line) yield `${line}\n`;
  }
}

/**
 * The folder whose .secretary-id the record goes by: the main work tree of root's git repository (`git rev-parse
 * --git-common-dir` is its .git, also from a worktree), else root itself (no git, as in a release copy).
 */
export function recordRoot(root: string): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  const common = r.status === 0 ? r.stdout.trim() : '';
  return common && path.basename(common) === '.git' ? path.dirname(common) : root;
}

/** Where the record is: the file FAILURES_ENV names, else this secretary's records folder (the original's, from a worktree). */
export async function failuresFile(env: NodeJS.ProcessEnv = process.env, root?: string, home?: string): Promise<string> {
  if (env[FAILURES_ENV]) return env[FAILURES_ENV];
  const { PROJECT_ROOT } = await import('../src/core/config.ts');
  const { secretaryLogDir, SECRETARY_HOME } = await import('../src/core/paths.ts');
  return path.join(secretaryLogDir(recordRoot(root ?? PROJECT_ROOT), home ?? SECRETARY_HOME), FAILURES_FILE);
}

/** Adds the lines of one run (the reporter's file) to the record; how many, 0 when there were none or it could not be written. */
export function appendFailures(runFile: string, record: string): number {
  try {
    const lines = fs.readFileSync(runFile, 'utf8').split('\n').filter(Boolean);
    if (!lines.length) return 0;
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.appendFileSync(record, `${lines.join('\n')}\n`);
    return lines.length;
  } catch {
    return 0;
  }
}
