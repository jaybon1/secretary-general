/**
 * The board rewrite's to-do part (the user's calls, 2026-11-14): the board itself only follows the talk; what is to be
 * done lives in the DB (action memories with their owner, due date and condition, store/memory-actions.ts) and the to-do
 * summary reads it from there (todo-summary/). The same Haiku run that rewrites the board is given the DB's list of live
 * actions and, after the board, writes in a fixed form only (a) actions the talk shows done, (b) actions whose condition
 * the talk shows met, (c) new actions the DB does not have yet. Code writes them, each with the conversation row it rests
 * on: (a) a "seems done" mark only (the secretary checks and closes the memory), (b) the state maybe_met, (c) a new
 * action memory and its row. A line not in the form, or citing a row the run did not read, is left out and recorded.
 */
import { nowIso } from '../core/kst-time.ts';
import { rememberChecked } from '../memory/duplicate-check.ts';
import type { SemanticSearch } from '../semantic-search/client.ts';
import { actionNote, conditionText, normalizeDue, type ActionCondition, type ActionOwner, type LiveAction, type Store } from '../store/store.ts';
import { resolveQuestionCondition } from '../store/open-questions.ts';
import { quoteFormProblem, quoteLine } from '../memory/source-quote.ts';
import { inventedWordsInLine } from '../mistake-guards/answer-checks.ts';
import { inventedWords } from '../mistake-guards/invented-words.ts';

/** The line the to-do part starts with, after the board. */
export const TODO_MARK = '=== 할 일 판단 ===';
/** New actions taken from one chunk at most (a model listing every sentence as a to-do is cut off, and recorded). */
const NEW_MAX = 5;

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

/** One live action as the rewrite reads it (its values as store/memory-actions.ts actionNote writes them). */
function actionLine(a: LiveAction): string {
  return `- #${a.id} [${a.action ? actionNote(a.action) : '값 없음'}] ${clip(a.content, 120)}`;
}

/** The DB's live actions for the prompt ("(없음)" when there are none). */
export function todoListLines(store: Store): string[] {
  const all = store.liveActions();
  return all.length ? all.map(actionLine) : ['(없음)'];
}

/** The rules the rewrite gets for the to-do part. */
export const TODO_RULES = [
  `- 상황판 글 다음 줄에 "${TODO_MARK}"를 쓰고, 그 아래에 [DB 할 일 목록]과 [새 대화]를 견주어 아래 세 가지 줄만 쓴다. 해당이 없으면 "없음" 한 줄만 쓴다. 줄 끝 근거 번호는 [새 대화]의 번호만 쓴다.`,
  '  - [새 대화]에서 끝났다고 보이는 목록의 할 일: "- 끝남 #기억번호 (#대화번호)"',
  '  - 조건이 "기다림"인 목록의 할 일 가운데 [새 대화]에서 그 조건이 채워졌다고 보이는 것: "- 조건 채워짐 #기억번호 (#대화번호)"',
  '  - [새 대화]에서 새로 생긴 할 일 가운데 목록에 없는 것(사용자가 하기로 한 일, 비서가 하기로 한 일, 무엇이 끝난 뒤로 미룬 일): "- 새 할 일 | 주인: 사용자 | 기한: 2026-11-20 | 조건: 없음 | 주제: 텃밭 | 내용: 토마토 모종을 산다 | 인용: \"모종은 내가 사 올게\" (#대화번호)". 주인은 사용자 또는 비서, 기한은 YYYY-MM-DD(시각이 있으면 YYYY-MM-DD HH:MM) 또는 없음, 조건은 없음 · 날짜 YYYY-MM-DD · 업무 <번호> 끝남 · 커밋 <해시> main에 들어감 · 질문 B 답함 · 글 <기계가 확인 못 하는 조건> 가운데 하나, 내용은 맥락 없이 읽어도 되는 한 문장으로 무엇을 가리키는지 대상 이름을 넣어 쓴다(예: "AGENTS.md 섹션을 스킬로 옮길 목록 표를 확인한다"). 한 글자 낱말이나 줄임말을 이어 쓰지 않는다.',
  '  - 사용자 할 일은 사용자가 직접 하겠다고 말한 일만 쓴다. 비서가 제안하거나 물은 선택지, 사용자가 고르지 않은 안은 할 일이 아니다. 인용에는 그렇게 말한 [새 대화]의 사용자 말 구절을 글자 그대로 옮긴다(프로그램이 사용자 말에 그대로 있는지 확인한다). 비서 할 일에는 인용을 쓰지 않아도 된다.',
  '- 확실한 것만 쓴다. 할 일을 지우거나 고치는 일은 비서가 확인해서 한다. 상황판 섹션에는 할 일 목록을 쓰지 않는다.',
];

