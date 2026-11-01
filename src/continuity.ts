/**
 * Carries a conversation across secretary sessions: the open questions the secretary asked
 * (label + text, kept in meta) and a short pointer to the previous session for new sessions.
 */
import type { Store } from './store.ts';
import { formatLocal } from './text.ts';

const META_KEY = 'open_questions';
/** Questions nobody returned to within this long are dropped. */
const EXPIRE_MS = 7 * 24 * 3600 * 1000;
const QUESTION_CHARS = 400;
const LAST_USER_LINES = 3;
const LAST_USER_CHARS = 100;
const LAST_MEMORY_IDS = 15;
const LAST_REPLY_TAIL_CHARS = 300;

interface QuestionDef {
  text: string;
  session: string;
  at: string;
  /** Log id of the message that asked it: the question's lasting id across relabels. */
  logId?: number;
  /** Labels it had in earlier sessions, oldest first. */
  formerly?: string[];
}
interface OpenState {
  lastLogId: number;
  open: string[];
  defs: Record<string, QuestionDef>;
}

const LABEL_LINE = /^\s*(?:[-*]\s*)?\**([A-Z]{1,2})\.\**\s+\S/;
const REMAINING_LINE = /^\s*\**남은 질문\**\s*[:：](.*)$/m;

/** A=0 … Z=25, AA=26 … */
export function labelIndex(label: string): number {
  return label.length === 1 ? label.charCodeAt(0) - 65 : (label.charCodeAt(0) - 64) * 26 + label.charCodeAt(1) - 65;
}
export function labelAt(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
}

/** Labeled questions ("A. …?" plus its option lines) defined in one assistant message. */
export function parseQuestions(text: string): Record<string, string> {
  const lines = text.split('\n');
  const found: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = LABEL_LINE.exec(lines[i]);
    if (!m) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && lines[j].trim() && !LABEL_LINE.test(lines[j]) && !REMAINING_LINE.test(lines[j]); j++) block.push(lines[j]);
    const joined = block.map((l) => l.trim()).join(' ').replace(/\*\*/g, '');
    if (joined.includes('?')) found[m[1]] = joined.slice(0, QUESTION_CHARS);
  }
  return found;
}

/** Labels on the "남은 질문:" line; null when there is no such line, [] for "없음". */
export function parseRemaining(text: string): string[] | null {
  const m = REMAINING_LINE.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/(?<![A-Za-z])([A-Z]{1,2})(?![A-Za-z])/g)].map((x) => x[1]);
}

/** Labels the user picked an option for ("c1", "A2 B1"); a bare "e - …" is discussion, not an answer. */
export function parseAnswers(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z])([A-Za-z]{1,2})(\d{1,2})(?![\dA-Za-z])/g)].map((x) => x[1].toUpperCase());
}

function readState(store: Store): OpenState {
  const raw = store.getMeta(META_KEY);
  return raw ? (JSON.parse(raw) as OpenState) : { lastLogId: 0, open: [], defs: {} };
}

/** Stop hook: fold the session's latest assistant message into the open-question list. */
export function updateOpenQuestions(store: Store, sessionId: string): void {
  const [last] = store.sessionTail(sessionId, 1, 'assistant');
  const state = readState(store);
  if (!last || last.id <= state.lastLogId) return;
  const defs = parseQuestions(last.content);
  const remaining = parseRemaining(last.content);
  const newLabels = Object.keys(defs);
  let open = state.open;
  if (remaining) open = [...new Set([...remaining, ...newLabels])];
  else {
    // The secretary forgot the remaining line: close what the user answered by label since the last reply.
    const answered = new Set(store.sessionBetween(sessionId, state.lastLogId, last.id, 'user').flatMap((u) => parseAnswers(u.content)));
    open = [...new Set([...state.open.filter((l) => !answered.has(l)), ...newLabels])];
  }
  for (const [label, text] of Object.entries(defs)) state.defs[label] = { text, session: sessionId, at: last.created_at, logId: last.id };
  const cutoff = Date.now() - EXPIRE_MS;
  open = open.filter((l) => !state.defs[l] || Date.parse(state.defs[l].at) >= cutoff);
  const kept: Record<string, QuestionDef> = {};
  for (const l of open) if (state.defs[l]) kept[l] = state.defs[l];
  store.setMeta(META_KEY, JSON.stringify({ lastLogId: last.id, open, defs: kept } satisfies OpenState));
}

