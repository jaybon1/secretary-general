/**
 * 기억(memories)과 핵심 프로필(profile)을 DB에 읽고 쓰는 함수들. 저장·무효 처리·검색 후보·의미 검색 벡터·주제 수를 다룬다.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { BUDGET } from '../core/config.ts';
import { transaction } from './schema.ts';
import { assertNoThreat } from '../memory/injection-screen.ts';
import { userWords } from './user-title.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { ftsQuery, indexText, queryTerms } from '../memory/search-terms.ts';
import { nowIso } from '../core/kst-time.ts';
import { redactSecrets } from '../core/secret-mask.ts';

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'event', 'task', 'person', 'note', 'summary'] as const;

/** A topic (first tag) gets a summary memory once it has this many active memories. */
export const SUMMARY_MIN_MEMORIES = 10;
/** Topics too broad for one summary; left out until they are split into narrower tags. */
export const SUMMARY_SKIP_TOPICS: ReadonlySet<string> = new Set(['비서']);
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: number;
  kind: MemoryKind;
  content: string;
  tags: string;
  importance: number;
  valid_from: string;
  valid_to: string | null;
  superseded_by: number | null;
  invalid_reason: string | null;
  source_session: string | null;
  source_log_id: number | null;
  created_at: string;
  last_accessed_at: string | null;
  access_count: number;
}

export interface Profile {
  version: number;
  content: string;
  reason: string | null;
  tokens: number;
  created_at: string;
}

export interface NewMemory {
  kind: MemoryKind;
  content: string;
  tags?: string[];
  importance?: number;
  validFrom?: string;
  /** Ids of memories this one replaces; they are invalidated, not deleted. */
  supersedes?: number[];
  sourceSession?: string;
  sourceLogId?: number;
  /**
   * The highest memory id the caller's duplicate check saw. If another writer saved a memory
   * since, the insert is refused with MemoryRaceError so the caller checks again (optimistic lock).
   */
  expectMaxId?: number;
}

/** Another writer saved a memory between the caller's duplicate check and its insert. */
export class MemoryRaceError extends Error {}

// ---- memories -------------------------------------------------------------

export function remember(db: DatabaseSync, input: NewMemory): { id: number; superseded: number[] } {
  const content = redactSecrets(input.content.trim());
  if (!content) throw new Error('content is empty');
  assertNoThreat(content, '기억', userWords(db));
  const tags = normalizeTags(input.tags);
  const now = nowIso();
  // Store every timestamp as UTC ISO so ordering and display stay consistent.
  const t = input.validFrom === undefined ? Date.parse(now) : Date.parse(input.validFrom);
  if (Number.isNaN(t)) throw new Error(`valid_from is not a date: ${input.validFrom}`);
  const validFrom = new Date(t).toISOString();

  return transaction(db, () => {
    if (input.expectMaxId !== undefined && maxMemoryId(db) > input.expectMaxId) {
      throw new MemoryRaceError(`memory saved by another writer after #${input.expectMaxId}`);
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO memories (kind, content, tags, importance, valid_from, source_session, source_log_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        content,
        tags,
        input.importance ?? 3,
        validFrom,
        input.sourceSession ?? null,
        input.sourceLogId ?? null,
        now,
      );
    const id = Number(lastInsertRowid);
    db.prepare('INSERT INTO memories_fts (rowid, terms) VALUES (?, ?)').run(id, indexText(content, tags));

    const superseded: number[] = [];
    for (const oldId of input.supersedes ?? []) {
      if (oldId === id) continue;
      if (invalidateInTx(db, oldId, `superseded by #${id}`, id, now)) superseded.push(oldId);
    }
    return { id, superseded };
  });
}

export function maxMemoryId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT max(id) AS n FROM memories').get() as { n: number | null }).n ?? 0);
}

/**
 * Active memories (summaries left out) among `ids` saved after `sinceIso`: the candidates
 * a new memory may be repeating.
 */
export function recentMemories(db: DatabaseSync, ids: number[], sinceIso: string): Memory[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT * FROM memories WHERE id IN (${ids.map(() => '?').join(',')})
       AND valid_to IS NULL AND kind != 'summary' AND created_at >= ? ORDER BY id`,
    )
    .all(...ids, sinceIso) as unknown as Memory[];
}

/** Marks a memory as no longer true. History is kept; it just stops being recalled. */
export function forget(db: DatabaseSync, id: number, reason: string): boolean {
  return transaction(db, () => invalidateInTx(db, id, reason, null, nowIso()));
}

function invalidateInTx(db: DatabaseSync, id: number, reason: string, supersededBy: number | null, at: string): boolean {
  const { changes } = db
    .prepare(
      `UPDATE memories SET valid_to = ?, invalid_reason = ?, superseded_by = ?
       WHERE id = ? AND valid_to IS NULL`,
    )
    .run(at, reason, supersededBy, id);
  return Number(changes) > 0;
}

export function getMemory(db: DatabaseSync, id: number): Memory | undefined {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
}

export function listMemories(
  db: DatabaseSync,
  opts: { kind?: MemoryKind; topic?: string; includeInvalid?: boolean; limit?: number } = {},
): Memory[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (!opts.includeInvalid) where.push('valid_to IS NULL');
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.topic) {
    // The topic is the first tag.
    where.push("(tags = ? OR substr(tags, 1, length(?) + 1) = ? || ' ')");
    const t = opts.topic.trim().toLowerCase();
    params.push(t, t, t);
  }
  const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, opts.limit ?? 50) as unknown as Memory[];
}

/** Full-text candidates, best bm25 first. `rank` is FTS5 bm25 (lower = better). */
export function searchMemories(
  db: DatabaseSync,
  query: string,
  opts: { includeInvalid?: boolean; limit: number },
): Array<Memory & { rank: number }> {
  const match = ftsQuery(queryTerms(query));
  if (!match) return [];
  return db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS rank
       FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? ${opts.includeInvalid ? '' : 'AND m.valid_to IS NULL'}
       ORDER BY rank LIMIT ?`,
    )
    .all(match, opts.limit) as unknown as Array<Memory & { rank: number }>;
}

