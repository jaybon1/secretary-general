/**
 * The to-do summary (feature todo-summary): what is waiting on the user, from the DB only, attached by the prompt hook to
 * each question so an answer whose closing list is "다음 행동 및 순서: 없음" can end with it (the user follows the
 * secretary from a phone and sees no list of its own). What goes in (the user's calls, 2026-11-14):
 *
 *   - open questions (meta open_questions, by the closing step's short name or the whole question sentence), delegated
 *     tasks still running, stopped on a question (asking) or ready (tasks), main-agenda lines in the
 *     user's turn (main_agenda),
 *   - the user's action memories (live ones with an owner, memory_actions): overdue or due within 7 days from today,
 *     condition met (by code), waiting on a condition, and with neither a due date nor a condition (2026-11-18); one the board
 *     model only thinks met goes to the secretary's notice instead (2026-11-15),
 *   - calendar occurrences of today (past ones too) and of the next 7 days (calendar.ts), and since when they are known
 *     when the last fetch failed. The days are counted from today, not by calendar week.
 *
 * A heading line per part with one indented line per item, empty parts left out, "할 일 요약: 없음" when everything is empty. Within one context the same summary
 * is said again as one line ("앞과 같음"); after /clear or a compaction (usage_log context_reset) it is whole again.
 *
 * The secretary's own actions are not in the summary: when code finds one's condition met (conditions.ts), or the board
 * model thinks any action's condition met (the user's too) or an action done, the secretary is told in its own notice
 * (dueNotice), once per context.
 */
import { estimateTokens } from '../core/token-estimate.ts';
import { formatLocal } from '../core/kst-time.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';
import { NOTICE, TAG } from '../core/names.ts';
import { openQuestionItems } from '../store/open-questions.ts';
import { markDroppedTold, untoldDropped } from '../session-continuity/board-todos.ts';
import { conditionText, dueDate, localToUtc, type LiveAction, type Store } from '../store/store.ts';
import { markMetConditions, type ConditionDeps } from './conditions.ts';
import { staleNote } from './calendar.ts';

const SHOWN_PREFIX = 'todo_shown:';
const TOLD_PREFIX = 'todo_told:';
/** Per-session marks of this file, for the idle tick's housekeeping. */
export const TODO_MARK_PREFIXES = [SHOWN_PREFIX, TOLD_PREFIX];
const SOON_DAYS = 7;
/** How the summary says a task's status (asking: stopped on a [질문], waiting for the user). */
const TASK_WORDS = { running: '진행 중', asking: '질문 대기', ready: '대기' } as const;
const ITEM_CHARS = 40;

export interface SummaryPart {
  head: string;
  items: string[];
}

export interface Summary {
  parts: SummaryPart[];
  /** The memory ids of the action items, in the order they are shown (for the secretary, not the user). */
  actionIds: number[];
  note: string;
}

const clip = (s: string, n = ITEM_CHARS) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
/** An action's words without a leading date ("2026-11-13 …"), which its due date says better. */
const actionWords = (content: string) => clip(content.replace(/^\s*\d{4}-\d{2}-\d{2}\s*/, ''));
/**
 * The sentence of a question's text that ends with its first question mark, without the explaining sentences before it
 * and the options after it: "알림이 두 번 와요. 몇 시에 받을까요? 1. 아침 2. 저녁" → "몇 시에 받을까요?". Not shortened.
 */