/** The board text and the to-do part of one answer (the part '' when the answer has none). */
export function splitTodoPart(answer: string): { board: string; todo: string } {
  const at = answer.indexOf(TODO_MARK);
  if (at < 0) return { board: answer.trim(), todo: '' };
  return { board: answer.slice(0, at).trim(), todo: answer.slice(at + TODO_MARK.length).trim() };
}

export type TodoJudgement =
  | { type: 'done'; id: number; logId: number }
  | { type: 'met'; id: number; logId: number }
  | { type: 'new'; owner: ActionOwner; due: string | null; condition: ActionCondition | null; topic: string; content: string; logId: number; quote?: string };

/** A condition as the to-do part words it; undefined when it is not one of the forms. */
export function parseConditionWords(text: string): ActionCondition | null | undefined {
  const t = text.trim();
  if (/^없음$/.test(t)) return null;
  let m: RegExpExecArray | null;
  if ((m = /^날짜\s+(\d{4}-\d{2}-\d{2})$/.exec(t))) return { kind: 'date', value: m[1] };
  if ((m = /^업무\s*(\d+)\s*끝남$/.exec(t))) return { kind: 'task_done', value: m[1] };
  if ((m = /^커밋\s+([0-9a-f]{7,40})\b/i.exec(t))) return { kind: 'commit_in_main', value: m[1] };
  if ((m = /^질문\s+([A-Z]{1,2})\s*답함$/.exec(t))) return { kind: 'question_answered', value: m[1] };
  if ((m = /^글\s+(.+)$/.exec(t))) return { kind: 'text', value: m[1].trim() };
  return undefined;
}

/**
 * An answer without the to-do summary block it may end with (todo-summary.ts renderSummary: "할 일 요약" and its "- "
 * lines, or "할 일 요약: 없음"): the rewrite reads it as talk about those to-dos and marked their conditions met from it.
 */
export function withoutTodoSummary(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (/^\s*\**할 일 요약\**\s*[:：]/.test(line)) continue;
    if (/^\s*\**할 일 요약\**\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && (/^\s*[-*]\s/.test(line) || /^\s*\(일정은/.test(line))) continue;
    inBlock = false;
    out.push(line);
  }
  return out.join('\n');
}

