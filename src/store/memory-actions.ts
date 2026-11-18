/**
 * 할 일 기억(memories.kind='action')의 주인·기한·조건(memory_actions, 옮기기 19)을 읽고 쓰는 함수들. 기억 표는 고치지 않고 이 표가
 * 기억 번호로 붙는다. 할 일 요약(기능 todo-summary)·상황판 담당·기억 정리 담당·remember 도구·action-set 명령이 함께 쓴다.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { formatLocal, nowIso } from '../core/kst-time.ts';
import { TAGS_SQL } from './tag-names.ts';

export const ACTION_OWNERS = ['user', 'secretary'] as const;
export type ActionOwner = (typeof ACTION_OWNERS)[number];
export const ACTION_COND_KINDS = ['date', 'task_done', 'commit_in_main', 'question_answered', 'text'] as const;
export type ActionCondKind = (typeof ACTION_COND_KINDS)[number];
export const ACTION_STATES = ['waiting', 'met', 'maybe_met'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export interface ActionCondition {
  kind: ActionCondKind;
  value: string;
}

export interface MemoryAction {
  memory_id: number;
  owner: ActionOwner;
  /** 'YYYY-MM-DD' (a local date) or a UTC ISO time. */
  due_at: string | null;
  cond_kind: ActionCondKind | null;
  cond_value: string | null;
  state: ActionState;
  marked_by: string | null;
  marked_at: string | null;
  marked_log_id: number | null;
  done_log_id: number | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A live action memory with its row, if it has one (an action saved before the table, or without values, has none). */
