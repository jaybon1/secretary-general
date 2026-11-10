/**
 * 실수 막기 장치(기능 'mistake-guards', src/mistake-guards/)가 DB에 남기는 것: 턴마다 부른 도구와 Stop 훅 검사 결과(turn_tools), 비서가 적는
 * 실수 기록(mistakes). Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/kst-time.ts';

// ---- turn tools -------------------------------------------------------------

/** One check's verdict on a turn's answer: blocked (the model wrote again) or warned (told on the next prompt). */
export interface GuardHit {
  check: string;
  level: 'block' | 'warn';
}

export interface TurnTools {
  id: number;
  session_id: string;
  /** Transcript uuid of the line that started the turn (a user prompt: raw_log.message_uuid). */
  turn_uuid: string;
  tools: string[];
  guard: GuardHit[];
  created_at: string;
}

interface TurnRow {
  id: number;
  session_id: string;
  turn_uuid: string;
  tools: string;
  guard: string;
  created_at: string;
}

const turnOf = (r: TurnRow): TurnTools => ({ ...r, tools: JSON.parse(r.tools), guard: JSON.parse(r.guard) });

/** Saves (or, for the same turn written again, replaces) one turn's tool names and check results. */
export function saveTurnTools(db: DatabaseSync, t: { sessionId: string; turnUuid: string; tools: string[]; guard: GuardHit[] }): void {
  db.prepare(
    `INSERT INTO turn_tools (session_id, turn_uuid, tools, guard, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id, turn_uuid) DO UPDATE SET tools = excluded.tools, guard = excluded.guard, created_at = excluded.created_at`,
  ).run(t.sessionId, t.turnUuid, JSON.stringify(t.tools), JSON.stringify(t.guard), nowIso());
}

export function turnTools(db: DatabaseSync, opts: { sessionId?: string; limit?: number } = {}): TurnTools[] {
  const rows = opts.sessionId
    ? db.prepare('SELECT * FROM turn_tools WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(opts.sessionId, opts.limit ?? 50)
    : db.prepare('SELECT * FROM turn_tools ORDER BY id DESC LIMIT ?').all(opts.limit ?? 50);
  return (rows as unknown as TurnRow[]).map(turnOf);
}

// ---- mistakes ---------------------------------------------------------------

/** Who found it: the user, the secretary itself, a review of a report, or a guard (hook, check script). */
export const MISTAKE_FINDERS = ['사용자', '비서', '검수', '장치'] as const;
/** Why it happened: ① no rule ② a rule not followed ③ missing information ④ a missing tool. */
export const MISTAKE_CAUSES = ['규칙 없음', '안 지킴', '정보 부족', '도구 부족'] as const;
export type MistakeFinder = (typeof MISTAKE_FINDERS)[number];
export type MistakeCause = (typeof MISTAKE_CAUSES)[number];

export interface Mistake {
  id: number;
  happened_at: string;
  session_id: string | null;
  what: string;
  /** 비서 / 업무 세션:<공간 이름> / run-job / 서브에이전트 / 상황판 */
  made_by: string;
  found_by: MistakeFinder;
  /** The group several mistakes of one kind share (e.g. "영어 답"). */
  group_name: string;
  cause: MistakeCause;
  /** Evidence conversation ids, "3146,3161". */
  log_ids: string;
  /** Where the rule is (AGENTS.md section, skill), '' when there is none. */
  rule_ref: string;
  harm: string;
  /** The guard the rule moved into (hook, script), '' while there is none. */
  guard: string;
  /** Eval set scenes that test it, "E1,E2". */
  eval_ids: string;
  /** 1 when the group had happened before (counted when it is recorded, or set directly by the secretary). */
  recurred: number;
  created_at: string;
}

export interface NewMistake {
  happenedAt?: string;
  sessionId?: string;
  what: string;
  madeBy: string;
  foundBy: MistakeFinder;
  group: string;
  cause: MistakeCause;
  logIds?: number[];
  ruleRef?: string;
  harm?: string;
  guard?: string;
  evalIds?: string[];
  /** Left out: 1 when an earlier mistake has the same group. */
  recurred?: boolean;
}

const joinIds = (xs: Array<number | string> | undefined) => (xs ?? []).map((x) => String(x).trim()).filter(Boolean).join(',');

export function recordMistake(db: DatabaseSync, m: NewMistake): Mistake {
  const what = m.what.trim();
  const group = m.group.trim();
  if (!what) throw new Error('what is empty');
  if (!group) throw new Error('group is empty');
  const t = m.happenedAt === undefined ? Date.parse(nowIso()) : Date.parse(m.happenedAt);
  if (Number.isNaN(t)) throw new Error(`happened_at is not a date: ${m.happenedAt}`);
  const at = new Date(t).toISOString();
  const before = db.prepare('SELECT count(*) AS n FROM mistakes WHERE group_name = ?').get(group) as { n: number };
  const recurred = m.recurred === undefined ? Number(before.n) > 0 : m.recurred;
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO mistakes (happened_at, session_id, what, made_by, found_by, group_name, cause, log_ids, rule_ref, harm, guard, eval_ids, recurred, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      at,
      m.sessionId ?? null,
      what,
      m.madeBy.trim(),
      m.foundBy,
      group,
      m.cause,
      joinIds(m.logIds),
      m.ruleRef?.trim() ?? '',
      m.harm?.trim() ?? '',
      m.guard?.trim() ?? '',
      joinIds(m.evalIds),
      recurred ? 1 : 0,
      nowIso(),
    );
  return getMistake(db, Number(lastInsertRowid))!;
}

export function getMistake(db: DatabaseSync, id: number): Mistake | undefined {
  return db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id) as Mistake | undefined;
}

/** The fields a later step fills in: the guard it moved into, the eval scenes, whether it came back. */
export function updateMistake(db: DatabaseSync, id: number, patch: { guard?: string; evalIds?: string[]; recurred?: boolean; harm?: string; ruleRef?: string }): Mistake | undefined {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  const set = (col: string, v: string | number) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (patch.guard !== undefined) set('guard', patch.guard.trim());
  if (patch.evalIds !== undefined) set('eval_ids', joinIds(patch.evalIds));
  if (patch.recurred !== undefined) set('recurred', patch.recurred ? 1 : 0);
  if (patch.harm !== undefined) set('harm', patch.harm.trim());
  if (patch.ruleRef !== undefined) set('rule_ref', patch.ruleRef.trim());
  if (sets.length) db.prepare(`UPDATE mistakes SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return getMistake(db, id);
}

export function listMistakes(db: DatabaseSync, opts: { group?: string; cause?: MistakeCause; limit?: number } = {}): Mistake[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.group) {
    where.push('group_name = ?');
    params.push(opts.group.trim());
  }
  if (opts.cause) {
    where.push('cause = ?');
    params.push(opts.cause);
  }
  return db
    .prepare(`SELECT * FROM mistakes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY happened_at DESC, id DESC LIMIT ?`)
    .all(...params, opts.limit ?? 50) as unknown as Mistake[];
}

/** Per group: how many, how many after the first, the latest time, and whether a guard holds it now. */
export function mistakeGroups(db: DatabaseSync): Array<{ group_name: string; n: number; recurred: number; last_at: string; guarded: number }> {
  return db
    .prepare(
      `SELECT group_name, count(*) AS n, sum(recurred) AS recurred, max(happened_at) AS last_at, max(guard <> '') AS guarded
       FROM mistakes GROUP BY group_name ORDER BY n DESC, last_at DESC`,
    )
    .all() as unknown as Array<{ group_name: string; n: number; recurred: number; last_at: string; guarded: number }>;
}
