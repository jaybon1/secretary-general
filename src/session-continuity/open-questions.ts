/**
 * The open questions the secretary asked (label + text, kept in meta), carried across secretary sessions:
 * read from each answer by the Stop hook, relabelled A, B, … for a new session. The pointers to the previous
 * session are in situation-board-notice.ts, the running tasks in workspace/watch-check.ts.
 */
import type { Store } from '../store/store.ts';
import { startLabelsAfter } from '../mistake-guards/question-labels.ts';

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
  /** Questions closed within EXPIRE_MS, by the label they had then: the board's question lines are marked from these. */
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

/** Labels the user picked an option for ("c1", "A2 B1"); a bare "e - …" is discussion, not an answer. */
export function parseAnswers(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z])([A-Za-z]{1,2})(\d{1,2})(?![\dA-Za-z])/g)].map((x) => x[1].toUpperCase());
}

function readState(store: Store): OpenState {
  return store.getJson<OpenState>(META_KEY) ?? { lastLogId: 0, open: [], defs: {} };
}

/** Stop hook: fold the session's latest assistant message into the open-question list (`now`: the evaluation set replays old talk). */
export function updateOpenQuestions(store: Store, sessionId: string, now = Date.now()): void {
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

/** What the open-question list knows about the board's question lines (situation-board.ts markClosedQuestions). */
export interface QuestionKeys {
  /** The open labels with the labels they had in earlier sessions. */
  labels: Set<string>;
  /** Questions closed in the last EXPIRE_MS, by the label they had when closed and by their earlier labels. */
  closed: Map<string, ClosedQuestion>;
  /** How many questions are open now. */
  openCount: number;
}

/**
 * Undefined when there is no list yet (a new install): then nothing can be said about a line. Closed records are pruned
 * when the Stop hook folds an answer in (updateOpenQuestions, with the time the talk was given), not here.
 */
export function openQuestionKeys(store: Store): QuestionKeys | undefined {
  const state = store.getJson<OpenState>(META_KEY);
  if (!state) return undefined;
  const labels = new Set<string>();
  for (const l of state.open) {
    labels.add(l);
    const def = state.defs[l];
    for (const old of def?.formerly ?? []) labels.add(old);
  }
  const closed = new Map<string, ClosedQuestion>();
  for (const [l, c] of Object.entries(keepClosed(state.closed, state.open, -Infinity))) {
    // The label it had when closed counts over an earlier label another question may have had.
    for (const old of c.formerly ?? []) if (!closed.has(old)) closed.set(old, c);
    closed.set(l, c);
  }
  return { labels, closed, openCount: state.open.length };
}

/** Open questions as "- A. …?" lines, for the board rewrite. */
export function openQuestionLines(store: Store): string[] {
  const state = readState(store);
  return state.open.map((l) => (state.defs[l] ? `- ${state.defs[l].text}` : `- ${l}. (내용 기록 없음)`));
}

/**
 * A new session relabels the carried questions A, B, … (keeping each one's asking log id and old
 * label) so labels stay short; its own new questions continue after them (with its id, the next label is counted from
 * there: guards/question-labels.ts). After a compaction (keepLabels) the session goes on and its labels with it: the
 * questions are listed as they are, nothing relabelled (relabelling would give A, B … again to labels this session may
 * already have used for other questions), and not shown again with their options: the earlier talk stays on the user's
 * screen after a compaction (checked by the user 2026-11-12), so they only go on in the closing "남은 질문" step.
 */
export function carryOverQuestions(store: Store, sessionId?: string, keepLabels = false): string[] {
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
