/**
 * 큰 일 판(big_work)을 읽고 쓰는 함수들. 줄마다 바뀔 때마다 새 행을 쌓아 이력을 남기고, 판의 크기 상한과 줄 모양(renderBigWork)을 정한다.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './schema.ts';
import { assertNoThreat } from '../memory/injection-screen.ts';
import { formatLocal, nowIso } from '../core/kst-time.ts';

/** Big-work states; the first four are on the board, 끝남 and 지움 take a work off it. */
export const BIG_WORK_STATES = ['진행 중', '사용자 차례', '보류', '운영 중', '끝남', '지움'] as const;
export type BigWorkState = (typeof BIG_WORK_STATES)[number];
const OFF_BOARD: ReadonlySet<BigWorkState> = new Set(['끝남', '지움']);
/** Hard caps (like the profile's): a board that outgrows them is an error, not silently cut. */
export const BIG_WORK_LIMITS = { nameChars: 40, noteChars: 60, active: 10, boardChars: 1200 };
/** Added to update_task's reply when a task ends, the moment a big work most often moves on. */
export const BIG_WORK_CHECK =
  '큰 일 판을 고칠지 확인: 이 업무로 큰 일 상태(진행 중·사용자 차례·보류·운영 중·끝남)가 바뀌었으면 set_big_work로 그 줄을 고친다.';
export interface BigWork {
  id: number;
  name: string;
  state: BigWorkState;
  note: string;
  source_log_id: number | null;
  created_at: string;
}

/** The board: each work's latest row, off-board states left out, in order of first appearance. */
export function bigWork(db: DatabaseSync): BigWork[] {
  const rows = db
    .prepare(
      `SELECT b.* FROM big_work b
       JOIN (SELECT name, MAX(id) AS last, MIN(id) AS first FROM big_work GROUP BY name) g ON b.id = g.last
       ORDER BY g.first`,
    )
    .all() as unknown as BigWork[];
  return rows.filter((r) => !OFF_BOARD.has(r.state));
}

/** Every change to one work, oldest first. */
export function bigWorkHistory(db: DatabaseSync, name: string): BigWork[] {
  return db.prepare('SELECT * FROM big_work WHERE name = ? ORDER BY id').all(name.trim()) as unknown as BigWork[];
}

/**
 * Adds, changes or removes (끝남/지움) one line of the board; the rest is untouched. Each call
 * appends a row, so the history stays. Returns null when nothing changed.
 */
export function setBigWork(
  db: DatabaseSync,
  input: { name: string; state: BigWorkState; note?: string; sourceLogId?: number; seenId?: number },
): BigWork | null {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const note = (input.note ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('큰 일 이름이 비어 있어요.');
  if (Array.from(name).length > BIG_WORK_LIMITS.nameChars) throw new Error(`큰 일 이름은 ${BIG_WORK_LIMITS.nameChars}자 안으로 써 주세요: ${name}`);
  if (Array.from(note).length > BIG_WORK_LIMITS.noteChars) throw new Error(`메모는 ${BIG_WORK_LIMITS.noteChars}자 안으로 써 주세요(지금 ${Array.from(note).length}자).`);
  if (!BIG_WORK_STATES.includes(input.state)) throw new Error(`상태는 ${BIG_WORK_STATES.join('·')} 중 하나예요: ${input.state}`);
  assertNoThreat(`${name} ${note}`, '큰 일 판');
  return transaction(db, () => {
    const current = db.prepare('SELECT * FROM big_work WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as BigWork | undefined;
    const onBoard = current && !OFF_BOARD.has(current.state);
    if (OFF_BOARD.has(input.state) && !onBoard) throw new Error(`판에 없는 큰 일이에요: ${name}. list_big_work로 이름을 확인하세요.`);
    // Optimistic lock: a line on the board is changed only by someone who saw its latest version.
    if (onBoard && input.seenId === undefined) {
      throw new Error(`판에 있는 큰 일은 seen_id(판 줄 앞의 [#번호])를 함께 주세요: ${name} (지금 #${current.id})`);
    }
    if (onBoard && input.seenId !== current.id) {
      throw new Error(
        `그 사이 이 줄이 바뀌었어요: ${name} (본 줄 #${input.seenId}, 지금 #${current.id} ${current.state}${current.note ? ` (${current.note})` : ''}). ` +
          'list_big_work로 다시 읽고, 그래도 고쳐야 하면 지금 번호로 다시 고치세요.',
      );
    }
    if (current && current.state === input.state && current.note === note) return null;
    const now = nowIso();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO big_work (name, state, note, source_log_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, input.state, note, input.sourceLogId ?? null, now);
    const board = bigWork(db);
    if (board.length > BIG_WORK_LIMITS.active) {
      throw new Error(`판에 큰 일이 ${board.length}개예요(상한 ${BIG_WORK_LIMITS.active}개). 끝난 일을 끝남·지움으로 먼저 빼 주세요.`);
    }
    const chars = renderBigWork(board).length;
    if (chars > BIG_WORK_LIMITS.boardChars) {
      throw new Error(`판이 ${chars}자예요(상한 ${BIG_WORK_LIMITS.boardChars}자). 메모를 줄이거나 끝난 일을 빼 주세요.`);
    }
    return { id: Number(lastInsertRowid), name, state: input.state, note, source_log_id: input.sourceLogId ?? null, created_at: now };
  });
}

/**
 * One line per work: `- <이름> — <상태> (<메모>) · <MM-DD> 갱신`. The date lets a reader doubt an old line.
 * With `ids`, each line starts with `[#<row id>]`, the seen_id set_big_work asks for.
 */
export function renderBigWork(rows: BigWork[], { ids = false } = {}): string {
  return rows
    .map((r) => `- ${ids ? `[#${r.id}] ` : ''}${r.name} — ${r.state}${r.note ? ` (${r.note})` : ''} · ${formatLocal(r.created_at, true).slice(5)} 갱신`)
    .join('\n');
}
