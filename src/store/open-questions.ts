/**
 * The open questions the secretary asked (label + text, kept in meta), carried across secretary sessions:
 * read from each answer by the Stop hook, relabelled A, B, … for a new session. The pointers to the previous
 * session are in situation-board-notice.ts, the running tasks in workspace/watch-check.ts.
 *
 * Also the question labels per session (once their own file): the next free label is counted here so the secretary never
 * has to. A new session (or /clear, which starts one) begins after the open questions it carried over, relabelled A, B, …
 * (carryOverQuestions); a compaction keeps the session, so labels go on where they were. The Stop hook reads the
 * "X. …?" question lines (also "X(note). …?") of each turn's text; the prompt hook says the next label, after every
 * label the session asked with.
 */
import type { Store } from './store.ts';
import { atomic } from './schema.ts';
import { TAG } from '../core/names.ts';

const META_KEY = 'open_questions';
/** Questions nobody returned to within this long are dropped. */
const EXPIRE_MS = 7 * 24 * 3600 * 1000;
interface QuestionDef {
  text: string;
  session: string;
  at: string;
  /** Log id of the message that asked it: the question's lasting id across relabels. */
  logId?: number;
  /** Labels it had in earlier sessions, oldest first. */
  formerly?: string[];
  /** Its short name as the closing step last gave it ("AA(할 일 고치는 기억 도구)"): the to-do summary shows it. */
  name?: string;
}
/**
 * Why a question left the open list (fix C12 of the 2026-11-13 source review, after gbrain's open loops that close "by
 * state transition, never delete" and stamp who closed them): the user answered it by label (`answered`, evidence: the
 * user's row), the secretary's closing list left it out (`not-in-list`, evidence: the secretary's answer), nobody came
 * back to it for EXPIRE_MS (`expired`), or the talk that asked it was deleted (`purged`).
 */
export type CloseReason = 'answered' | 'not-in-list' | 'expired' | 'purged';
export interface ClosedQuestion {
  at: string;
  reason: CloseReason;
  /** The log row that closed it (the user's answer, or the secretary's answer without it). */
  evidence?: number;
  /** The row that asked it. */
  logId?: number;
  /** Labels it had in earlier sessions. */
  formerly?: string[];
}
interface OpenState {
  lastLogId: number;
  open: string[];
  defs: Record<string, QuestionDef>;
  /** Questions closed within EXPIRE_MS, by the label they had then, with why and the row that shows it. */
  closed?: Record<string, ClosedQuestion>;
}

/** Closed records kept after the questions closed (one week like the open ones), older ones dropped. */
function keepClosed(closed: Record<string, ClosedQuestion> | undefined, open: string[], cutoff: number): Record<string, ClosedQuestion> {
  // A label asked again is open, not closed.
  return Object.fromEntries(Object.entries(closed ?? {}).filter(([l, c]) => !open.includes(l) && Date.parse(c.at) >= cutoff));
}

/** "A. …", "**A.** …", and with a note in brackets after the label: "T(S 다시). …", "A(옛 G, #1234). …". */
export const LABEL_LINE = /^\s*(?:[-*]\s*)?\**([A-Z]{1,2})(?:\s?\([^()\n]{1,60}\))?\.\**\s+\S/;
/**
 * Where the answer lists its unanswered labels: a step of the closing "다음 행동 및 순서:" list, "N. 남은 질문에 답해
 * 주세요: A(알림 시각), B(…)". Once all are settled the step is left out and nothing else is written (2026-11-12, the
 * user's call): a closing list without the step closes them (NEXT_ACTION_LINE). Still read: the line of its own used
 * before, "남은 질문: A(…), B" and "남은 질문: 없음", since a session that loaded the earlier rules keeps writing it until
 * it restarts. Not "남은 질문에서 뺀 것: …" (a purge result relayed). Also the step written on the closing list's own
 * line, "다음 행동 및 순서: 남은 질문에 답해 주세요: AN(옛 형식)" (once read as a list without the step, and an open question was dropped).
 */
