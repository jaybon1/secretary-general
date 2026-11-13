/**
 * 주요 현안(main_agenda)을 읽고 쓰는 함수들. 줄마다 바뀔 때마다 새 행을 쌓아 이력을 남기고, 주요 현안의 크기 상한과 줄 모양(renderMainAgenda)을 정한다.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './schema.ts';
import { assertNoThreat } from '../memory/injection-screen.ts';
import { userWords } from './user-title.ts';
import { formatLocal, nowIso } from '../core/kst-time.ts';

/** Main-agenda states; the first four are on the board, 끝남 and 지움 take a work off it. */
export const MAIN_AGENDA_STATES = ['진행 중', '사용자 차례', '보류', '운영 중', '끝남', '지움'] as const;
export type MainAgendaState = (typeof MAIN_AGENDA_STATES)[number];
const OFF_BOARD: ReadonlySet<MainAgendaState> = new Set(['끝남', '지움']);
/** Hard caps (like the profile's): a board that outgrows them is an error, not silently cut. */
export const MAIN_AGENDA_LIMITS = { nameChars: 40, noteChars: 60, active: 10, boardChars: 1200 };
/** Added to update_task's reply when a task ends, the moment a main-agenda item most often moves on. */
export const MAIN_AGENDA_CHECK =
  '주요 현안을 고칠지 확인: 이 업무로 안건 상태(진행 중·사용자 차례·보류·운영 중·끝남)가 바뀌었으면 set_main_agenda로 그 줄을 고친다.';
export interface MainAgenda {
  id: number;
  name: string;
  state: MainAgendaState;
  note: string;
  source_log_id: number | null;
  created_at: string;
}

/** The board: each work's latest row, off-board states left out, in order of first appearance. */
export function mainAgenda(db: DatabaseSync): MainAgenda[] {
  const rows = db
    .prepare(
      `SELECT b.* FROM main_agenda b
       JOIN (SELECT name, MAX(id) AS last, MIN(id) AS first FROM main_agenda GROUP BY name) g ON b.id = g.last
       ORDER BY g.first`,
    )
    .all() as unknown as MainAgenda[];
  return rows.filter((r) => !OFF_BOARD.has(r.state));
}

/** Every change to one work, oldest first. */
export function mainAgendaHistory(db: DatabaseSync, name: string): MainAgenda[] {
  return db.prepare('SELECT * FROM main_agenda WHERE name = ? ORDER BY id').all(name.trim()) as unknown as MainAgenda[];
}

/**
 * Adds, changes or removes (끝남/지움) one line of the board; the rest is untouched. Each call
 * appends a row, so the history stays. Returns null when nothing changed.
 */
export function setMainAgenda(
  db: DatabaseSync,
  input: { name: string; state: MainAgendaState; note?: string; sourceLogId?: number; seenId?: number },
): MainAgenda | null {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const note = (input.note ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('안건 이름이 비어 있어요.');
  if (Array.from(name).length > MAIN_AGENDA_LIMITS.nameChars) throw new Error(`안건 이름은 ${MAIN_AGENDA_LIMITS.nameChars}자 안으로 써 주세요: ${name}`);
  if (Array.from(note).length > MAIN_AGENDA_LIMITS.noteChars) throw new Error(`메모는 ${MAIN_AGENDA_LIMITS.noteChars}자 안으로 써 주세요(지금 ${Array.from(note).length}자).`);
  if (!MAIN_AGENDA_STATES.includes(input.state)) throw new Error(`상태는 ${MAIN_AGENDA_STATES.join('·')} 중 하나예요: ${input.state}`);
  assertNoThreat(`${name} ${note}`, '주요 현안', userWords(db));
  return transaction(db, () => {
    const current = db.prepare('SELECT * FROM main_agenda WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as MainAgenda | undefined;
    const onBoard = current && !OFF_BOARD.has(current.state);
    if (OFF_BOARD.has(input.state) && !onBoard) throw new Error(`주요 현안에 없는 안건이에요: ${name}. list_main_agenda로 이름을 확인하세요.`);
    // Optimistic lock: a line on the board is changed only by someone who saw its latest version.
    if (onBoard && input.seenId === undefined) {
      throw new Error(`주요 현안에 있는 안건은 seen_id(줄 앞의 [#번호])를 함께 주세요: ${name} (지금 #${current.id})`);
    }
    if (onBoard && input.seenId !== current.id) {
      throw new Error(
        `그 사이 이 줄이 바뀌었어요: ${name} (본 줄 #${input.seenId}, 지금 #${current.id} ${current.state}${current.note ? ` (${current.note})` : ''}). ` +
          'list_main_agenda로 다시 읽고, 그래도 고쳐야 하면 지금 번호로 다시 고치세요.',
      );
    }
    if (current && current.state === input.state && current.note === note) return null;
    const now = nowIso();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO main_agenda (name, state, note, source_log_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, input.state, note, input.sourceLogId ?? null, now);
    const board = mainAgenda(db);
    if (board.length > MAIN_AGENDA_LIMITS.active) {
      throw new Error(`주요 현안에 안건이 ${board.length}개예요(상한 ${MAIN_AGENDA_LIMITS.active}개). 끝난 일을 끝남·지움으로 먼저 빼 주세요.`);
    }
    const chars = renderMainAgenda(board).length;
    if (chars > MAIN_AGENDA_LIMITS.boardChars) {
      throw new Error(`주요 현안이 ${chars}자예요(상한 ${MAIN_AGENDA_LIMITS.boardChars}자). 메모를 줄이거나 끝난 일을 빼 주세요.`);
    }
    return { id: Number(lastInsertRowid), name, state: input.state, note, source_log_id: input.sourceLogId ?? null, created_at: now };
  });
}

/**
 * One line per work: `- <이름> — <상태> (<메모>) · <MM-DD> 갱신`. The date lets a reader doubt an old line.
 * With `ids`, each line starts with `[#<row id>]`, the seen_id set_main_agenda asks for.
 */
export function renderMainAgenda(rows: MainAgenda[], { ids = false } = {}): string {
  return rows
    .map((r) => `- ${ids ? `[#${r.id}] ` : ''}${r.name} — ${r.state}${r.note ? ` (${r.note})` : ''} · ${formatLocal(r.created_at, true).slice(5)} 갱신`)
    .join('\n');
}
