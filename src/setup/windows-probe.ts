/**
 * The Windows side of the install check (setup/install-check.ts): scheduled tasks via schtasks.exe (registered, and the
 * file each one runs), processes via one PowerShell WMI query (core/process.ts), or, when the last check's processes
 * are known, one tasklist per pid.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseProcesses, processQueryArgs } from '../core/process.ts';
import type { Probe, ProbeQuery, Proc } from './install-check.ts';

/** Each probe (schtasks, PowerShell) gives up after this; its items are then "unknown". */
const PROBE_TIMEOUT_MS = 5000;

export interface Ran {
  /** Exit code; a string for a spawn error (ENOENT), null when it ran out of time. */
  code: number | string | null;
  stdout: string;
  stderr: string;
}

function exec(file: string, args: string[], verbatim = false): Promise<Ran> {
  return new Promise((resolve) => {
    try {
      const opts = { windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsVerbatimArguments: verbatim };
      execFile(file, args, opts, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({ code: e ? (e.killed ? null : (e.code ?? null)) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '' });
    }
  });
}

/** A task name no install registers: what schtasks says for it is its plain "no such task" message. */
const NO_SUCH_TASK = 'Secretary Setup Check No Such Task';
let notFoundMessage: Promise<string | null> | undefined;

/**
 * schtasks exits 0 for a registered task. Exit 1 is "no such task" but also "access denied", so it counts as missing
 * only when the message is the one a surely-absent task gets (in any language); anything else is a failed query.
 */
export function taskAnswer(run: Ran, notFound: string | null): boolean | null {
  if (run.code === 0) return true;
  if (run.code !== 1 || notFound === null) return null;
  return run.stderr.trim() === notFound ? false : null;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (xml: string, tag: string) =>
  new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]).trim();

/**
 * The file a task's (first) action runs, from `schtasks /query /xml`: the script after -File (powershell, also behind
 * conhost --headless), else the program itself when given by full path. A relative path is taken from the task's
 * working folder. null when it can't tell (a bare program name, no action): such a task is not checked further.
 */
export function taskTargetFile(xml: string): string | null {
  const command = xmlText(xml, 'Command');
  if (!command) return null;
  const args = xmlText(xml, 'Arguments') ?? '';
  const file = /(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))/i.exec(args);
  const target = file ? (file[1] ?? file[2]) : /[\\/]/.test(command) ? command.replace(/^"|"$/g, '') : null;
  if (!target) return null;
  if (path.win32.isAbsolute(target)) return target;
  const dir = xmlText(xml, 'WorkingDirectory');
  return dir ? path.win32.join(dir, target) : null;
}

/**
 * `schtasks /query /tn <name> /xml` under chcp 65001: schtasks writes in the console code page, so a Korean path in the
 * task would not survive otherwise (~0.13 s, in parallel).
 */
function queryTask(name: string): Promise<Ran> {
  if (/["%^&|<>]/.test(name)) return Promise.resolve({ code: null, stdout: '', stderr: '' });
  const cmd = process.env.ComSpec || 'cmd.exe';
  return exec(cmd, [`/d /c "chcp 65001 >nul && schtasks.exe /query /tn "${name}" /xml"`], true);
}

/** Registered or not (null: the query failed), and the file a registered task runs (null: can't tell). */
async function taskRegistered(name: string): Promise<{ registered: boolean | null; file: string | null }> {
  const run = await queryTask(name);
  if (run.code === 0) return { registered: true, file: taskTargetFile(run.stdout) };
  if (run.code !== 1) return { registered: taskAnswer(run, null), file: null };
  notFoundMessage ??= queryTask(NO_SUCH_TASK).then((r) => (r.code === 1 ? r.stderr.trim() : null));
  return { registered: taskAnswer(run, await notFoundMessage), file: null };
}

/**
 * A user environment variable's value from `reg query HKCU\Environment` output (%VARS% expanded), '' when the output
 * has no such value.
 */
export function regValue(stdout: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(EXPAND_)?SZ\s+(.*?)\s*$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) {
      return m[2] ? m[3].replace(/%([^%]+)%/g, (all, v: string) => env[v] ?? all) : m[3];
    }
  }
  return '';
}

/**
 * The variable as the user registered it (new programs get this; this process may hold an older copy or one a script
 * set). reg prints in the console code page, so it runs under chcp 65001 to keep a non-ASCII path whole (~0.1 s).
 * reg exits 1 when the value is not there.
 */
async function userEnv(name: string): Promise<string | null> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const cmd = process.env.ComSpec || 'cmd.exe';
  const { code, stdout } = await exec(cmd, [`/d /c "chcp 65001 >nul && reg query HKCU\\Environment /v ${name}"`], true);
  return code === 0 ? regValue(stdout, name) : code === 1 ? '' : null;
}

/** PowerShell's process JSON as the install check keeps it (no parent pid); null if it isn't that. */
export function parseProcs(stdout: string): Proc[] | null {
  return parseProcesses(stdout)?.map(({ pid, name, exe, cmd }) => ({ pid, name, exe, cmd })) ?? null;
}

/** One PowerShell for all processes with these image names. */
async function listProcs(images: string[]): Promise<Proc[] | null> {
  if (!images.length) return [];
  const where = images.map((n) => `Name='${n.replace(/['"]/g, '')}'`).join(' OR ');
  const { code, stdout } = await exec('powershell.exe', processQueryArgs(where));
  return code === 0 ? parseProcs(stdout) : null;
}

/** The image name tasklist's CSV ("image","pid",…) gives this pid; '' when it lists none (a localized "no tasks" line). */
export function tasklistImage(stdout: string, pid: number): string {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m && Number(m[2]) === pid) return m[1].toLowerCase();
  }
  return '';
}

/** One tasklist per pid, in parallel (~0.15 s each; listing every process takes ~0.4 s). */
async function imageOf(pid: number): Promise<string | null> {
  const { code, stdout } = await exec('tasklist.exe', ['/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`]);
  return code === 0 ? tasklistImage(stdout, pid) : null;
}

/** The known processes, if every one still runs under the same image name; else null. */
export async function confirmKnown(known: Proc[], image: (pid: number) => Promise<string | null> = imageOf): Promise<Proc[] | null> {
  const images = await Promise.all(known.map((p) => image(p.pid)));
  return known.every((p, i) => p.name && images[i] === p.name.toLowerCase()) ? known : null;
}

export async function probeWindows(q: ProbeQuery): Promise<Probe> {
  const procs = async (): Promise<{ procs: Proc[] | null; reused?: boolean }> => {
    const confirmed = q.known?.length ? await confirmKnown(q.known) : null;
    return confirmed ? { procs: confirmed, reused: true } : { procs: await listProcs(q.images) };
  };
  const names = q.env ?? [];
  const [p, values, ...registered] = await Promise.all([procs(), Promise.all(names.map(userEnv)), ...q.tasks.map(taskRegistered)]);
  return {
    tasks: Object.fromEntries(q.tasks.map((t, i) => [t, registered[i].registered])),
    taskFiles: Object.fromEntries(q.tasks.map((t, i) => [t, registered[i].file])),
    ...p,
    ...(names.length ? { env: Object.fromEntries(names.map((n, i) => [n, values[i]])) } : {}),
  };
}
