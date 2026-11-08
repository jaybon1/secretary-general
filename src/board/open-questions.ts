/**
 * The open questions the secretary asked (label + text, kept in meta), carried across secretary sessions:
 * read from each answer by the Stop hook, relabelled A, B, … for a new session. The pointers to the previous
 * session are in board-notice.ts, the running tasks in workspace/watch-check.ts.
 */
import type { Store } from '../store/store.ts';
import { startLabelsAfter } from '../guards/labels.ts';

const META_KEY = 'open_questions';
/** Questions nobody returned to within this long are dropped. */
const EXPIRE_MS = 7 * 24 * 3600 * 1000;
const QUESTION_CHARS = 400;
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

/** "A. …", "**A.** …", and with a note in brackets after the label: "T(S 다시). …", "A(옛 G, #4508). …". */
export const LABEL_LINE = /^\s*(?:[-*]\s*)?\**([A-Z]{1,2})(?:\s?\([^()\n]{1,60}\))?\.\**\s+\S/;
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
  return store.getJson<OpenState>(META_KEY) ?? { lastLogId: 0, open: [], defs: {} };
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
  store.setJson(META_KEY, { lastLogId: last.id, open, defs: kept } satisfies OpenState);
}

/**
 * After conversation rows were deleted (log/purge.ts deleteLogRows: "비서 대화 삭제" or a rewind): open questions asked in
 * them leave the list (their text came from those rows). Returns their labels; dryRun only reports.
 */
export function dropQuestionsFrom(store: Store, logIds: number[], dryRun = false): string[] {
  const state = store.getJson<OpenState>(META_KEY);
  if (!state) return [];
  const gone = new Set(logIds);
  const labels = Object.keys(state.defs).filter((l) => state.defs[l].logId !== undefined && gone.has(state.defs[l].logId!));
  const dropped = state.open.filter((l) => labels.includes(l));
  if (dryRun) return dropped;
  const defs = Object.fromEntries(Object.entries(state.defs).filter(([l]) => !labels.includes(l)));
  if (!labels.length) return dropped;
  store.setJson(META_KEY, { lastLogId: state.lastLogId, open: state.open.filter((l) => !labels.includes(l)), defs } satisfies OpenState);
  return dropped;
}

/** Open questions as "- A. …?" lines, for the board rewrite. */
export function openQuestionLines(store: Store): string[] {
  const state = readState(store);
  return state.open.map((l) => (state.defs[l] ? `- ${state.defs[l].text}` : `- ${l}. (내용 기록 없음)`));
}

/**
 * A new session relabels the carried questions A, B, … (keeping each one's asking log id and old
 * label) so labels stay short; its own new questions continue after them (with its id, the next label is counted from
 * there: guards/labels.ts).
 */
export function carryOverQuestions(store: Store, sessionId?: string): string[] {
  const state = readState(store);
  if (state.open.length === 0) return [];
  if (sessionId) startLabelsAfter(store, sessionId, state.open.length);
  const defs: Record<string, QuestionDef> = {};
  const lines: string[] = [];
  state.open.forEach((old, i) => {
    const label = labelAt(i);
    const def = state.defs[old];
    const origin = [old !== label ? `옛 ${old}` : '', def?.logId ? `#${def.logId}` : ''].filter(Boolean).join(', ');
    const body = def ? def.text.replace(/^\s*(?:[-*]\s*)?[A-Z]{1,2}(?:\s?\([^()\n]{1,60}\))?\.\s*/, '') : '(내용 기록 없음)';
    lines.push(`- ${label}${origin ? ` (${origin})` : ''}. ${body}`);
    if (def) defs[label] = { ...def, text: `${label}. ${body}`, formerly: old !== label ? [...(def.formerly ?? []), old] : def.formerly };
  });
  const open = state.open.map((_, i) => labelAt(i));
  store.setJson(META_KEY, { ...state, open, defs } satisfies OpenState);
  return [
    `남은 질문(이 세션에서 기호를 A부터 다시 붙였다. 처음 물은 대화는 search_log(log_id)로 펼친다. 이 세션의 새 질문은 ${labelAt(open.length)}부터. 첫 답 끝("다음 행동" 위)에 이 질문들을 "A(옛 G, #4508). 질문?" 꼴로 선택지까지 한 줄에 하나씩 다시 보여 준다):`,
    ...lines,
  ];
}