const REMAINING_LINE = /^\s*(?:[-*]\s*)?(?:\**다음 행동 및 순서\**\s*[:：]\**\s*)?(?:\**\d{1,2}[.)]\**\s*)?\**남은 질문(?:에\s*답해\s*주세요)?\**\s*[:：](.*)$/m;

/** The closing list's head, "다음 행동 및 순서:" (also "다음 행동 및 순서: 없음" on one line, bold or as a heading). */
const NEXT_ACTION_LINE = /^\s*(?:#{1,6}\s*)?\**다음 행동 및 순서\**\s*[:：]/m;

/** A=0 … Z=25, AA=26 … */
export function labelIndex(label: string): number {
  return label.length === 1 ? label.charCodeAt(0) - 65 : (label.charCodeAt(0) - 64) * 26 + label.charCodeAt(1) - 65;
}
export function labelAt(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
}

/**
 * Labeled questions defined in one assistant message: the "A. …?" line and the lines under it up to a blank line (its
 * "> 비서 판단:" line, options and basis lines), joined, whole. The block ends at the blank line, so its length is the
 * one paragraph's: no cap, so the carried question keeps every option.
 */
export function parseQuestions(text: string): Record<string, string> {
  const lines = text.split('\n');
  const found: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = LABEL_LINE.exec(lines[i]);
    if (!m) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && lines[j].trim() && !LABEL_LINE.test(lines[j]) && !REMAINING_LINE.test(lines[j]); j++) block.push(lines[j]);
    const joined = block.map((l) => l.trim()).join(' ').replace(/\*\*/g, '');
    if (joined.includes('?')) found[m[1]] = joined;
  }
  return found;
}

/**
 * Labels on the remaining-questions line (REMAINING_LINE: the closing step "N. 남은 질문에 답해 주세요: …" or the old
 * "남은 질문: …" line); null when there is no such line, [] for "없음". The list is "A(알림 시각), B(…)":
 * the notes in brackets are left out and each item gives the label at its front (after a "보류:"-like prefix), so a
 * capital word in a note ("F(새PC UAC 단계)") or in an item's words is not taken for a label.
 */
export function parseRemaining(text: string): string[] | null {
  const m = REMAINING_LINE.exec(text);
  if (!m) return null;
  let line = m[1];
  // Innermost brackets first, so a note with brackets inside goes whole.
  for (let prev = ''; prev !== line; ) [prev, line] = [line, line.replace(/[(（][^()（）]*[)）]/g, ' ')];
  const labels: string[] = [];
  for (const item of line.split(/[,，、·;]/)) {
    const x = /^\**([A-Z]{1,2})\**(?![A-Za-z0-9])/.exec(item.trim().replace(/^[^A-Z:：]*[:：]\s*/, '').replace(/^[\s*]+/, ''));
    if (x) labels.push(x[1]);
  }
  return labels;
}

/**
 * The short names the remaining-questions line gives its labels: "AA(할 일 고치는 기억 도구), AB" → { AA: '할 일 고치는 기억
 * 도구' }. A label without a note in brackets has none. Commas inside a note ("A(옛 G, #1234)") stay in it.
 */
export function parseRemainingNames(text: string): Record<string, string> {
  const m = REMAINING_LINE.exec(text);
  if (!m) return {};
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[1]) {
    if (ch === '(' || ch === '（') depth++;
    else if ((ch === ')' || ch === '）') && depth > 0) depth--;
    if (depth === 0 && /[,，、·;]/.test(ch)) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  const names: Record<string, string> = {};
  for (const item of items) {
    const x = /^\**([A-Z]{1,2})\**\s*[(（](.+)[)）]\**\s*$/.exec(item.trim().replace(/^[^A-Z:：(（]*[:：]\s*/, '').replace(/^[\s*]+/, ''));
    // Not the carried label's origin ("A(옛 G, #1234)"), which says where it came from, not what it asks.
    if (x && x[2].trim() && !/^옛\s*[A-Z]{1,2}\s*(?:[,，]\s*#\d+)?$|^#\d+$/.test(x[2].trim())) names[x[1]] = x[2].trim();
  }
  return names;
}

/** Labels the user picked an option for ("c1", "A2 B1"); a bare "e - …" is discussion, not an answer. */
export function parseAnswers(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z])([A-Za-z]{1,2})(\d{1,2})(?![\dA-Za-z])/g)].map((x) => x[1].toUpperCase());
}