export interface LiveAction {
  id: number;
  content: string;
  tags: string;
  created_at: string;
  action: MemoryAction | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A due date as kept: "2026-11-20" stays a local date; a time ("2026-11-20T15:00+09:00", "2026-11-20 15:00" read as local)
 * becomes UTC ISO. Throws on anything else, saying the forms.
 */
export function normalizeDue(text: string): string {
  const t = text.trim();
  if (DATE.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`))) return t;
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(t);
  const ms = local ? localToUtc(local[1], local[2]) : Date.parse(t);
  if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}/.test(t)) throw new Error(`기한 형식이 아님: ${t} (YYYY-MM-DD, 또는 시각까지 YYYY-MM-DDTHH:MM+09:00)`);
  return new Date(ms).toISOString();
}

/** The UTC time of a local date and clock time ("HH:MM") in the display time zone. */
export function localToUtc(date: string, clock = '00:00'): number {
  const guess = Date.parse(`${date}T${clock}:00Z`);
  const shown = Date.parse(`${formatLocal(guess, false, true).replace(' ', 'T')}Z`);
  return guess - (shown - guess);
}

/** The local date ("YYYY-MM-DD") a due value falls on. */
export function dueDate(due: string): string {
  return DATE.test(due) ? due : formatLocal(due, true);
}

/**
 * A condition as written on a command line or by the board model: "task_done:<업무 번호>", "commit_in_main:<커밋 해시>",
 * "question_answered:B", "date:2026-11-20", "text:…". Throws on an unknown kind or an empty value.
 */
export function parseCondition(text: string): ActionCondition {
  const m = /^\s*([a-z_]+)\s*:\s*([^]*?)\s*$/.exec(text);
  const kind = m?.[1] as ActionCondKind | undefined;
  if (!m || !kind || !ACTION_COND_KINDS.includes(kind) || !m[2]) throw new Error(`조건 형식이 아님: ${text} (${ACTION_COND_KINDS.map((k) => `${k}:<값>`).join(', ')})`);
  return checkCondition({ kind, value: m[2] });
}

/** The value checked for its kind (task_done a number, commit_in_main a hash, date a date, question_answered a label or row id). */
export function checkCondition(c: ActionCondition): ActionCondition {
  const value = c.value.trim();
  const bad = (what: string) => new Error(`조건 ${c.kind}의 값이 ${what}이 아님: ${value}`);
  switch (c.kind) {
    case 'task_done':
      if (!/^\d+$/.test(value)) throw bad('업무 번호');
      break;
    case 'commit_in_main':
      if (!/^[0-9a-f]{7,40}$/i.test(value)) throw bad('커밋 해시');
      break;
    case 'date':
      return { kind: c.kind, value: normalizeDue(value) };
    case 'question_answered':
      if (!/^([A-Za-z]{1,2}|\d+(:[A-Za-z]{1,2})?)$/.test(value)) throw bad('질문 알파벳이나 물은 대화 번호(번호:알파벳)');
      return { kind: c.kind, value: value.toUpperCase() };
    default:
      if (!value) throw bad('글');
  }
  return { kind: c.kind, value };
}

/** A condition said in a line ("업무 <번호> 끝남", "커밋 <해시 앞 7자> main에 들어감", "질문 B 답함", "날짜 2026-11-20", the text). */
export function conditionText(kind: ActionCondKind | null, value: string | null): string {
  if (!kind || !value) return '';
  switch (kind) {
    case 'task_done':
      return `업무 ${value} 끝남`;
    case 'commit_in_main':
      return `커밋 ${value.slice(0, 7)} main에 들어감`;
    case 'question_answered':
      if (/^\d+:/.test(value)) return `#${value.split(':')[0]}에서 물은 질문 ${value.split(':')[1]}에 답함`;
      return /^\d+$/.test(value) ? `#${value}에서 물은 질문에 답함` : `질문 ${value} 답함`;
    case 'date':
      return `${dueDate(value)} 됨`;
    default:
      return value;
  }
}

const STATE_WORDS: Record<ActionState, string> = { waiting: '기다림', met: '채워짐', maybe_met: '채워진 듯' };

/**
 * An action's values in one place, owner → due date → condition (with its state) → the "seems done" mark, so the readers
 * (recall, list_memories and the injected memories at the line's end; the board rewrite's list of live actions,
 * session-continuity/board-todos.ts) cannot drift apart. One form for all, with full dates (the user's call, 2026-11-14):
 * "사용자 · 기한 2026-11-20 · 조건 업무 3 끝남 (기다림) · 끝난 듯 표시됨", a due time as "기한 2026-11-21 15:00".
 */
export function actionNote(r: MemoryAction): string {
  const bits = [r.owner === 'user' ? '사용자' : '비서'];
  if (r.due_at) bits.push(`기한 ${DATE.test(r.due_at) ? r.due_at : formatLocal(r.due_at)}`);
  if (r.cond_kind) bits.push(`조건 ${conditionText(r.cond_kind, r.cond_value)} (${STATE_WORDS[r.state]})`);
  if (r.done_at) bits.push('끝난 듯 표시됨');
  return bits.join(' · ');
}

export function getAction(db: DatabaseSync, memoryId: number): MemoryAction | undefined {
  return db.prepare('SELECT * FROM memory_actions WHERE memory_id = ?').get(memoryId) as MemoryAction | undefined;
}

export interface ActionInput {
  owner?: ActionOwner;
  /** A due value (normalizeDue), or null to clear it. */
  due?: string | null;
  /** A condition, or null to clear it (the state goes back to waiting). */
  condition?: ActionCondition | null;
  state?: ActionState;
  /** Clears the board model's "seems done" mark. */
  clearDone?: boolean;
  /** Who set it: secretary, board, consolidation, hook, cli. */
  by: string;
  logId?: number | null;
}

/**
 * Adds or changes an action memory's row; only the given fields change. The memory must be an action: a row on another
 * kind would never be read. A new row needs its owner.
 */
export function setAction(db: DatabaseSync, memoryId: number, input: ActionInput): MemoryAction {
  const m = db.prepare('SELECT kind FROM memories WHERE id = ?').get(memoryId) as { kind: string } | undefined;
  if (!m) throw new Error(`기억 #${memoryId}이 없음`);
  if (m.kind !== 'action') throw new Error(`기억 #${memoryId}은 할 일(action)이 아님(${m.kind})`);
  const now = nowIso();
  const old = getAction(db, memoryId);
  if (!old && !input.owner) throw new Error(`기억 #${memoryId}에 할 일 값이 없어 주인(owner)부터 정해야 함`);
  const due = input.due === undefined ? (old?.due_at ?? null) : input.due === null ? null : normalizeDue(input.due);
  const cond = input.condition === undefined ? (old?.cond_kind ? { kind: old.cond_kind, value: old.cond_value ?? '' } : null) : input.condition && checkCondition(input.condition);
  const condChanged = input.condition !== undefined && ((cond?.kind ?? null) !== (old?.cond_kind ?? null) || (cond?.value ?? null) !== (old?.cond_value ?? null));
  const state: ActionState = input.state ?? (condChanged ? 'waiting' : (old?.state ?? 'waiting'));
  const marked = input.state !== undefined || condChanged || !old;
  const row = {
    owner: input.owner ?? old!.owner,
    due_at: due,
    cond_kind: cond?.kind ?? null,
    cond_value: cond?.value ?? null,
    state,
    marked_by: marked ? input.by : old!.marked_by,
    marked_at: marked ? now : old!.marked_at,
    marked_log_id: marked ? (input.logId ?? null) : old!.marked_log_id,
    done_log_id: input.clearDone ? null : (old?.done_log_id ?? null),
    done_at: input.clearDone ? null : (old?.done_at ?? null),
  };
  db.prepare(
    `INSERT INTO memory_actions (memory_id, owner, due_at, cond_kind, cond_value, state, marked_by, marked_at, marked_log_id, done_log_id, done_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (memory_id) DO UPDATE SET owner = excluded.owner, due_at = excluded.due_at, cond_kind = excluded.cond_kind,
       cond_value = excluded.cond_value, state = excluded.state, marked_by = excluded.marked_by, marked_at = excluded.marked_at,
       marked_log_id = excluded.marked_log_id, done_log_id = excluded.done_log_id, done_at = excluded.done_at, updated_at = excluded.updated_at`,
  ).run(memoryId, row.owner, row.due_at, row.cond_kind, row.cond_value, row.state, row.marked_by, row.marked_at, row.marked_log_id, row.done_log_id, row.done_at, old?.created_at ?? now, now);
  return getAction(db, memoryId)!;
}

/** The board model's "seems done" on an action (only shown; the secretary checks and closes the memory). */
export function markActionDone(db: DatabaseSync, memoryId: number, logId: number | null): boolean {
  return Number(db.prepare('UPDATE memory_actions SET done_log_id = ?, done_at = ?, updated_at = ? WHERE memory_id = ? AND done_at IS NULL').run(logId, nowIso(), nowIso(), memoryId).changes) > 0;
}

/** Every live action memory (not invalidated, not replaced), oldest first, with its row if it has one. */
export function liveActions(db: DatabaseSync): LiveAction[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.content, ${TAGS_SQL('m')} AS tags, m.created_at, a.memory_id AS a_id FROM memories m LEFT JOIN memory_actions a ON a.memory_id = m.id
       WHERE m.kind = 'action' AND m.valid_to IS NULL AND m.superseded_by IS NULL ORDER BY m.id`,
    )
    .all() as Array<{ id: number; content: string; tags: string; created_at: string; a_id: number | null }>;
  return rows.map((r) => ({ id: r.id, content: r.content, tags: r.tags, created_at: r.created_at, action: r.a_id ? getAction(db, r.id)! : null }));
}

/**
 * A replaced action's part that still holds (memories.ts rememberJudged rests) keeps its owner, due date and condition.
 * Done inside the caller's transaction.
 */
export function copyActionRow(db: DatabaseSync, fromId: number, toId: number): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_actions'").get();
  if (!exists) return;
  db.prepare(
    `INSERT OR IGNORE INTO memory_actions (memory_id, owner, due_at, cond_kind, cond_value, state, marked_by, marked_at, marked_log_id, done_log_id, done_at, created_at, updated_at)
     SELECT ?, owner, due_at, cond_kind, cond_value, state, marked_by, marked_at, marked_log_id, NULL, NULL, created_at, ? FROM memory_actions WHERE memory_id = ?`,
  ).run(toId, nowIso(), fromId);
}