/** A quote as written, without the quote marks around it. */
const unquote = (s: string | undefined) => (s ?? '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

/** The lines of a to-do part in the form; the others come back in `skipped`. */
export function parseTodoPart(todo: string): { judgements: TodoJudgement[]; skipped: string[] } {
  const judgements: TodoJudgement[] = [];
  const skipped: string[] = [];
  for (const raw of todo.split('\n')) {
    const line = raw.trim();
    if (!line || /^없음\.?$/.test(line)) continue;
    let m: RegExpExecArray | null;
    if ((m = /^[-*]\s*(끝남|조건 채워짐)\s*#(\d+)\s*\(#(\d+)\)\s*$/.exec(line))) {
      judgements.push({ type: m[1] === '끝남' ? 'done' : 'met', id: Number(m[2]), logId: Number(m[3]) });
      continue;
    }
    m = /^[-*]\s*새 할 일\s*\|\s*주인:\s*(사용자|비서)\s*\|\s*기한:\s*([^|]+?)\s*\|\s*조건:\s*([^|]+?)\s*\|\s*주제:\s*([^|]+?)\s*\|\s*내용:\s*(.+?)(?:\s*\|\s*인용:\s*(.+?))?\s*\(#(\d+)\)\s*$/.exec(line);
    const due = m?.[2].trim();
    const condition = m ? parseConditionWords(m[3]) : undefined;
    if (!m || condition === undefined || !(due === '없음' || /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(due!))) {
      skipped.push(clip(line, 120));
      continue;
    }
    judgements.push({ type: 'new', owner: m[1] === '사용자' ? 'user' : 'secretary', due: due === '없음' ? null : due!, condition, topic: m[4].trim(), content: m[5].trim(), logId: Number(m[7]), ...(unquote(m[6]) ? { quote: unquote(m[6]) } : {}) });
  }
  return { judgements, skipped };
}

/**
 * New to-dos the board found but code left out as close in meaning to a memory already there. The secretary is told each
 * once (todo-summary.ts dueNotice), so one left out by mistake can still be saved.
 */
const DROPPED_KEY = 'board_todo_dropped';
/** Kept this long, told or not, then dropped from the list. */
const DROPPED_KEEP_MS = 14 * 86_400_000;

export interface DroppedTodo {
  n: number;
  at: string;
  /** The memories it was found close to. */
  similar: number[];
  content: string;
  owner: ActionOwner;
  due: string | null;
  logId: number;
  /** The session that was told, when it was. */
  toldIn?: string;
}

function droppedList(store: Store, now = Date.now()): DroppedTodo[] {
  return (store.getJson<DroppedTodo[]>(DROPPED_KEY) ?? []).filter((d) => now - Date.parse(d.at) < DROPPED_KEEP_MS);
}

function noteDropped(store: Store, d: Omit<DroppedTodo, 'n' | 'at'>): void {
  const list = droppedList(store);
  list.push({ ...d, n: Math.max(0, ...list.map((x) => x.n)) + 1, at: nowIso() });
  store.setJson(DROPPED_KEY, list.slice(-50));
}

/** The left-out new to-dos no session was told of yet. */
export function untoldDropped(store: Store): DroppedTodo[] {
  return droppedList(store).filter((d) => !d.toldIn);
}

/** Marks them told (in `sessionId`), so the next conversation does not hear them again. */
export function markDroppedTold(store: Store, ns: number[], sessionId: string): void {
  const told = new Set(ns);
  store.setJson(
    DROPPED_KEY,
    droppedList(store).map((d) => (told.has(d.n) ? { ...d, toldIn: sessionId } : d)),
  );
}

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * Whether the row a "condition met" cites only says the to-do again (the user's call, 2026-11-18: a mark rested on the
 * secretary introducing the to-do with its number and the to-do summary block): a secretary row that names the memory
 * (#id), or holds its words or its condition's words whole. A user row, or a secretary row saying what happened, counts.
 */
function restates(row: { role?: string; content?: string } | undefined, a: LiveAction): boolean {
  if (!row?.content || row.role !== 'assistant') return false;
  if (new RegExp(`#${a.id}(?!\\d)`).test(row.content)) return true;
  const text = squash(row.content);
  const words = squash(a.content.replace(/^\s*\d{4}-\d{2}-\d{2}\s*/, ''));
  const cond = squash(conditionText(a.action?.cond_kind ?? null, a.action?.cond_value ?? null));
  return (words.length >= 6 && text.includes(words)) || (cond.length >= 4 && text.includes(cond));
}

/**
 * Why a new to-do is left out before it is saved, or '' (the user's calls, 2026-11-19: the board had made a user to-do of
 * an option the secretary offered and the user never picked, in words no one could read):
 * - a user's to-do carries the user's own words it rests on, and they stand word for word in a user row the run read (the
 *   decision quote's check, memory/source-quote.ts); a secretary's row does not count;
 * - its wording has no word from the list of made-up words (the answer check invented-word). The model is not asked again:
 *   the next run or the secretary takes the to-do up again.
 */
function newTodoProblem(store: Store, j: Extract<TodoJudgement, { type: 'new' }>, rows: Array<{ role?: string; content?: string }>): string {
  if (j.owner === 'user') {
    if (!j.quote || quoteFormProblem(j.quote)) return '사용자 할 일에 사용자 말 인용이 없어(또는 형식이 틀려) 뺌';
    const said = rows.some((r) => r.role === 'user' && !!r.content && quoteLine(r.content, j.quote!) !== null);
    if (!said) return `사용자 할 일의 인용 "${clip(j.quote, 40)}"이 읽은 대화의 사용자 말에 없어 뺌`;
  }
  const words = inventedWordsInLine(j.content, inventedWords(store));
  if (words.length) return `할 일 글에 지어낸 말(${words.map((w) => `"${w}"`).join(', ')})이 있어 뺌`;
  return '';
}

/**
 * Writes the judgements of one chunk whose rows are `rows` (only those can be cited). A new to-do close in meaning to a
 * recent memory (`search`, the remember tool's check) is left out and kept for the secretary's notice. Returns what it
 * did and left, for the run's record.
 */
export async function applyTodoJudgements(
  store: Store,
  judgements: TodoJudgement[],
  rows: Array<{ id: number; session_id: string; role?: string; content?: string }>,
  search: () => SemanticSearch | null = () => null,
): Promise<string[]> {
  const read = new Map(rows.map((r) => [r.id, r.session_id]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const live = new Map(store.liveActions().map((a) => [a.id, a]));
  const notes: string[] = [];
  let added = 0;
  for (const j of judgements) {
    if (!read.has(j.logId)) {
      notes.push(`근거 #${j.logId}이 읽은 대화 밖이라 뺌(${j.type === 'new' ? clip(j.content, 40) : `#${j.id}`})`);
      continue;
    }
    if (j.type !== 'new') {
      const a = live.get(j.id);
      if (!a) notes.push(`#${j.id}: 살아 있는 할 일 기억이 아니라 뺌`);
      else if (!a.action) notes.push(`#${j.id}: 할 일 값(주인)이 없어 ${j.type === 'done' ? '끝난 듯' : '조건 채워진 듯'} 표시를 못 함`);
      else if (j.type === 'done') {
        if (store.markActionDone(j.id, j.logId)) notes.push(`끝난 듯 #${j.id} (#${j.logId})`);
      } else if (a.action.cond_kind && a.action.state === 'waiting' && restates(byId.get(j.logId), a)) {
        // The secretary saying the to-do again (introducing it, the to-do summary) is no sign its condition came.
        notes.push(`조건 채워진 듯 #${j.id}: 근거 #${j.logId}이 할 일을 되풀이한 비서 말이라 뺌`);
      } else if (a.action.cond_kind && a.action.state === 'waiting') {
        store.setAction(j.id, { state: 'maybe_met', by: 'board', logId: j.logId });
        notes.push(`조건 채워진 듯 #${j.id} (#${j.logId})`);
      }
      continue;
    }
    const why = newTodoProblem(store, j, rows);
    if (why) {
      notes.push(`${why}: ${clip(j.content, 40)} (#${j.logId})`);
      continue;
    }
    if (added >= NEW_MAX) {
      notes.push(`새 할 일이 ${NEW_MAX}개를 넘어 뺌: ${clip(j.content, 40)}`);
      continue;
    }
    const same = [...live.values()].find((a) => a.content.replace(/\s+/g, '') === j.content.replace(/\s+/g, ''));
    if (same) {
      notes.push(`새 할 일이 #${same.id}와 같아 뺌`);
      continue;
    }
    try {
      // The values are checked before the memory is saved, so a bad date never leaves an action without its row.
      if (j.due) normalizeDue(j.due);
      if (j.condition?.kind === 'date') normalizeDue(j.condition.value);
      // The same meaning check as the remember tool (memory/duplicate-check.ts); without the search server, the words above only.
      // Its topic only: kind says it is a to-do, and a '할 일' tag was a broad one that ran into the topic's words.
      const res = await rememberChecked(store, search(), { kind: 'action', content: j.content, tags: [j.topic], sourceLogId: j.logId, sourceSession: read.get(j.logId) });
      if ('similar' in res) {
        const ids = res.similar.map((s) => s.memory.id);
        notes.push(`중복 같아 뺌 ${ids.map((i) => `#${i}`).join(' ')} (${clip(j.content, 40)}, #${j.logId})`);
        noteDropped(store, { similar: ids, content: j.content, owner: j.owner, due: j.due, logId: j.logId });
        continue;
      }
      const { id } = res.saved;
      store.setAction(id, { owner: j.owner, due: j.due, condition: j.condition && resolveQuestionCondition(store, j.condition), by: 'board', logId: j.logId });
      added++;
      notes.push(`새 할 일 #${id} (${j.owner === 'user' ? '사용자' : '비서'}, #${j.logId})`);
    } catch (err) {
      notes.push(`새 할 일 저장 실패(${clip(j.content, 40)}): ${(err as Error).message.slice(0, 100)}`);
    }
  }
  return notes;
}
