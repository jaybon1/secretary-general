/**
 * Deleting conversation rows (log/purge.ts "비서 대화 삭제", and a branch a rewind abandoned, log/rewind.ts) and putting
 * them back from the quarantine file. What a deletion does is told at the top of log/purge.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resetBoardAfterPurge } from '../store/board-state.ts';
import { dropQuestionsFrom } from '../store/open-questions.ts';
import { transaction } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { nowIso } from '../core/kst-time.ts';
import { indexText } from '../store/search-terms.ts';

export const QUARANTINE_FILE = 'purged-log-error.db';

export interface PurgeResult {
  quarantine: string;
  deleted: number[];
  forgotten: number[];
  boardReset: boolean;
  questions: string[];
}

/** The quarantine file beside the DB: backups/error/, out of the daily backups (backup-db.ps1 reads backups/ itself only). */
export function quarantinePath(store: Store): string {
  return path.join(path.dirname(store.db.location() ?? '.'), 'backups', 'error', QUARANTINE_FILE);
}

const QUARANTINE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS purged.quarantined_log (
    seq          INTEGER PRIMARY KEY,
    log_id       INTEGER NOT NULL,
    session_id   TEXT NOT NULL,
    message_uuid TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    purged_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS purged.quarantined_log_uuid ON quarantined_log (message_uuid, seq);
  CREATE TRIGGER IF NOT EXISTS purged.quarantined_log_no_update BEFORE UPDATE ON quarantined_log
    BEGIN SELECT RAISE(ABORT, 'quarantined_log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS purged.quarantined_log_no_delete BEFORE DELETE ON quarantined_log
    BEGIN SELECT RAISE(ABORT, 'quarantined_log is append-only'); END;
`;

/** Runs `fn` with the quarantine attached as `purged` (made if missing unless `mustExist`). */
function withQuarantine<T>(store: Store, fn: () => T, mustExist = false): T {
  const file = quarantinePath(store);
  if (mustExist && !fs.existsSync(file)) throw new Error(`격리 DB가 없어요(지웠다면 되돌릴 수 없어요): ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store.db.prepare('ATTACH DATABASE ? AS purged').run(file);
  try {
    store.db.exec(QUARANTINE_SCHEMA);
    return fn();
  } finally {
    store.db.exec('DETACH DATABASE purged');
  }
}

/**
 * The one way rows leave raw_log, for "비서 대화 삭제" (executePurge) and for a branch a rewind abandoned
 * (log/rewind.ts cleanRewound); the two differ only in how they choose rows and memories. The rows are copied into
 * the quarantine first and committed there on their own, so a failure in between leaves them in both places
 * rather than in neither; then one transaction in the main DB removes them, blocks their identifiers and
 * invalidates the memories; then the file traces go, and the board and open questions that came from them.
 * With no rows, only the memories are invalidated.
 */
export function deleteLogRows(store: Store, logIds: number[], memoryIds: number[], reason: string): PurgeResult {
  const ids = [...new Set(logIds)].sort((a, b) => a - b);
  const at = nowIso();
  if (!ids.length) {
    const { forgotten } = store.dropLogRows([], memoryIds, reason, at);
    return { quarantine: '', deleted: [], forgotten, boardReset: false, questions: [] };
  }
  const json = JSON.stringify(ids);
  const present = Number((store.db.prepare('SELECT count(*) AS n FROM raw_log WHERE id IN (SELECT value FROM json_each(?))').get(json) as { n: number }).n);
  if (present !== ids.length) throw new Error(`지울 줄 ${ids.length}개 중 ${present}개만 남아 있어요. 목록을 다시 보세요.`);
  withQuarantine(store, () => {
    const copied = transaction(store.db, () =>
      Number(
        store.db
          .prepare(
            `INSERT INTO purged.quarantined_log (log_id, session_id, message_uuid, role, content, created_at, purged_at)
             SELECT id, session_id, message_uuid, role, content, created_at, ? FROM main.raw_log WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          )
          .run(at, json).changes,
      ),
    );
    if (copied !== ids.length) throw new Error(`격리 DB에 ${ids.length}줄 중 ${copied}줄만 옮겨져 지우지 않았어요.`);
  });
  // The text must not stay in the main DB file: freed pages are zeroed, the search index's old segments merged
  // away, and the WAL written back (best effort: an open reader can keep it from being emptied).
  const secure = (store.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete;
  store.db.exec('PRAGMA secure_delete = ON');
  // The board and open questions are rewritten inside the same window: their old text came from these rows.
  let forgotten: number[];
  let boardReset: boolean;
  let questions: string[];
  try {
    ({ forgotten } = store.dropLogRows(ids, memoryIds, reason, at));
    store.db.exec("INSERT INTO raw_log_fts (raw_log_fts) VALUES ('optimize')");
    boardReset = resetBoardAfterPurge(store, ids[0]);
    questions = dropQuestionsFrom(store, ids);
  } finally {
    store.db.exec(`PRAGMA secure_delete = ${secure ? 'ON' : 'OFF'}`);
  }
  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Busy: the next automatic checkpoint writes it back.
  }
  return { quarantine: quarantinePath(store), deleted: ids, forgotten, boardReset, questions };
}

export interface RestoreRow {
  logId: number;
  /** The id it has again; another when its old id was taken by a newer row meanwhile. */
  newId?: number;
  role: string;
  chars: number;
  created_at: string;
  state: 'restore' | 'restored' | 'in-log';
}

/**
 * Puts quarantined rows (log ids from..to, the latest copy of each) back into the log and off the block list.
 * The text moves inside SQLite; only the search index needs it in memory here, and it is never printed.
 * Memories invalidated by the deletion stay invalidated, and the board is not rewritten for them.
 */
export function restorePurged(store: Store, from: number, to: number, dryRun = true): RestoreRow[] {
  return withQuarantine(
    store,
    () => {
      const rows = store.db
        .prepare(
          `SELECT q.seq, q.log_id, q.message_uuid, q.role, length(q.content) AS chars, q.created_at FROM purged.quarantined_log q
           WHERE q.log_id BETWEEN ? AND ? AND q.seq = (SELECT max(seq) FROM purged.quarantined_log WHERE message_uuid = q.message_uuid)
           ORDER BY q.log_id`,
        )
        .all(from, to) as Array<{ seq: number; log_id: number; message_uuid: string; role: string; chars: number; created_at: string }>;
      const inLog = store.db.prepare('SELECT 1 FROM main.raw_log WHERE message_uuid = ?');
      const out: RestoreRow[] = rows.map((r) => ({ logId: r.log_id, role: r.role, chars: r.chars, created_at: r.created_at, state: inLog.get(r.message_uuid) ? 'in-log' : 'restore' }));
      if (dryRun) return out;
      transaction(store.db, () => {
        const taken = store.db.prepare('SELECT 1 FROM main.raw_log WHERE id = ?');
        const insert = store.db.prepare(
          'INSERT INTO main.raw_log (id, session_id, message_uuid, role, content, created_at) SELECT ?, session_id, message_uuid, role, content, created_at FROM purged.quarantined_log WHERE seq = ?',
        );
        const text = store.db.prepare('SELECT content FROM main.raw_log WHERE id = ?');
        const index = store.db.prepare('INSERT INTO main.raw_log_fts (rowid, terms) VALUES (?, ?)');
        const unblock = store.db.prepare('DELETE FROM main.purged_log_ids WHERE message_uuid = ?');
        rows.forEach((r, i) => {
          if (out[i].state !== 'restore') return;
          const id = Number(insert.run(taken.get(r.log_id) ? null : r.log_id, r.seq).lastInsertRowid);
          index.run(id, indexText((text.get(id) as { content: string }).content));
          unblock.run(r.message_uuid);
          out[i] = { ...out[i], newId: id, state: 'restored' };
        });
      });
      return out;
    },
    true,
  );
}
