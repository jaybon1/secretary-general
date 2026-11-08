/**
 * 대화 기록(raw_log)을 읽고 쓰는 함수들. 대화 저장·검색, 세션별 앞뒤 대화, 기억 정리가 어디까지 읽었는지(정리 표시)를 다룬다.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './schema.ts';
import { getMeta, setMeta } from './meta-usage.ts';
import { ftsQuery, indexText, queryTerms } from '../memory/korean-terms.ts';

export interface LogEntry {
  id: number;
  session_id: string;
  message_uuid: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

const CONSOLIDATED_KEY = 'consolidated_through_log_id';

/** Idempotent: entries already archived (same message_uuid) are skipped, and so are entries the user deleted (purged_log_ids). */
export function appendLog(db: DatabaseSync, entries: Array<Omit<LogEntry, 'id'>>): number {
  if (entries.length === 0) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO raw_log (session_id, message_uuid, role, content, created_at)
     SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM purged_log_ids WHERE message_uuid = ?)`,
  );
  const index = db.prepare('INSERT INTO raw_log_fts (rowid, terms) VALUES (?, ?)');
  return transaction(db, () => {
    let added = 0;
    for (const e of entries) {
      const { changes, lastInsertRowid } = insert.run(e.session_id, e.message_uuid, e.role, e.content, e.created_at, e.message_uuid);
      if (Number(changes) === 0) continue;
      index.run(Number(lastInsertRowid), indexText(e.content));
      added++;
    }
    return added;
  });
}

export function searchLog(db: DatabaseSync, query: string, opts: { limit: number; sessionId?: string }): Array<LogEntry & { rank: number }> {
  const match = ftsQuery(queryTerms(query));
  if (!match) return [];
  const params: Array<string | number> = [match];
  let sessionFilter = '';
  if (opts.sessionId) {
    sessionFilter = 'AND l.session_id = ?';
    params.push(opts.sessionId);
  }
  return db
    .prepare(
      `SELECT l.*, bm25(raw_log_fts) AS rank
       FROM raw_log_fts JOIN raw_log l ON l.id = raw_log_fts.rowid
       WHERE raw_log_fts MATCH ? ${sessionFilter}
       ORDER BY rank LIMIT ?`,
    )
    .all(...params, opts.limit) as unknown as Array<LogEntry & { rank: number }>;
}

/**
 * Run after a turn is archived: memories saved during the turn (created after its prompt
 * and not yet linked) point at that prompt, so their source conversation can be opened later.
 */
export function linkTurnMemories(db: DatabaseSync, sessionId: string): number {
  const prompt = db
    .prepare("SELECT id, created_at FROM raw_log WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { id: number; created_at: string } | undefined;
  if (!prompt) return 0;
  const { changes } = db
    .prepare('UPDATE memories SET source_log_id = ?, source_session = ? WHERE source_log_id IS NULL AND created_at >= ?')
    .run(prompt.id, sessionId, new Date(Date.parse(prompt.created_at)).toISOString());
  return Number(changes);
}

/** One logged row without its text: what lists of rows to delete show. */
export interface LogRowInfo {
  id: number;
  session_id: string;
  message_uuid: string;
  role: 'user' | 'assistant';
  chars: number;
  created_at: string;
}

/** Log rows of these transcript messages (a recap's derived uuid included), oldest first, without their text. */
export function logInfoByUuids(db: DatabaseSync, uuids: string[]): LogRowInfo[] {
  const get = db.prepare('SELECT id, session_id, message_uuid, role, length(content) AS chars, created_at FROM raw_log WHERE message_uuid IN (?, ?)');
  const rows = uuids.flatMap((u) => get.all(u, `${u}:recap`) as unknown as LogRowInfo[]);
  return [...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id);
}

/** Still-valid memories linked to these log entries, or among `ids`, with when they were saved. */
export function memoriesForRewind(db: DatabaseSync, logIds: number[], ids: number[]): Array<{ id: number; created_at: string }> {
  const byLog = db.prepare('SELECT id, created_at FROM memories WHERE source_log_id = ? AND valid_to IS NULL');
  const byId = db.prepare('SELECT id, created_at FROM memories WHERE id = ? AND valid_to IS NULL');
  const rows = [...logIds.flatMap((i) => byLog.all(i)), ...ids.flatMap((i) => byId.all(i))] as Array<{ id: number; created_at: string }>;
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}

/**
 * Removes log entries for good (log/purge.ts deleteLogRows: rows the user deleted, or a branch a rewind abandoned) and
 * invalidates `forgetIds` in one transaction. The rows' identifiers go on purged_log_ids, so ingest never logs them
 * again. Memories and big-work rows that pointed at a removed entry lose the link (the row is gone).
 * raw_log ids are never handed out again (AUTOINCREMENT, migration 11), so no watermark needs to move.
 */
export function dropLogEntries(db: DatabaseSync, logIds: number[], forgetIds: number[], reason: string, at: string): { forgotten: number[] } {
  return transaction(db, () => {
    const invalidate = db.prepare('UPDATE memories SET valid_to = ?, invalid_reason = ?, superseded_by = NULL WHERE id = ? AND valid_to IS NULL');
    const forgotten = forgetIds.filter((id) => Number(invalidate.run(at, reason, id).changes) > 0);
    const block = db.prepare('INSERT OR REPLACE INTO purged_log_ids (message_uuid, log_id, session_id, purged_at) SELECT message_uuid, id, session_id, ? FROM raw_log WHERE id = ?');
    const unlinkMemory = db.prepare('UPDATE memories SET source_log_id = NULL WHERE source_log_id = ?');
    const unlinkBigWork = db.prepare('UPDATE big_work SET source_log_id = NULL WHERE source_log_id = ?');
    const unindex = db.prepare('DELETE FROM raw_log_fts WHERE rowid = ?');
    const remove = db.prepare('DELETE FROM raw_log WHERE id = ?');
    for (const id of logIds) {
      block.run(at, id);
      unlinkMemory.run(id);
      unlinkBigWork.run(id);
      unindex.run(id);
      remove.run(id);
    }
    return { forgotten };
  });
}

/** The conversation around one log entry, within its session, oldest first. */
export function logAround(db: DatabaseSync, logId: number, before: number, after: number): LogEntry[] {
  const center = db.prepare('SELECT session_id FROM raw_log WHERE id = ?').get(logId) as { session_id: string } | undefined;
  if (!center) return [];
  const earlier = db
    .prepare('SELECT * FROM raw_log WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(center.session_id, logId, before) as unknown as LogEntry[];
  const rest = db
    .prepare('SELECT * FROM raw_log WHERE session_id = ? AND id >= ? ORDER BY id LIMIT ?')
    .all(center.session_id, logId, after + 1) as unknown as LogEntry[];
  return [...earlier.reverse(), ...rest];
}

/** The most recently active session other than `excludeId`, with its last entry time. */
export function lastOtherSession(db: DatabaseSync, excludeId?: string): { session_id: string; last_at: string } | undefined {
  return db
    .prepare('SELECT session_id, created_at AS last_at FROM raw_log WHERE session_id != ? ORDER BY id DESC LIMIT 1')
    .get(excludeId ?? '') as { session_id: string; last_at: string } | undefined;
}

/** The last `n` entries of a session (id or 8-char prefix), oldest first. */
export function sessionTail(db: DatabaseSync, sessionId: string, n: number, role?: 'user' | 'assistant'): LogEntry[] {
  const rows = db
    .prepare(`SELECT * FROM raw_log WHERE session_id LIKE ? ${role ? 'AND role = ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(role ? [`${sessionId}%`, role, n] : [`${sessionId}%`, n])) as unknown as LogEntry[];
  return rows.reverse();
}