function readState(store: Store): OpenState {
  return store.getJson<OpenState>(META_KEY) ?? { lastLogId: 0, open: [], defs: {} };
}

/**
 * Stop hook: fold the session's latest assistant message into the open-question list (`now`: the evaluation set replays old talk).
 * Read and written in one transaction: two Stop hooks at once (two secretaries, a session and its handoff) would each
 * read the old list and the later write would drop the other's new labels.
 */
export function updateOpenQuestions(store: Store, sessionId: string, now = Date.now()): void {
  atomic(store.db, () => updateInTx(store, sessionId, now));
}

function updateInTx(store: Store, sessionId: string, now: number): void {
  const [last] = store.sessionTail(sessionId, 1, 'assistant');
  const state = readState(store);
  if (!last || last.id <= state.lastLogId) return;
  const defs = parseQuestions(last.content);
  const remaining = parseRemaining(last.content);
  const newLabels = Object.keys(defs);
  // Which user row answered which label since the last reply (the latest answer wins): the closed record's evidence.
  const answeredAt = new Map<string, number>();
  for (const u of store.sessionBetween(sessionId, state.lastLogId, last.id, 'user')) for (const l of parseAnswers(u.content)) answeredAt.set(l, u.id);
  let open = state.open;
  if (remaining) open = [...new Set([...remaining, ...newLabels])];
  // A closing list without the remaining step: everything asked before is settled (questions asked in this answer stay).
  else if (NEXT_ACTION_LINE.test(last.content)) open = newLabels;
  else {
    // No closing list (a short explanation, say): the list stays, less what the user answered by label since the last reply.
    open = [...new Set([...state.open.filter((l) => !answeredAt.has(l)), ...newLabels])];
  }
  const closed = { ...state.closed };
  const close = (l: string, reason: CloseReason, evidence?: number) => {
    const def = state.defs[l];
    // Expiry happens now (`now`: the evaluation set replays old talk); the others when this answer was given.
    closed[l] = { at: reason === 'expired' ? new Date(now).toISOString() : last.created_at, reason, ...(evidence ? { evidence } : {}), ...(def?.logId ? { logId: def.logId } : {}), ...(def?.formerly?.length ? { formerly: def.formerly } : {}) };
  };
  for (const l of state.open) {
    // Still open, and not a label asked anew in this answer (which makes it another question: the old one closed here).
    if (open.includes(l) && !newLabels.includes(l)) continue;
    if (answeredAt.has(l)) close(l, 'answered', answeredAt.get(l));
    else close(l, 'not-in-list', last.id);
  }
  for (const [label, text] of Object.entries(defs)) state.defs[label] = { text, session: sessionId, at: last.created_at, logId: last.id };
  // The closing step's names for its labels (asked now or before): the latest one is kept.
  for (const [label, name] of Object.entries(parseRemainingNames(last.content))) if (state.defs[label]) state.defs[label] = { ...state.defs[label], name };
  const cutoff = now - EXPIRE_MS;
  for (const l of open) if (state.defs[l] && Date.parse(state.defs[l].at) < cutoff) close(l, 'expired');
  open = open.filter((l) => !state.defs[l] || Date.parse(state.defs[l].at) >= cutoff);
  const kept: Record<string, QuestionDef> = {};
  for (const l of open) if (state.defs[l]) kept[l] = state.defs[l];
  store.setJson(META_KEY, { lastLogId: last.id, open, defs: kept, closed: keepClosed(closed, open, cutoff) } satisfies OpenState);
}

