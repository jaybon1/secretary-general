/**
 * Stalled jobs, told to the secretary through a file. A tool that cut a job it found stalled appends one JSON line to
 * job-stalls.jsonl in this secretary's records folder (~/.secretary/<id>/state, core/paths.ts secretaryStateDir).
 * A tool (run-job and the like) can add its lines with its own `source`. The file outlives any one secretary session, so a stall is
 * still told when the session that started the job is gone:
 * - the work-session watcher (scripts/worker/watch-worker.ps1, `job-stall watch`) prints the lines that came while it
 *   watches, and ends (waking the secretary) when one job stalled twice in a row. It looks at the file on every check,
 *   before it looks at the session's own output, because a session that keeps writing while it waits restarts the
 *   watcher's quiet clock and a stalled external job went unnoticed for most of an hour that way;
 * - the prompt hook adds the lines no prompt was told of yet (jobStallNotice; how far it got is job-stalls.seen).
 * A job is "the same" by its key (source, job kind, its arguments, its input file names). A run that ends without
 * stalling clears the key's count (`job-stall ok`), so stalls count as in a row only with no finished run between them,
 * and a stall more than STREAK_WINDOW_MS after the last one starts again from 1.
 * Lines are added with the records' shared writer (core/json-file.ts appendJsonLine) but never cut: the watcher and the
 * prompt hook keep byte places in the file, and a stall is rare (a job cut by its tool), so the file stays small.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { secretaryStateDir } from '../core/paths.ts';
import { formatLocal } from '../core/kst-time.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';
import { appendJsonLine, readJsonStrict } from '../core/json-file.ts';
import { NOTICE, TAG } from '../core/names.ts';

/** Where the files go instead of this secretary's records folder (a test, a trial on a real device). */
export const JOB_STALLS_DIR_ENV = 'SECRETARY_JOB_STALLS_DIR';
export const STALLS_FILE = 'job-stalls.jsonl';
const STREAKS_FILE = 'job-stall-streaks.json';
const SEEN_FILE = 'job-stalls.seen';
/** A stall this long after the same job's last one counts from 1 again. */
export const STREAK_WINDOW_MS = 24 * 3600_000;
/** In a row this many times: the watcher wakes the secretary. */
export const WAKE_STREAK = 2;
/** The prompt hook shows at most this many lines (the newest); the rest are in the file. */
const NOTICE_MAX_LINES = 5;
const ARGS_MAX = 300;

export const stallsDir = (env: NodeJS.ProcessEnv = process.env): string => env[JOB_STALLS_DIR_ENV] || secretaryStateDir();

/** What a tool hands over (`job-stall record|ok --file <json>`). */
export interface StallInput {
  source: string;
  job: string;
  toolArgs?: string;
  inputs?: string[];
  device?: string;
  cwd?: string;
  /** The stage, as the tool names it ("3단계(실행)"). */
  stage?: string;
  /** What was seen, short. */
  evidence?: string;
  /** false: told but not counted (a stall after the job's result was already fetched). Default true. */
  countStreak?: boolean;
}

/** One line of job-stalls.jsonl. */
export interface StallRecord {
  at: string;
  source: string;
  job: string;
  key: string;
  stage: string;
  evidence: string;
  /** How many times in a row this job has stalled, this one included (0: not counted). */
  streak: number;
  device?: string;
  cwd?: string;
  toolArgs?: string;
  inputs?: string[];
}

