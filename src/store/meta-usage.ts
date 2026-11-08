/**
 * meta 표(이름-값 저장)와 사용량 기록(usage_log)을 읽고 쓰는 함수들. "한 번만 알리기" 표시, 세션별 값 정리, 자동 주입한 기억 번호를 다룬다.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/kst-time.ts';

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** A meta value stored as JSON (see setJson). */
export function getJson<T>(db: DatabaseSync, key: string): T | undefined {
  const raw = getMeta(db, key);
  return raw ? (JSON.parse(raw) as T) : undefined;
}

export function setJson(db: DatabaseSync, key: string, value: unknown): void {
  setMeta(db, key, JSON.stringify(value));
}

/**
 * The "tell once" notices: true (and `mark` saved under `key`) unless the saved mark already
 * covers this one (`covered`, by default: the same mark).
 */
export function markOnce(
  db: DatabaseSync,
  key: string,
  mark: string,
  covered: (last: string) => boolean = (last) => last === mark,
): boolean {
  const last = getMeta(db, key);
  if (last !== undefined && covered(last)) return false;
  setMeta(db, key, mark);
  return true;
}

/** Drops per-session meta keys (prefix + session id) of sessions with nothing logged for `idleMs`. Returns how many. */
export function pruneSessionMeta(db: DatabaseSync, prefixes: string[], idleMs: number, now = Date.now()): number {
  const cutoff = new Date(now - idleMs).toISOString();
  const lastLog = db.prepare('SELECT max(created_at) AS at FROM raw_log WHERE session_id = ?');
  let n = 0;
  for (const prefix of prefixes) {
    for (const { key } of metaWithPrefix(db, prefix)) {
      const at = (lastLog.get(key.slice(prefix.length)) as { at: string | null }).at;
      if (at && at < cutoff) {
        deleteMeta(db, key);
        n++;
      }
    }
  }
  return n;
}

export function deleteMeta(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

export function metaWithPrefix(db: DatabaseSync, prefix: string): Array<{ key: string; value: string }> {
  return db.prepare("SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\'").all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) as Array<{
    key: string;
    value: string;
  }>;
}

// ---- usage log ------------------------------------------------------------

export function logUsage(db: DatabaseSync, event: string, tokens: number, detail?: unknown): void {
  db.prepare('INSERT INTO usage_log (event, tokens, detail, created_at) VALUES (?, ?, ?, ?)').run(
    event,
    tokens,
    detail === undefined ? null : JSON.stringify(detail),
    nowIso(),
  );
}

/**
 * Memory ids auto-injected into this session since its context was last
 * reset (/clear, compaction). Those are still in the conversation, so
 * injecting them again would only pay for them twice.
 */
export function injectedIds(db: DatabaseSync, sessionId: string): Set<number> {
  const rows = db
    .prepare(
      `SELECT detail FROM usage_log
       WHERE event = 'auto_recall' AND json_extract(detail, '$.session') = ?1
         AND id > coalesce((SELECT max(id) FROM usage_log
                            WHERE event = 'context_reset' AND json_extract(detail, '$.session') = ?1), 0)`,
    )
    .all(sessionId) as Array<{ detail: string }>;
  const ids = new Set<number>();
  for (const r of rows) for (const id of (JSON.parse(r.detail) as { ids?: number[] }).ids ?? []) ids.add(id);
  return ids;
}