/**
 * After conversation rows were deleted (log/purge.ts deleteLogRows: "비서 대화 삭제" or a rewind): open questions asked in
 * them leave the list (their text came from those rows). Returns their labels; dryRun only reports.
 */
export function dropQuestionsFrom(store: Store, logIds: number[], dryRun = false): string[] {
  return atomic(store.db, () => dropInTx(store, logIds, dryRun));
}

function dropInTx(store: Store, logIds: number[], dryRun: boolean): string[] {
  const state = store.getJson<OpenState>(META_KEY);
  if (!state) return [];
  const gone = new Set(logIds);
  const labels = Object.keys(state.defs).filter((l) => state.defs[l].logId !== undefined && gone.has(state.defs[l].logId!));
  const dropped = state.open.filter((l) => labels.includes(l));
  if (dryRun) return dropped;
  const defs = Object.fromEntries(Object.entries(state.defs).filter(([l]) => !labels.includes(l)));
  if (!labels.length) return dropped;
  const closed = { ...state.closed };
  const at = new Date().toISOString();
  for (const l of dropped) closed[l] = { at, reason: 'purged', ...(state.defs[l]?.formerly?.length ? { formerly: state.defs[l].formerly } : {}) };
  store.setJson(META_KEY, { lastLogId: state.lastLogId, open: state.open.filter((l) => !labels.includes(l)), defs, closed } satisfies OpenState);
  return dropped;
}

/** What the open-question list knows now: whether a label (or the row that asked) is still open (todo-summary/conditions.ts). */
export interface QuestionKeys {
  /** The open labels with the labels they had in earlier sessions. */
  labels: Set<string>;
  /** Questions closed in the last EXPIRE_MS, by the label they had when closed and by their earlier labels. */
  closed: Map<string, ClosedQuestion>;
  /** How many questions are open now. */
  openCount: number;
  /** The log rows that asked the open questions (a question's lasting id across relabels). */
  askedAt: Set<number>;
  /** Questions closed in the last EXPIRE_MS, by the log row that asked them (one row may ask several), each with its label when closed. */
  closedByAsked: Map<number, Array<ClosedQuestion & { label: string }>>;
  /** The open questions' labels (with their earlier ones), by the log row that asked them. */
  openByAsked: Map<number, string[]>;
}

/**
 * Undefined when there is no list yet (a new install): then nothing can be said about a line. Closed records are pruned
 * when the Stop hook folds an answer in (updateOpenQuestions, with the time the talk was given), not here.
 */
export function openQuestionKeys(store: Store): QuestionKeys | undefined {
  const state = store.getJson<OpenState>(META_KEY);
  if (!state) return undefined;
  const labels = new Set<string>();
  const askedAt = new Set<number>();
  const openByAsked = new Map<number, string[]>();
  for (const l of state.open) {
    labels.add(l);
    const def = state.defs[l];
    if (def?.logId) {
      askedAt.add(def.logId);
      openByAsked.set(def.logId, [...(openByAsked.get(def.logId) ?? []), l, ...(def.formerly ?? [])]);
    }
    for (const old of def?.formerly ?? []) labels.add(old);
  }
  const closed = new Map<string, ClosedQuestion>();
  const closedByAsked = new Map<number, Array<ClosedQuestion & { label: string }>>();
  for (const [l, c] of Object.entries(keepClosed(state.closed, state.open, -Infinity))) {
    // The label it had when closed counts over an earlier label another question may have had.
    for (const old of c.formerly ?? []) if (!closed.has(old)) closed.set(old, c);
    closed.set(l, c);
    if (c.logId) closedByAsked.set(c.logId, [...(closedByAsked.get(c.logId) ?? []), { ...c, label: l }]);
  }
  return { labels, closed, openCount: state.open.length, askedAt, closedByAsked, openByAsked };
}