/** Document frequency of each term across all indexed memories, plus the corpus size. */
export function corpusStats(db: DatabaseSync, terms: string[]): { docCount: number; docFreq: Map<string, number> } {
  const docCount = Number((db.prepare('SELECT count(*) n FROM memories_fts').get() as { n: number }).n);
  const docFreq = new Map<string, number>();
  if (terms.length > 0) {
    const rows = db
      .prepare(`SELECT term, doc FROM memories_vocab WHERE term IN (${terms.map(() => '?').join(',')})`)
      .all(...terms) as Array<{ term: string; doc: number }>;
    for (const r of rows) docFreq.set(r.term, Number(r.doc));
  }
  return { docCount, docFreq };
}

export function memoriesWithoutVector(db: DatabaseSync, model: string): Array<{ id: number; content: string; tags: string }> {
  return db
    .prepare(
      `SELECT m.id, m.content, m.tags FROM memories m
       LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ?
       WHERE v.memory_id IS NULL ORDER BY m.id`,
    )
    .all(model) as Array<{ id: number; content: string; tags: string }>;
}

/** Removes vectors left by an earlier model or embedding input. */
export function dropVectorsExcept(db: DatabaseSync, model: string): void {
  db.prepare('DELETE FROM memory_vectors WHERE model != ?').run(model);
}

export function saveVectors(db: DatabaseSync, model: string, rows: Array<{ id: number; vector: Float32Array }>): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO memory_vectors (memory_id, model, vector) VALUES (?, ?, ?)');
  transaction(db, () => {
    for (const r of rows) stmt.run(r.id, model, new Uint8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength));
  });
}

/** Active memories per topic (first tag), summaries not counted, with the topic's current summary id if any. */
export function topics(
  db: DatabaseSync,
): Array<{ topic: string; count: number; summaryId: number | null; summaryAt: string | null; latestAt: string }> {
  const rows = db
    .prepare('SELECT id, kind, tags, created_at FROM memories WHERE valid_to IS NULL ORDER BY id')
    .all() as Array<{ id: number; kind: string; tags: string; created_at: string }>;
  const by = new Map<string, { topic: string; count: number; summaryId: number | null; summaryAt: string | null; latestAt: string }>();
  for (const r of rows) {
    const topic = r.tags.split(' ')[0];
    if (!topic) continue;
    const t = by.get(topic) ?? { topic, count: 0, summaryId: null, summaryAt: null, latestAt: '' };
    if (r.kind === 'summary') {
      t.summaryId = r.id;
      t.summaryAt = r.created_at;
    } else {
      t.count++;
      if (r.created_at > t.latestAt) t.latestAt = r.created_at;
    }
    by.set(topic, t);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

export function vectors(db: DatabaseSync, model: string, includeInvalid = false): Array<{ id: number; vector: Float32Array }> {
  const rows = db
    .prepare(
      `SELECT v.memory_id AS id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
       WHERE v.model = ? ${includeInvalid ? '' : 'AND m.valid_to IS NULL'}`,
    )
    .all(model) as Array<{ id: number; vector: Uint8Array }>;
  return rows.map((r) => ({ id: r.id, vector: new Float32Array(r.vector.slice().buffer) })); // copy: the blob may not be 4-byte aligned
}

export function touch(db: DatabaseSync, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?');
  const now = nowIso();
  transaction(db, () => {
    for (const id of ids) stmt.run(now, id);
  });
}

/** Active memories saved in a session (linked by the Stop hook or /consolidate). */
export function sessionMemoryIds(db: DatabaseSync, sessionId: string): number[] {
  return (
    db.prepare('SELECT id FROM memories WHERE source_session = ? AND valid_to IS NULL ORDER BY id').all(sessionId) as Array<{ id: number }>
  ).map((r) => r.id);
}

export function normalizeTags(tags: string[] | undefined): string {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].join(' ');
}

// ---- profile --------------------------------------------------------------

export function getProfile(db: DatabaseSync): Profile | undefined {
  return db.prepare('SELECT * FROM profile ORDER BY version DESC LIMIT 1').get() as Profile | undefined;
}

export function updateProfile(db: DatabaseSync, content: string, reason: string): Profile {
  const text = content.trim();
  assertNoThreat(text, '프로필', userWords(db));
  const tokens = estimateTokens(text);
  if (tokens > BUDGET.profileMax) {
    throw new Error(
      `profile is ~${tokens} tokens, over the ${BUDGET.profileMax}-token cap. ` +
        'Compress it: move details into memories and keep only what every conversation needs.',
    );
  }
  const now = nowIso();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO profile (content, reason, tokens, created_at) VALUES (?, ?, ?, ?)')
    .run(text, reason, tokens, now);
  return { version: Number(lastInsertRowid), content: text, reason, tokens, created_at: now };
}
