/**
 * The situation board as saved in the database (meta): what deleting conversation (log/purge.ts, log/rewind.ts) needs of
 * it without the rewrite itself (session-continuity/situation-board.ts), so the log code does not lean on the board's code.
 */
import { nowIso } from '../core/kst-time.ts';
import type { Store } from './store.ts';

export const BOARD_KEY = 'situation_board';
/** When a board was emptied because conversation it had read was deleted; a rewrite started before that does not save. */
export const RESET_KEY = 'board_reset_at';
/** After such a reset the rewrite builds the board again from this many of the newest remaining rows. */
const RESET_REREAD_ROWS = 300;

export interface Board {
  text: string;
  lastLogId: number;
  updatedAt: string;
}

export function readBoard(store: Store): Board | undefined {
  return store.getJson<Board>(BOARD_KEY);
}

/** True when the board has read conversation from `logId` on (deleting it must empty the board). */
export function boardReflects(store: Store, logId: number): boolean {
  const board = readBoard(store);
  return !!board?.text && board.lastLogId >= logId;
}

/**
 * After conversation rows were deleted (log/purge.ts deleteLogRows: "비서 대화 삭제" or a rewind): a board that had read
 * them is emptied, so their content is not carried on, and the next rewrite (idle jobs, or a new session's first
 * prompt) builds it again from the last RESET_REREAD_ROWS remaining rows. Returns whether it was emptied.
 */
export function resetBoardAfterPurge(store: Store, minLogId: number): boolean {
  if (!boardReflects(store, minLogId)) return false;
  const nth = store.db.prepare('SELECT id FROM raw_log ORDER BY id DESC LIMIT 1 OFFSET ?').get(RESET_REREAD_ROWS - 1) as { id: number } | undefined;
  store.setJson(BOARD_KEY, { text: '', lastLogId: (nth?.id ?? 1) - 1, updatedAt: nowIso() } satisfies Board);
  store.setMeta(RESET_KEY, nowIso());
  return true;
}