/**
 * A "question answered" condition kept by the row that asked the question (the user's call, 2026-11-18): a label
 * ("B") is relabelled in the next session and may then name another question, the asking row never changes. A label the
 * open list knows (open now, or closed lately, by its label then or an earlier one) becomes "<row>:<label>" (one row may
 * ask several); one it does not know stays as given. Other conditions come back as they are.
 */
export function resolveQuestionCondition<C extends { kind: string; value: string }>(store: Store, c: C): C {
  if (c.kind !== 'question_answered' || /^\d+/.test(c.value)) return c;
  const state = store.getJson<OpenState>(META_KEY);
  const label = c.value.toUpperCase();
  const open = state && (state.open.find((l) => l === label) ?? state.open.find((l) => state.defs[l]?.formerly?.includes(label)));
  if (open && state!.defs[open]?.logId) return { ...c, value: `${state!.defs[open].logId}:${open}` };
  const keys = openQuestionKeys(store);
  const closed = keys?.closed.get(label);
  const at = closed?.logId && keys!.closedByAsked.get(closed.logId)?.find((r) => r.label === label || r.formerly?.includes(label));
  return closed?.logId ? { ...c, value: `${closed.logId}:${at ? at.label : label}` } : c;
}

/**
 * Whether the user answered the question a condition names (undefined: the list cannot tell). "<row>:<label>" (or a
 * bare row id, every question it asked): answered by label, not just gone from the list (expired, left out of the
 * closing list, deleted are no answer). A bare label the list does not know any more: by its closed record, if kept.
 */
export function questionAnswered(store: Store, value: string): boolean | undefined {
  const keys = openQuestionKeys(store);
  if (!keys) return undefined;
  const m = /^(\d+)(?::([A-Z]{1,2}))?$/.exec(value);
  if (!m) return keys.labels.has(value) ? false : keys.closed.get(value)?.reason === 'answered';
  const row = Number(m[1]);
  const named = (labels: string[]) => !m[2] || labels.includes(m[2]);
  if ((keys.openByAsked.get(row) ?? []).some((l) => named([l]))) return false;
  const closed = (keys.closedByAsked.get(row) ?? []).filter((r) => named([r.label, ...(r.formerly ?? [])]));
  return closed.length > 0 && closed.every((r) => r.reason === 'answered');
}

/** Open questions with the text after their label and their short name, if the closing step gave one (the to-do summary, todo-summary/todo-summary.ts). */
export function openQuestionItems(store: Store): Array<{ label: string; text: string; name?: string }> {
  const state = readState(store);
  return state.open.map((l) => ({ label: l, name: state.defs[l]?.name, text: (state.defs[l]?.text ?? '').replace(/^\s*(?:[-*]\s*)?[A-Z]{1,2}(?:\s?\([^()\n]{1,60}\))?\.\s*/, '') }));
}

/** Open questions as "- A. …?" lines, for the board rewrite. */
export function openQuestionLines(store: Store): string[] {
  const state = readState(store);
  return state.open.map((l) => (state.defs[l] ? `- ${state.defs[l].text}` : `- ${l}. (내용 기록 없음)`));
}

/**
 * A new session relabels the carried questions A, B, … (keeping each one's asking log id and old
 * label) so labels stay short; its own new questions continue after them (with its id, the next label is counted from
 * there: nextLabel below). After a compaction (keepLabels) the session goes on and its labels with it: the
 * questions are listed as they are, nothing relabelled (relabelling would give A, B … again to labels this session may
 * already have used for other questions), and not shown again with their options: the earlier talk stays on the user's
 * screen after a compaction (checked by the user 2026-11-12), so they only go on in the closing "남은 질문" step.
 */
export function carryOverQuestions(store: Store, sessionId?: string, keepLabels = false): string[] {
  return atomic(store.db, () => carryInTx(store, sessionId, keepLabels));
}