export function questionSentence(text: string): string {
  const flat = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const q = flat.search(/[?？]/);
  if (q < 0) return flat;
  const upTo = flat.slice(0, q + 1);
  const ends = [...upTo.slice(0, -1).matchAll(/[.!。！]\s|[.!。！]$/g)];
  const start = ends.length ? ends[ends.length - 1].index! + ends[ends.length - 1][0].length : 0;
  return upTo.slice(start).trim() || upTo;
}
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** What the summary holds now (nothing written). */
export function buildSummary(store: Store, now = Date.now()): Summary {
  const today = formatLocal(now, true);
  const soonEnd = addDays(today, SOON_DAYS);
  const parts: SummaryPart[] = [];
  const add = (head: string, items: string[]) => items.length && parts.push({ head, items });

  // A question goes by the short name the closing step gave it, else by its whole question sentence (nothing cut).
  add(
    '남은 질문',
    openQuestionItems(store).map((q) => `${q.label}(${q.name ?? questionSentence(q.text)})`),
  );
  const tasks = (['running', 'asking', 'ready'] as const).flatMap((status) => store.listTasks({ status, limit: 20 }));
  add('도는 업무', tasks.map((t) => `업무${t.id}(${clip(t.title, 20)}) ${TASK_WORDS[t.status as keyof typeof TASK_WORDS]}`));
  add('사용자 차례 안건', store.mainAgenda().filter((a) => a.state === '사용자 차례').map((a) => clip(a.note ? `${a.name} — ${a.note}` : a.name, 50)));

  const mine = store.liveActions().filter((a): a is LiveAction & { action: NonNullable<LiveAction['action']> } => a.action?.owner === 'user');
  // An action the board model only thinks met is not shown to the user: the secretary checks it first (dueNotice) and
  // closes it or brings it up, since such a line went out unchecked after the work was already done.
  const groups: Record<'overdue' | 'soon' | 'met' | 'waiting' | 'undated', LiveAction[]> = { overdue: [], soon: [], met: [], waiting: [], undated: [] };
  for (const a of mine) {
    const due = a.action.due_at ? dueDate(a.action.due_at) : null;
    if (a.action.state === 'maybe_met') continue;
    if (due && due < today) groups.overdue.push(a);
    else if (due && due <= soonEnd) groups.soon.push(a);
    else if (a.action.state === 'met' && a.action.cond_kind) groups.met.push(a);
    else if (a.action.cond_kind) groups.waiting.push(a);
    // Neither a due date nor a condition (the user's call, 2026-11-18): shown too, or the user would never see it again.
    else if (!due) groups.undated.push(a);
  }
  const actionIds: number[] = [];
  const item = (a: LiveAction, tail: string) => {
    actionIds.push(a.id);
    const done = a.action?.done_at ? ' · 끝난 듯' : '';
    return `${actionWords(a.content)}${tail ? ` (${tail})` : ''}${done}`;
  };
  const dueTail = (a: LiveAction) => {
    const due = a.action!.due_at!;
    return /T/.test(due) ? `${md(dueDate(due))} ${formatLocal(due).slice(11, 16)}까지` : `${md(due)}까지`;
  };
  add('기한 지난 할 일', groups.overdue.map((a) => item(a, dueTail(a))));
  add('7일 안 기한', groups.soon.map((a) => item(a, dueTail(a))));
  add('조건 채워진 할 일', groups.met.map((a) => item(a, conditionText(a.action!.cond_kind, a.action!.cond_value))));
  add('조건 기다리는 할 일', groups.waiting.map((a) => item(a, `조건: ${conditionText(a.action!.cond_kind, a.action!.cond_value)}`)));
  add('기한 없는 할 일', groups.undated.map((a) => item(a, '')));

  const dayStart = (date: string) => new Date(localToUtc(date)).toISOString();
  const events = store.calendarEventsBetween(dayStart(today), dayStart(addDays(today, SOON_DAYS + 1)));
  const when = (e: { start_at: string; all_day: boolean }) => (e.all_day ? '종일' : formatLocal(e.start_at).slice(11, 16));
  const where = (e: { location: string | null }) => (e.location ? ` (${clip(e.location, 15)})` : '');
  const todays = events.filter((e) => formatLocal(e.start_at, true) === today);
  const later = events.filter((e) => formatLocal(e.start_at, true) !== today);
  add('오늘 일정', todays.map((e) => `${when(e)} ${clip(e.title, 30)}${where(e)}`));
  add(
    '7일 안 일정',
    later.map((e) => {
      const d = formatLocal(e.start_at, true);
      return `${md(d)}(${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}) ${when(e)} ${clip(e.title, 30)}${where(e)}`;
    }),
  );
  return { parts, actionIds, note: staleNote(store) };
}

/** The block as the answer carries it: a heading per part with its items listed under it, or "할 일 요약: 없음". */
export function renderSummary(s: Summary): string {
  const note = s.note ? `(${s.note})` : '';
  if (!s.parts.length) return `할 일 요약: 없음${note ? ` ${note}` : ''}`;
  // One item per line under its group: a phone screen reads a list better than items run together with " · ".
  return ['할 일 요약', ...s.parts.flatMap((p) => [`- ${p.head}`, ...p.items.map((i) => `  - ${i}`)]), ...(note ? [note] : [])].join('\n');
}

interface Shown {
  text: string;
  reset: number;
}

/**
 * Prompt hook: the summary for this question (whole, or "앞과 같음" when this context already has the same one), and the
 * secretary's notice when one of its actions came due. Conditions code can check are marked first.
 */
