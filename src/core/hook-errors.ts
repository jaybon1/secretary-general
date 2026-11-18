/**
 * What a hook could not do, kept where it can be found: a hook never stops the conversation for its own failure (it
 * exits 0, and Claude Code shows no stderr of a hook that exits 0), so before this record a failed hook left no trace and
 * the secretary read a missing memory injection as "no memory on this". Each failure is one line in this secretary's
 * records folder (~/.secretary/<id>/logs/hook-errors.jsonl, core/paths.ts secretaryLogDir): when, which hook, which of
 * its parts, the error's first line and the top of its stack.
 *
 * Written by the three hooks' entry (src/cli.ts hook), by the prompt hook for each notice that failed while the others
 * still went out (hooks/prompt-notices.ts), and by the tool hooks (mistake-guards/pre-tool-hook.ts, repeat-hook.ts), which
 * import only this small file. The secretary is told with one short tag line; the words of what to do are in
 * .agents/hook-notices/hook-error.md:
 * - on the spot, when the session-start or prompt hook lost a notice (hookErrorNotice);
 * - on the session's next prompt, when its Stop hook failed (the Stop hook has nowhere to say it; stopFailureNotice), once;
 * - at session start, how many failures came since the last such line and which repeat (hookErrorSummary), once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hookNoticeText, type NoticeMarks } from './hook-notice-text.ts';
import { appendJsonLine, readJsonFile } from './json-file.ts';
import { formatLocal } from './kst-time.ts';
import { TAG } from './names.ts';
import { secretaryLogDir } from './paths.ts';

export const HOOK_ERRORS_NAME = 'hook-errors.jsonl';
/** Overrides where the failures are written (tests write into their own folder). */
export const HOOK_ERRORS_ENV = 'SECRETARY_HOOK_ERRORS_LOG';
const STACK_LINES = 6;
export const HOOK_ERROR_NOTICE = 'hook-error';
/** Beside the record: Stop hook failures not told yet, by session. */
const STOP_PENDING_NAME = 'hook-errors.stop-pending.json';
/** In the database's meta: the newest failure the session-start summary has told (store.markOnce). */
export const HOOK_ERRORS_TOLD_KEY = 'hook_errors_told';
/** A Stop hook failure not told within this long is dropped (the session-start summary still counts it). */
const STOP_PENDING_MAX_MS = 3 * 24 * 3600_000;
/**
 * The same failure (hook, part, error line) this many times within REPEAT_WINDOW_MS counts as repeating: once is a
 * hiccup (a locked file, a killed process), three times in a week has a cause worth finding.
 */
export const REPEAT_COUNT = 3;
export const REPEAT_WINDOW_MS = 7 * 24 * 3600_000;
/** The summary names at most this many repeating failures. */
const REPEAT_SHOWN = 3;

export function hookErrorsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env[HOOK_ERRORS_ENV] || path.join(secretaryLogDir(), HOOK_ERRORS_NAME);
}

const besideRecord = (name: string) => path.join(path.dirname(hookErrorsFile()), name);

export interface HookErrorLine {
  at: string;
  local: string;
  /** session-start, prompt, stop, pre-tool, repeat. */
  hook: string;
  /** The part of the hook that failed (a prompt notice's name), when only a part did. */
  part?: string;
  error: string;
  stack?: string;
  cwd: string;
  /** The Claude Code session the hook ran for, when known. */
  session?: string;
}

/** The error's first line ("TypeError: …"). */
export function errorLine(err: unknown): string {
  const e = err as Error;
  const text = e && typeof e === 'object' && 'message' in e ? `${e.name ?? 'Error'}: ${e.message}` : String(err);
  return text.split('\n')[0].slice(0, 500);
}

interface StopPending {
  at: string;
  /** The whole hook failed (the turn may not have been logged). */
  whole: boolean;
  /** The parts that failed while the rest went on. */
  parts: string[];
  error: string;
}

/** One failure: a line in the record. Best effort: a failed write must cost the hook nothing more. */
export function noteHookError(hook: string, err: unknown, part?: string, opts: { now?: number; session?: string } = {}): void {
  const now = opts.now ?? Date.now();
  const stack = (err as Error)?.stack?.split('\n').slice(1, STACK_LINES + 1).map((l) => l.trim()).join(' | ');
  const line: HookErrorLine = {
    at: new Date(now).toISOString(),
    local: formatLocal(now, false, true),
    hook,
    ...(part ? { part } : {}),
    error: errorLine(err),
    ...(stack ? { stack } : {}),
    cwd: process.cwd(),
    ...(opts.session ? { session: opts.session } : {}),
  };
  try {
    appendJsonLine(hookErrorsFile(), line);
  } catch {}
  if (hook === 'stop') noteStopPending(line, now);
}

/** A Stop hook failure kept for the session's next prompt (a session not known: whichever session asks next). */
function noteStopPending(line: HookErrorLine, now: number): void {
  try {
    const file = besideRecord(STOP_PENDING_NAME);
    const all = readJsonFile<Record<string, StopPending>>(file) ?? {};
    for (const [k, v] of Object.entries(all)) if (now - Date.parse(v.at) > STOP_PENDING_MAX_MS) delete all[k];
    const key = line.session ?? '';
    const prev = all[key];
    all[key] = {
      at: line.at,
      whole: (prev?.whole ?? false) || !line.part,
      parts: [...new Set([...(prev?.parts ?? []), ...(line.part ? [line.part] : [])])],
      error: line.part ? (prev?.error ?? line.error) : line.error,
    };
    fs.writeFileSync(file, JSON.stringify(all));
  } catch {}
}

