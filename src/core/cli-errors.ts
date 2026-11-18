/**
 * A cli command that fails (src/cli.ts, 2026-11-18 the user's call): the screen (stderr) gets one line,
 * `오류: <message> (<the first place in this repository, file:line>)`, and the exit code is 1; the whole trace is not
 * thrown away but added to the records folder's cli-errors.log with the time and the command. The PowerShell scripts that
 * read a cli failure take that one line (scripts/worker/worker-lib.ps1 Get-WorkerAgent: a line starting `오류: ` or, from
 * an older cli, `…Error: `).
 *
 * The log is kept small by size: past CLI_ERRORS_MAX_BYTES its oldest entries are cut so about half is left (whole
 * entries, from an entry's head). No date-based clean-up: a cli failure is rare, and the size bound covers a loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { formatLocal } from './kst-time.ts';
import { secretaryLogDir } from './paths.ts';

/** Overrides where the failures are written (tests write into their own folder). */
export const CLI_ERRORS_ENV = 'SECRETARY_CLI_ERRORS_LOG';
export const CLI_ERRORS_MAX_BYTES = 256 * 1024;
const ENTRY_HEAD = '=== ';

export const cliErrorsLog = (): string => process.env[CLI_ERRORS_ENV] || path.join(secretaryLogDir(), 'cli-errors.log');

/** The first stack frame in this repository (not node_modules, not node's own) as "<path from the root>:<line>"; null if none. */
export function firstPlace(err: unknown, root = PROJECT_ROOT): string | null {
  const stack = (err as Error | undefined)?.stack;
  if (typeof stack !== 'string') return null;
  const base = path.resolve(root).toLowerCase();
  for (const m of stack.matchAll(/(?:\(|at )((?:file:\/\/\/)?[A-Za-z]:[\\/][^():\n]+|\/[^():\n]+):(\d+):\d+\)?/g)) {
    let file = m[1].startsWith('file:///') ? decodeURIComponent(m[1].slice('file:///'.length)) : m[1];
    file = path.resolve(file);
    if (!file.toLowerCase().startsWith(base + path.sep) || /[\\/]node_modules[\\/]/.test(file)) continue;
    return `${path.relative(root, file).split(path.sep).join('/')}:${m[2]}`;
  }
  return null;
}

/** The one line the screen gets: `오류: <first line of the message> (<file:line>)`. */
export function cliErrorLine(err: unknown, root = PROJECT_ROOT): string {
  const message = (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0].trim() || '(메시지 없음)';
  const place = firstPlace(err, root);
  return `오류: ${message}${place ? ` (${place})` : ''}`;
}

/** Adds the failure (time, command, whole trace) to the log, cutting its oldest entries first when it is past the bound. */
export function noteCliError(err: unknown, argv: string[], file = cliErrorsLog(), now = new Date()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > CLI_ERRORS_MAX_BYTES) {
      const text = fs.readFileSync(file, 'utf8');
      const cut = text.indexOf(`\n${ENTRY_HEAD}`, text.length - CLI_ERRORS_MAX_BYTES / 2);
      fs.writeFileSync(file, cut >= 0 ? text.slice(cut + 1) : '');
    }
  } catch {
    // no log yet
  }
  const trace = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  fs.appendFileSync(file, `${ENTRY_HEAD}${formatLocal(now.toISOString())} (${now.toISOString()}) node src/cli.ts ${argv.join(' ')}\n${trace}\n\n`);
}