export function todoNotice(store: Store, sessionId: string, deps: ConditionDeps = {}): string {
  const marked = markMetConditions(store, deps);
  const reset = store.lastContextReset(sessionId);
  const summary = buildSummary(store, deps.now);
  const text = renderSummary(summary);
  const key = SHOWN_PREFIX + sessionId;
  const shown = store.getJson<Shown>(key);
  const same = !!shown && shown.text === text && shown.reset === reset;
  if (!same) store.setJson(key, { text, reset } satisfies Shown);
  const ids = summary.actionIds.length ? [`(비서용, 붙이지 않음: 요약의 할 일 기억 번호 차례대로 ${summary.actionIds.map((i) => `#${i}`).join(' ')})`] : [];
  const block = same
    ? `<${TAG.todoSummary}>할 일 요약: 앞과 같음. ${hookNoticeText(NOTICE.todoSummary, 'same')}</${TAG.todoSummary}>`
    : [`<${TAG.todoSummary}>`, hookNoticeText(NOTICE.todoSummary, 'summary'), '', text, '', ...ids, `</${TAG.todoSummary}>`].join('\n');
  store.logUsage('todo_summary', estimateTokens(block), { session: sessionId, same, parts: summary.parts.length, marked: marked.map((a) => a.id) });
  return [block, dueNotice(store, sessionId, reset)].filter(Boolean).join('\n');
}

interface Told {
  reset: number;
  told: string[];
}

/**
 * The secretary's own actions to take up now: its conditions met (code, or the board model thinks so) or its due date
 * come, and any action the board model thinks done. Each once per context. Then the board's new to-dos code left out as
 * duplicates, each once in all (the first conversation that gets a prompt). '' when there is none.
 */
export function dueNotice(store: Store, sessionId: string, reset = store.lastContextReset(sessionId)): string {
  const key = TOLD_PREFIX + sessionId;
  const saved = store.getJson<Told>(key);
  const told = new Set(saved && saved.reset === reset ? saved.told : []);
  const lines: string[] = [];
  const marks: string[] = [];
  for (const a of store.liveActions()) {
    const r = a.action;
    if (!r) continue;
    const why =
      r.owner === 'secretary' && r.state === 'met'
        ? `프로그램 확인: ${conditionText(r.cond_kind, r.cond_value) || (r.due_at ? `기한 ${dueDate(r.due_at)} 됨` : '조건 채워짐')}`
        : r.state === 'maybe_met'
          ? `상황판이 본 듯: ${conditionText(r.cond_kind, r.cond_value)}${r.marked_log_id ? ` #${r.marked_log_id}` : ''}${r.owner === 'user' ? ', 사용자 할 일' : ''}`
          : '';
    const mark = `${a.id}:${r.state}:${r.marked_at ?? ''}`;
    if (why && !told.has(mark)) {
      lines.push(`- #${a.id} ${clip(a.content, 80)} (${why})`);
      marks.push(mark);
    }
    if (r.done_at) {
      const doneMark = `${a.id}:done:${r.done_at}`;
      if (!told.has(doneMark)) {
        lines.push(`- #${a.id} ${clip(a.content, 80)} (끝난 듯${r.done_log_id ? ` #${r.done_log_id}` : ''}, ${r.owner === 'user' ? '사용자' : '비서'} 할 일)`);
        marks.push(doneMark);
      }
    }
  }
  // New to-dos the board found but left out as like a memory already there (board-todos.ts): once, in the first conversation.
  const dropped = untoldDropped(store);
  const droppedLines = dropped.map((d) => `- "${clip(d.content, 80)}" (${d.owner === 'user' ? '사용자' : '비서'}${d.due ? `, 기한 ${d.due}` : ''}, #${d.logId}) → 비슷한 기억 ${d.similar.map((i) => `#${i}`).join(' ')}`);
  if (dropped.length) markDroppedTold(store, dropped.map((d) => d.n), sessionId);
  if (!lines.length && !droppedLines.length) return '';
  if (lines.length) store.setJson(key, { reset, told: [...told, ...marks].slice(-200) } satisfies Told);
  return [
    `<${TAG.todoDue}>`,
    ...(lines.length ? [hookNoticeText(NOTICE.todoSummary, 'due'), ...lines] : []),
    ...(droppedLines.length ? [hookNoticeText(NOTICE.todoSummary, 'dropped'), ...droppedLines] : []),
    `</${TAG.todoDue}>`,
  ].join('\n');
}