/** A session's entries with id in (afterId, beforeId), oldest first. */
export function sessionBetween(db: DatabaseSync, sessionId: string, afterId: number, beforeId: number, role?: 'user' | 'assistant'): LogEntry[] {
  return db
    .prepare(`SELECT * FROM raw_log WHERE session_id LIKE ? AND id > ? AND id < ? ${role ? 'AND role = ?' : ''} ORDER BY id`)
    .all(...(role ? [`${sessionId}%`, afterId, beforeId, role] : [`${sessionId}%`, afterId, beforeId])) as unknown as LogEntry[];
}

/** When the newest log entry was written (any session), or undefined for an empty log. */
export function lastLogAt(db: DatabaseSync): string | undefined {
  return (db.prepare('SELECT max(created_at) AS t FROM raw_log').get() as { t: string | null }).t ?? undefined;
}

/** Every log entry after `logId`, across sessions, oldest first. */
export function logAfter(db: DatabaseSync, logId: number): LogEntry[] {
  return db.prepare('SELECT * FROM raw_log WHERE id > ? ORDER BY id').all(logId) as unknown as LogEntry[];
}

// ---- consolidation watermark ----------------------------------------------

/** Log entries after the consolidation watermark, oldest first. */
export function unconsolidatedLog(db: DatabaseSync, limit: number): LogEntry[] {
  return db.prepare('SELECT * FROM raw_log WHERE id > ? ORDER BY id LIMIT ?').all(consolidatedThrough(db), limit) as unknown as LogEntry[];
}

export function consolidatedThrough(db: DatabaseSync): number {
  return Number(getMeta(db, CONSOLIDATED_KEY) ?? 0);
}

export function markConsolidated(db: DatabaseSync, throughLogId: number): void {
  if (throughLogId < consolidatedThrough(db)) {
    throw new Error(`watermark only moves forward (currently ${consolidatedThrough(db)})`);
  }
  setMeta(db, CONSOLIDATED_KEY, String(throughLogId));
}