/**
 * The tag line telling the secretary what is missing from this prompt or session start: `what` says which hook or which
 * notices failed; the words of what to do come from .agents/hook-notices/hook-error.md, with the record's path.
 */
export function hookErrorNotice(what: string, key = 'todo'): string {
  const todo = hookNoticeText(HOOK_ERROR_NOTICE, key).replaceAll('{log}', hookErrorsFile());
  return `<${TAG.hookError}>${what}${todo ? ` — ${todo}` : ''}</${TAG.hookError}>`;
}

/**
 * For the prompt hook: this session's Stop hook failed after its last prompt (or a Stop hook whose session was not known
 * did), told once; '' when none. A whole failure may have left the turn unlogged; a part's failure left the turn logged.
 */
export function stopFailureNotice(sessionId: string | undefined): string {
  const file = besideRecord(STOP_PENDING_NAME);
  if (!fs.existsSync(file)) return '';
  const all = readJsonFile<Record<string, StopPending>>(file) ?? {};
  const keys = [sessionId ?? '', ''].filter((k, i, a) => a.indexOf(k) === i && all[k]);
  if (!keys.length) return '';
  const told = keys.map((k) => all[k]);
  for (const k of keys) delete all[k];
  try {
    if (Object.keys(all).length) fs.writeFileSync(file, JSON.stringify(all));
    else fs.rmSync(file, { force: true });
  } catch {
    return ''; // Not told rather than told on every question.
  }
  const whole = told.find((t) => t.whole);
  const parts = [...new Set(told.flatMap((t) => t.parts))];
  const last = told.map((t) => t.at).sort().at(-1)!;
  const what = [
    `직전 턴(${formatLocal(last)})의 Stop 훅이 실패했어요`,
    whole ? `: 전체(${whole.error}), 그 턴 대화가 저장되지 않았을 수 있음` : '',
    parts.length ? `${whole ? ' · ' : ': '}일부(${parts.join(', ')})` : '',
  ].join('');
  return hookErrorNotice(what, 'stop');
}

/** "prompt·memory-core" or "stop". */
const where = (l: HookErrorLine) => (l.part ? `${l.hook}·${l.part}` : l.hook);

function readLines(file: string): HookErrorLine[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: HookErrorLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as HookErrorLine;
      if (v && typeof v.at === 'string' && typeof v.hook === 'string') out.push(v);
    } catch {
      // A broken line is skipped.
    }
  }
  return out;
}

/**
 * For the session-start hook: the failures recorded since the last such line (the first time, the last REPEAT_WINDOW_MS),
 * counted by hook and part with the last time, and the ones that repeat (REPEAT_COUNT times within REPEAT_WINDOW_MS),
 * told once; '' when none came.
 */
export function hookErrorSummary(store: NoticeMarks, now = Date.now()): string {
  const file = hookErrorsFile();
  if (!fs.existsSync(file)) return '';
  const through = store.getMeta(HOOK_ERRORS_TOLD_KEY) ?? new Date(now - REPEAT_WINDOW_MS).toISOString();
  const lines = readLines(file);
  const fresh = lines.filter((l) => l.at > through);
  if (!fresh.length) return '';
  // Another session start that told these a moment ago wins (ISO times compare as text).
  const newest = fresh.map((l) => l.at).sort().at(-1)!;
  if (!store.markOnce(HOOK_ERRORS_TOLD_KEY, newest, (told) => told >= newest)) return '';
  const byWhere = new Map<string, number>();
  for (const l of fresh) byWhere.set(where(l), (byWhere.get(where(l)) ?? 0) + 1);
  const counts = [...byWhere].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}건`);
  // Repeating: the same failure REPEAT_COUNT times in the window, one of them new.
  const key = (l: HookErrorLine) => `${where(l)}\n${l.error}`;
  const since = new Date(now - REPEAT_WINDOW_MS).toISOString();
  const inWindow = new Map<string, number>();
  for (const l of lines) if (l.at > since) inWindow.set(key(l), (inWindow.get(key(l)) ?? 0) + 1);
  const repeats = [...new Set(fresh.map(key))]
    .map((k) => [k, inWindow.get(k) ?? 0] as const)
    .filter(([, n]) => n >= REPEAT_COUNT)
    .sort((a, b) => b[1] - a[1]);
  const last = fresh.map((l) => l.at).sort().at(-1)!;
  const head = `지난번 알린 뒤 훅 실패 ${fresh.length}건(${counts.join(', ')}) · 마지막 ${formatLocal(last)}`;
  if (!repeats.length) return hookErrorNotice(head, 'summary');
  const shown = repeats.slice(0, REPEAT_SHOWN).map(([k, n]) => {
    const [w, error] = k.split('\n');
    return `${w} "${error.slice(0, 120)}" ${n}번`;
  });
  return hookErrorNotice(`${head} · 되풀이(${Math.round(REPEAT_WINDOW_MS / 86_400_000)}일에 ${REPEAT_COUNT}번 이상): ${shown.join(', ')}`, 'repeat');
}