function carryInTx(store: Store, sessionId: string | undefined, keepLabels: boolean): string[] {
  const state = readState(store);
  if (state.open.length === 0) return [];
  if (keepLabels) {
    return [
      '남은 질문(압축 뒤에도 이 세션이 이어지므로 질문 알파벳은 그대로다. 앞 대화는 사용자 화면에 그대로 남아 있으니(선택지도 화면에 있다), "다음 행동 및 순서:"의 번호 단계 하나로 "N. 남은 질문에 답해 주세요: G(뜻), H(뜻)"처럼 이 알파벳 그대로 이어 둔다. 처음 물은 대화는 search_log(log_id)로 조회한다):',
      ...state.open.map((l) => {
        const def = state.defs[l];
        const body = def ? def.text.replace(/^\s*(?:[-*]\s*)?[A-Z]{1,2}(?:\s?\([^()\n]{1,60}\))?\.\s*/, '') : '(내용 기록 없음)';
        return `- ${l}${def?.logId ? ` (#${def.logId})` : ''}. ${body}`;
      }),
    ];
  }
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
    `남은 질문(이 세션에서 질문 알파벳을 A부터 다시 붙였다. 처음 물은 대화는 search_log(log_id)로 조회한다. 이 세션의 새 질문은 ${labelAt(open.length)}부터. 첫 답 끝("다음 행동" 위)에 이 질문들을 "A(옛 G, #1234). 질문?" 형식으로 선택지까지 한 줄에 하나씩 다시 보여 주고, "다음 행동 및 순서:"의 번호 단계 하나로 "N. 남은 질문에 답해 주세요: A(뜻), B(뜻)"를 쓴다):`,
    ...lines,
  ];
}

// Question labels per session.

export const LABELS_PREFIX = 'question_labels:';

interface LabelState {
  /** Index of the next free label (A=0). */
  next: number;
}

const read = (store: Store, sessionId: string): LabelState => store.getJson<LabelState>(LABELS_PREFIX + sessionId) ?? { next: 0 };

/** The next free label of a session ('A' for one with none used). */
export function nextLabel(store: Store, sessionId: string): string {
  return labelAt(read(store, sessionId).next);
}

/** A new session's carried questions took A … up to `count` - 1: its own start after them. */
export function startLabelsAfter(store: Store, sessionId: string, count: number): void {
  const s = read(store, sessionId);
  store.setJson(LABELS_PREFIX + sessionId, { next: Math.max(s.next, count) } satisfies LabelState);
}

/**
 * Every label a turn's text asked a question with: the question lines ("X. …?", "X(note). …?", a carried one shown again as
 * "A(옛 G, #1234). …?"). The remaining-questions list (the closing step "N. 남은 질문에 답해 주세요: …", before
 * 2026-11-12 a "남은 질문:" line) is not read here: its labels were asked on question lines before (or carried
 * over, startLabelsAfter), and words on it ("F(새PC 단계)") once moved the next label far past them.
 */
export function usedLabels(text: string): string[] {
  return Object.keys(parseQuestions(text));
}

/** Stop hook: the labels a turn used move the next one past them (never back). */
export function noteAnswerLabels(store: Store, sessionId: string, answer: string): void {
  const used = usedLabels(answer).map(labelIndex);
  if (!used.length) return;
  const s = read(store, sessionId);
  const next = Math.max(s.next, Math.max(...used) + 1);
  if (next !== s.next) store.setJson(LABELS_PREFIX + sessionId, { next } satisfies LabelState);
}

/** Prompt hook: one line with the next label. */
export function labelNotice(store: Store, sessionId: string): string {
  return `<${TAG.questionLabel}>이 세션의 다음 질문 알파벳: ${nextLabel(store, sessionId)} (훅이 센다. 새로 묻는 질문은 이 알파벳부터 붙인다)</${TAG.questionLabel}>`;
}