/** Open questions as "- A. …?" lines, for the board rewrite. */
export function openQuestionLines(store: Store): string[] {
  const state = readState(store);
  return state.open.map((l) => (state.defs[l] ? `- ${state.defs[l].text}` : `- ${l}. (내용 기록 없음)`));
}

/**
 * A new session relabels the carried questions A, B, … (keeping each one's asking log id and old
 * label) so labels stay short; its own new questions continue after them.
 */
export function carryOverQuestions(store: Store): string[] {
  const state = readState(store);
  if (state.open.length === 0) return [];
  const defs: Record<string, QuestionDef> = {};
  const lines: string[] = [];
  state.open.forEach((old, i) => {
    const label = labelAt(i);
    const def = state.defs[old];
    const origin = [old !== label ? `옛 ${old}` : '', def?.logId ? `#${def.logId}` : ''].filter(Boolean).join(', ');
    const body = def ? def.text.replace(/^[A-Z]{1,2}\.\s*/, '') : '(내용 기록 없음)';
    lines.push(`- ${label}${origin ? ` (${origin})` : ''}. ${body}`);
    if (def) defs[label] = { ...def, text: `${label}. ${body}`, formerly: old !== label ? [...(def.formerly ?? []), old] : def.formerly };
  });
  const open = state.open.map((_, i) => labelAt(i));
  store.setMeta(META_KEY, JSON.stringify({ ...state, open, defs } satisfies OpenState));
  return [`남은 질문(이 세션에서 기호를 A부터 다시 붙였다. 처음 물은 대화는 search_log(log_id)로 펼친다. 이 세션의 새 질문은 ${labelAt(open.length)}부터):`, ...lines];
}

function clipLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}
function clipTail(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(-n) : flat;
}

/** How many running tasks a new session is told about (there are rarely more than a few). */
const RUNNING_TASKS_MAX = 20;

/**
 * Tasks still marked running: a new session (or /clear) does not know the old session's watchers,
 * which die with it, so it is told which background sessions to watch again. [] when none run.
 */
export function runningTaskLines(store: Store): string[] {
  const tasks = store.listTasks({ status: 'running', limit: RUNNING_TASKS_MAX });
  if (tasks.length === 0) return [];
  return [
    '돌고 있는 업무(기억 DB status running, 이 세션은 그 감시를 모른다. <id>는 bg: 뒤 글자):',
    ...tasks.map((t) => `- 업무 ${t.id} "${t.title}" · ${t.session_ref ?? 'session_ref 없음'}`),
    '첫 답에서 scripts/watch-worker.ps1 -Id <id>를 백그라운드 명령(시간제한 7200000ms)으로 다시 띄운다.',
  ];
}

/** New session (or /clear): where the last conversation left off, as pointers to expand; relabels open questions. */
export function continuityContext(store: Store, currentSessionId?: string): string {
  const prev = store.lastOtherSession(currentSessionId);
  const state = readState(store);
  const running = runningTaskLines(store);
  if (!prev && state.open.length === 0 && running.length === 0) return '';
  const lines = ['<secretary-continuity>'];
  if (prev) {
    const sid = prev.session_id.slice(0, 8);
    lines.push(`직전 세션 ${sid} (마지막 대화 ${formatLocal(prev.last_at)}). 사용자의 마지막 말:`);
    for (const u of store.sessionTail(prev.session_id, LAST_USER_LINES, 'user')) lines.push(`- "${clipLine(u.content, LAST_USER_CHARS)}"`);
    // The secretary's closing words usually say what it asked the user to do next.
    const [reply] = store.sessionTail(prev.session_id, 1, 'assistant');
    if (reply) lines.push(`비서의 마지막 답 끝: "…${clipTail(reply.content, LAST_REPLY_TAIL_CHARS)}"`);
    const ids = store.sessionMemoryIds(prev.session_id).slice(-LAST_MEMORY_IDS);
    if (ids.length) lines.push(`그 세션에서 저장한 기억: ${ids.map((i) => `#${i}`).join(' ')}`);
    lines.push(
      `사용자가 이어지는 이야기를 하면 짐작하지 말고 search_log(session_id="${sid}")로 그 세션의 최근 대화를, recall(ids)로 기억을 펼쳐 확인한다.`,
    );
  }
  lines.push(...carryOverQuestions(store));
  lines.push(...running);
  lines.push('</secretary-continuity>');
  return lines.join('\n');
}