/** The same job: source, kind, arguments and input file names. */
export function jobKey(i: Pick<StallInput, 'source' | 'job' | 'toolArgs' | 'inputs'>): string {
  const text = [i.source, i.job, i.toolArgs ?? '', ...(i.inputs ?? [])].join('\n');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

type Streaks = Record<string, { count: number; at: string }>;

function readStreaks(dir: string): Streaks {
  try {
    const v = readJsonStrict(path.join(dir, STREAKS_FILE)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Streaks) : {};
  } catch {
    return {};
  }
}

function writeStreaks(dir: string, s: Streaks): void {
  fs.writeFileSync(path.join(dir, STREAKS_FILE), JSON.stringify(s));
}

/** Appends a stall and returns its line (with how many times in a row this job has stalled). */
export function recordStall(input: StallInput, opts: { dir?: string; now?: number } = {}): StallRecord {
  const dir = opts.dir ?? stallsDir();
  const now = opts.now ?? Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const key = jobKey(input);
  let streak = 0;
  if (input.countStreak !== false) {
    const streaks = readStreaks(dir);
    const prev = streaks[key];
    streak = prev && now - Date.parse(prev.at) <= STREAK_WINDOW_MS ? prev.count + 1 : 1;
    streaks[key] = { count: streak, at: new Date(now).toISOString() };
    writeStreaks(dir, streaks);
  }
  const rec: StallRecord = {
    at: new Date(now).toISOString(),
    source: input.source,
    job: input.job,
    key,
    stage: input.stage ?? '',
    evidence: input.evidence ?? '',
    streak,
    ...(input.device ? { device: input.device } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.toolArgs ? { toolArgs: input.toolArgs.length > ARGS_MAX ? `${input.toolArgs.slice(0, ARGS_MAX)}…` : input.toolArgs } : {}),
    ...(input.inputs?.length ? { inputs: input.inputs } : {}),
  };
  const file = path.join(dir, STALLS_FILE);
  appendJsonLine(file, rec, { maxBytes: Infinity });
  // The tool says "recorded" only on this record's line (cli job-stall record prints it): the line is read back from the
  // file's end first, so a write that did not land throws instead of being told as recorded.
  if (!tailHasLine(file, `${JSON.stringify(rec)}\n`)) throw new Error(`${STALLS_FILE}에 쓴 줄이 파일에 없음: ${file}`);
  return rec;
}

/** Whether a whole line is in the file's last bytes (a little room for another tool's line added right after). */
function tailHasLine(file: string, line: string): boolean {
  const want = Buffer.from(line, 'utf8');
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, want.length * 4 + 64 * 1024);
    const tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
    return tail.includes(want);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The job ran to its end without stalling: its count starts again. */
export function clearStreak(input: StallInput, dir = stallsDir()): void {
  const streaks = readStreaks(dir);
  const key = jobKey(input);
  if (!(key in streaks)) return;
  delete streaks[key];
  writeStreaks(dir, streaks);
}

/** The whole lines after byte `from` (a line still being written waits), and where they end. A shorter file starts over. */
export function readStallsFrom(from: number, dir = stallsDir()): { records: StallRecord[]; offset: number } {
  const file = path.join(dir, STALLS_FILE);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { records: [], offset: 0 };
  }
  const start = from > buf.length || from < 0 ? 0 : from;
  const end = buf.lastIndexOf(0x0a) + 1;
  if (end <= start) return { records: [], offset: start };
  const records: StallRecord[] = [];
  for (const line of buf.subarray(start, end).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as StallRecord;
      if (v && typeof v === 'object' && typeof v.job === 'string') records.push(v);
    } catch {
      // A broken line is skipped; the rest are still told.
    }
  }
  return { records, offset: end };
}

/** Bytes in the file now (where a new reader starts). */
export function stallsEnd(dir = stallsDir()): number {
  try {
    return fs.statSync(path.join(dir, STALLS_FILE)).size;
  } catch {
    return 0;
  }
}

/** One line for a person: "11-17 14:03 <source> <job>(<device>) <stage> 멈춤 · 같은 작업 2번 연달아 · <evidence> · 폴더 <cwd>". */
export function formatStall(r: StallRecord): string {
  const where = [r.job + (r.device ? `(${r.device})` : ''), r.stage].filter(Boolean).join(' ');
  return [
    `${formatLocal(r.at).slice(5)} ${r.source} ${where} 멈춤`,
    r.streak >= WAKE_STREAK ? `같은 작업 ${r.streak}번 연달아` : '',
    r.evidence,
    r.cwd ? `폴더 ${r.cwd}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * For the watcher: without `from`, where the file ends now (nothing to tell); with it, the lines after it, and which of
 * them are a job that stalled WAKE_STREAK times in a row.
 */
export function watchStalls(from: number | undefined, dir = stallsDir()): { offset: number; lines: string[]; repeat: string[] } {
  if (from === undefined) return { offset: stallsEnd(dir), lines: [], repeat: [] };
  const { records, offset } = readStallsFrom(from, dir);
  return { offset, lines: records.map(formatStall), repeat: records.filter((r) => r.streak >= WAKE_STREAK).map(formatStall) };
}

/** The newest `n` lines (for a CLI with no hook wired: `job-stall list`). */
export function listStalls(n = 10, dir = stallsDir()): string[] {
  return readStallsFrom(0, dir).records.slice(-n).map(formatStall);
}

/**
 * The prompt hook's notice: the lines no prompt was told of yet, once. Where it got to is kept in job-stalls.seen beside
 * the file, so a new session (or another CLI) is told what the last one was not, and nothing twice. '' when nothing is new.
 */
export function jobStallNotice(dir = stallsDir()): string {
  const seenFile = path.join(dir, SEEN_FILE);
  if (!fs.existsSync(path.join(dir, STALLS_FILE))) return '';
  let seen = 0;
  try {
    seen = Number(fs.readFileSync(seenFile, 'utf8').trim()) || 0;
  } catch {
    // Never told: from the start.
  }
  const { records, offset } = readStallsFrom(seen, dir);
  if (offset !== seen) {
    try {
      fs.writeFileSync(seenFile, String(offset));
    } catch {
      return ''; // Not told rather than told on every question.
    }
  }
  if (!records.length) return '';
  const shown = records.slice(-NOTICE_MAX_LINES);
  const more = records.length - shown.length;
  return [
    `<${TAG.jobStall}>${hookNoticeText(NOTICE.jobStall, 'notice')}`,
    ...shown.map((r) => `- ${formatStall(r)}`),
    ...(more ? [`(앞의 ${more}줄은 ${path.join(dir, STALLS_FILE)}에)`] : []),
    `</${TAG.jobStall}>`,
  ].join('\n');
}
