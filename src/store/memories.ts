/**
 * 기억(memories)과 핵심 프로필(profile)을 DB에 읽고 쓰는 함수들. 저장·무효 처리·검색 후보·의미 검색 벡터·주제 수를 다룬다.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { BUDGET } from '../core/config.ts';
import { transaction } from './schema.ts';
import { assertNoThreat } from './injection-screen.ts';
import { userWords } from './user-title.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { ftsQuery, indexText, queryTerms } from './search-terms.ts';
import { nowIso } from '../core/kst-time.ts';
import { redactSecrets } from '../core/secret-mask.ts';
import { copyActionRow } from './memory-actions.ts';
import { cleanTag, tagList, TAGS_SHOWN_SQL, TAGS_SQL, TOPIC_SQL, TOPIC_TAG_SQL, trailingTagBracket } from './tag-names.ts';

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'event', 'action', 'person', 'note', 'summary'] as const;

/** A topic gets a summary memory once it has this many active memories. */
export const SUMMARY_MIN_MEMORIES = 10;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: number;
  kind: MemoryKind;
  content: string;
  /** Its tags in order, joined by spaces (the tag tables, migration 21): what the word index and the meaning vector read. */
  tags: string;
  /** Its tags in order, joined by ", ": what a line shows (tag-names.ts shownTags). From the database; a memory made in code has none. */
  tags_shown?: string;
  /** Its topic key (store/tag-names.ts topicKey): the first tag, or "비서/<second tag>"; '' without tags. */
  topic: string;
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

// ---- tags (the tag tables, migration 21) ------------------------------------

const withTagTables = new WeakSet<DatabaseSync>();
/** Whether this DB has the tag tables (a DB before migration 21 still keeps the tags in memories.tags: tests of old migrations write there). */
function tagTables(db: DatabaseSync): boolean {
  if (withTagTables.has(db)) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_tags'").get()) return false;
  withTagTables.add(db);
  return true;
}

/** Every column of memory row `a` as Memory has them. */
const MEMORY_COLS = (a = 'm') => `${a}.*, ${TAGS_SQL(a)} AS tags, ${TAGS_SHOWN_SQL(a)} AS tags_shown, ${TOPIC_SQL(a)} AS topic`;
/** Rows whose topic key is `?` (a topic tag alone also takes in a split topic's memories: list_memories topic '비서'). */
const TOPIC_WHERE = (a = 'm') => `? IN (${TOPIC_SQL(a)}, ${TOPIC_TAG_SQL(a)})`;

/**
 * Sets a memory's tags (cleaned, in order, the first its topic), each name read as the name it is an alias of. Done in the
 * caller's transaction. Returns the names kept, in order.
 */
function writeTags(db: DatabaseSync, memoryId: number, tags: readonly string[]): string[] {
  db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(memoryId);
  const add = db.prepare('INSERT INTO tags (name, created_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING');
  const get = db.prepare('SELECT t.id, t.name, a.id AS alias_id, a.name AS alias_name FROM tags t LEFT JOIN tags a ON a.id = t.alias_of WHERE t.name = ?');
  const link = db.prepare('INSERT INTO memory_tags (memory_id, tag_id, position, is_topic) VALUES (?, ?, ?, ?)');
  const now = nowIso();
  const kept: string[] = [];
  const ids = new Set<number>();
  for (const name of tagList(tags)) {
    add.run(name, now);
    const r = get.get(name) as { id: number; name: string; alias_id: number | null; alias_name: string | null };
    const id = r.alias_id ?? r.id;
    if (ids.has(id)) continue;
    ids.add(id);
    link.run(memoryId, id, kept.length, kept.length === 0 ? 1 : 0);
    kept.push(r.alias_name ?? r.name);
  }
  return kept;
}

/** writeTags for a writer that puts rows in by itself (memory-eval/case-db.ts), inside its transaction. */
export const writeMemoryTags = writeTags;

/** A memory's tags in order (the first its topic). */
export function tagsOf(db: DatabaseSync, memoryId: number): string[] {
  return (
    db.prepare('SELECT t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = ? ORDER BY mt.position').all(memoryId) as Array<{ name: string }>
  ).map((r) => r.name);
}

/** Its word index entry made again from its content and tags, and its meaning vector dropped for the server to make again. */
function reindexInTx(db: DatabaseSync, memoryId: number): void {
  const m = db.prepare(`SELECT content, ${TAGS_SQL('m')} AS tags FROM memories m WHERE id = ?`).get(memoryId) as { content: string; tags: string } | undefined;
  if (!m) return;
  db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(memoryId);
  db.prepare('INSERT INTO memories_fts (rowid, terms) VALUES (?, ?)').run(memoryId, indexText(m.content, m.tags));
  db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(memoryId);
}

/**
 * New tags for a memory (the consolidation setting the boundaries the migration could not tell, mcp/memory-tools.ts
 * set_memory_tags, memory/tag-boundaries.ts): written, indexed again and the vector dropped when the tags read otherwise,
 * and the memory off the list still to check.
 */
export function setMemoryTags(db: DatabaseSync, memoryId: number, tags: readonly string[]): string[] {
  return transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM memories WHERE id = ?').get(memoryId)) throw new Error(`기억 #${memoryId}이 없음`);
    if (!tagList(tags).length) throw new Error('태그가 비었음: 주제 태그 하나 이상');
    const joined = () => (db.prepare(`SELECT ${TAGS_SQL('m')} AS tags FROM memories m WHERE id = ?`).get(memoryId) as { tags: string }).tags;
    const before = joined();
    const kept = writeTags(db, memoryId, tags);
    // The word index and the meaning vector read the tags joined by spaces: when only the boundaries moved ("할", "일" →
    // "할 일") that text is the same, so both are kept (dropping the vector would leave the memory out of meaning search
    // until it is embedded again).
    if (joined() !== before) reindexInTx(db, memoryId);
    db.prepare('DELETE FROM memory_tag_checks WHERE memory_id = ?').run(memoryId);
    return kept;
  });
}

/**
 * `alias` becomes another name for `canonical` (e.g. "크롬" for "크롬확장"): memories carrying it carry the canonical one
 * instead (indexed again), names that pointed at the alias point at the canonical one, and a later memory given the
 * alias gets the canonical one. Returns the memories changed.
 */
export function mergeTags(db: DatabaseSync, alias: string, canonical: string): number[] {
  const from = cleanTag(alias);
  const to = cleanTag(canonical);
  if (!from || !to || from === to) throw new Error('별칭과 원래 이름이 비었거나 같음');
  return transaction(db, () => {
    const now = nowIso();
    const add = db.prepare('INSERT INTO tags (name, created_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING');
    add.run(from, now);
    add.run(to, now);
    const row = (name: string) => db.prepare('SELECT id, alias_of FROM tags WHERE name = ?').get(name) as { id: number; alias_of: number | null };
    const target = row(to);
    const targetId = target.alias_of ?? target.id;
    const source = row(from);
    if (source.id === targetId) throw new Error(`"${to}"이 이미 "${from}"의 별칭이라 거꾸로 묶을 수 없음`);
    db.prepare('UPDATE tags SET alias_of = ? WHERE id = ? OR alias_of = ?').run(targetId, source.id, source.id);
    const ids = (db.prepare('SELECT memory_id FROM memory_tags WHERE tag_id = ?').all(source.id) as Array<{ memory_id: number }>).map((r) => r.memory_id);
    for (const id of ids) {
      writeTags(db, id, tagsOf(db, id));
      reindexInTx(db, id);
    }
    return ids;
  });
}

/**
 * The DB cleanup (memory/memory-cleanup.ts): a live memory's tags written again at the end of its content
 * (tag-names.ts trailingTagBracket) taken off, the bracket's other words kept as tags, indexed again. null when it has none.
 */
export function stripTrailingTags(db: DatabaseSync, memoryId: number): { content: string; tags: string[] } | null {
  return transaction(db, () => {
    const m = db.prepare('SELECT content FROM memories WHERE id = ? AND valid_to IS NULL').get(memoryId) as { content: string } | undefined;
    const tags = tagsOf(db, memoryId);
    const cut = m && trailingTagBracket(m.content, tags);
    if (!cut) return null;
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(cut.content, memoryId);
    const kept = writeTags(db, memoryId, [...tags, ...cut.extra]);
    reindexInTx(db, memoryId);
    // The bracket's words were taken one by one ("업무 3" became "업무", "3"): the consolidation sets the boundaries.
    if (cut.extra.length > 1) db.prepare('INSERT OR REPLACE INTO memory_tag_checks (memory_id, tags) VALUES (?, ?)').run(memoryId, kept.length);
    return { content: cut.content, tags: kept };
  });
}

/** Unlinks topic summaries from conversation rows (only the consolidation writes them; an old link step tied them to a chat). */
export function unlinkSummaries(db: DatabaseSync, ids: number[]): number {
  return transaction(db, () => {
    const stmt = db.prepare("UPDATE memories SET source_log_id = NULL, source_session = NULL WHERE id = ? AND kind = 'summary'");
    return ids.reduce((n, id) => n + Number(stmt.run(id).changes), 0);
  });
}

/** Live memories other than topic summaries with their topic tag and kind (memory/memory-pairs.ts groups close pairs by it). */
export function liveTopicTags(db: DatabaseSync): Array<{ id: number; kind: MemoryKind; topic: string }> {
  return db.prepare(`SELECT id, kind, ${TOPIC_TAG_SQL('m')} AS topic FROM memories m WHERE valid_to IS NULL AND kind != 'summary'`).all() as Array<{
    id: number;
    kind: MemoryKind;
    topic: string;
  }>;
}

/** Pairs of memories the consolidation has judged (memory_pair_checks), as "older:newer". */
export function checkedPairs(db: DatabaseSync): Set<string> {
  return new Set((db.prepare('SELECT older_id, newer_id FROM memory_pair_checks').all() as Array<{ older_id: number; newer_id: number }>).map((r) => `${r.older_id}:${r.newer_id}`));
}

export function recordPairCheck(db: DatabaseSync, olderId: number, newerId: number, verdict: string): void {
  db.prepare('INSERT OR REPLACE INTO memory_pair_checks (older_id, newer_id, verdict, checked_at) VALUES (?, ?, ?, ?)').run(olderId, newerId, verdict, nowIso());
}

/** The live memories each of these conversation rows gave (source_log_id), by row. */
export function memoriesFromRows(db: DatabaseSync, logIds: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!logIds.length) return out;
  const rows = db
    .prepare(`SELECT id, source_log_id FROM memories WHERE valid_to IS NULL AND source_log_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(JSON.stringify(logIds)) as Array<{ id: number; source_log_id: number }>;
  for (const r of rows) out.set(r.source_log_id, [...(out.get(r.source_log_id) ?? []), r.id]);
  return out;
}

/** Live memories whose tag boundaries the migration split by spaces and no one has checked yet: most tags first, newest first. */
export function tagChecksDue(db: DatabaseSync, limit: number): { due: Memory[]; left: number } {
  const due = db
    .prepare(
      `SELECT ${MEMORY_COLS('m')} FROM memory_tag_checks c JOIN memories m ON m.id = c.memory_id
       WHERE m.valid_to IS NULL ORDER BY c.tags DESC, m.id DESC LIMIT ?`,
    )
    .all(limit) as unknown as Memory[];
  const left = Number((db.prepare('SELECT count(*) AS n FROM memory_tag_checks c JOIN memories m ON m.id = c.memory_id WHERE m.valid_to IS NULL').get() as { n: number }).n);
  return { due, left };
}

// ---- memories -------------------------------------------------------------

export function remember(db: DatabaseSync, input: NewMemory): { id: number; superseded: number[] } {
  return transaction(db, () => rememberInTx(db, input));
}

function rememberInTx(db: DatabaseSync, input: NewMemory): { id: number; superseded: number[] } {
  let content = redactSecrets(input.content.trim());
  if (!content) throw new Error('content is empty');
  assertNoThreat(content, '기억', userWords(db));
  let tags = tagList(input.tags);
  // Tags written again at the end of the content (" [텃밭 업무 3]") would show twice: taken off, their other words kept as tags.
  const bracket = trailingTagBracket(content, tags);
  if (bracket) {
    content = bracket.content;
    tags = tagList([...tags, ...bracket.extra]);
  }
  const now = nowIso();
  // Store every timestamp as UTC ISO so ordering and display stay consistent.
  const t = input.validFrom === undefined ? Date.parse(now) : Date.parse(input.validFrom);
  if (Number.isNaN(t)) throw new Error(`valid_from is not a date: ${input.validFrom}`);
  const validFrom = new Date(t).toISOString();

  if (input.expectMaxId !== undefined && maxMemoryId(db) > input.expectMaxId) {
    throw new MemoryRaceError(`memory saved by another writer after #${input.expectMaxId}`);
  }
  const tables = tagTables(db);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO memories (kind, content, ${tables ? '' : 'tags, '}importance, valid_from, source_session, source_log_id, created_at)
       VALUES (?, ?, ${tables ? '' : '?, '}?, ?, ?, ?, ?)`,
    )
    .run(
      input.kind,
      content,
      ...(tables ? [] : [tags.join(' ')]),
      input.importance ?? 3,
      validFrom,
      input.sourceSession ?? null,
      input.sourceLogId ?? null,
      now,
    );
  const id = Number(lastInsertRowid);
  const names = tables ? writeTags(db, id, tags) : tags;
  db.prepare('INSERT INTO memories_fts (rowid, terms) VALUES (?, ?)').run(id, indexText(content, names.join(' ')));

  const superseded: number[] = [];
  for (const oldId of input.supersedes ?? []) {
    if (oldId === id) continue;
    if (invalidateInTx(db, oldId, `superseded by #${id}`, id, now)) superseded.push(oldId);
  }
  return { id, superseded };
}

/** What the consolidation's judge writes for one candidate (memory/consolidate-verdicts.ts applyPlan). */
export interface JudgedWrite {
  /** The new memory (the candidate, or what it adds to a memory it repeats), replacing its `supersedes`. */
  save?: NewMemory;
  /** Old memories replaced by an existing one that already says the candidate. */
  replaceWith?: { by: number; ids: number[] };
  /** Replaced memories whose other part still holds: that part becomes a memory of its own. */
  rests: Array<{ id: number; content: string }>;
}

/**
 * The judge's writes in one transaction, so a replaced memory never ends without the part that still held (fix C4 of the
 * 2026-11-13 source review: many live memories hold several decisions, and one changing must not end the others). A
 * remainder takes the old memory's kind, tags, importance, valid_from, session and conversation row; the old one keeps
 * pointing at what replaced it (superseded_by) and its invalid_reason names the remainder, so the history reads both ways.
 */
export function rememberJudged(db: DatabaseSync, w: JudgedWrite): { saved?: number; superseded: number[]; rests: Array<{ old: number; id: number }> } {
  return transaction(db, () => {
    const superseded: number[] = [];
    let saved: number | undefined;
    if (w.save) {
      const r = rememberInTx(db, w.save);
      saved = r.id;
      superseded.push(...r.superseded);
    }
    if (w.replaceWith) {
      const by = getMemory(db, w.replaceWith.by);
      if (by && by.valid_to === null) {
        for (const id of w.replaceWith.ids) if (id !== by.id && invalidateInTx(db, id, `superseded by #${by.id}`, by.id, nowIso())) superseded.push(id);
      }
    }
    const rests: Array<{ old: number; id: number }> = [];
    for (const r of w.rests) {
      const old = getMemory(db, r.id);
      // Only a memory this write replaced: one replaced by someone else meanwhile keeps its own history.
      if (!old || !superseded.includes(r.id)) continue;
      const { id } = rememberInTx(db, {
        kind: old.kind,
        content: r.content,
        tags: tagsOf(db, old.id),
        importance: old.importance,
        validFrom: old.valid_from,
        sourceSession: old.source_session ?? undefined,
        sourceLogId: old.source_log_id ?? undefined,
      });
      db.prepare(`UPDATE memories SET invalid_reason = invalid_reason || ? WHERE id = ?`).run(` · 바뀌지 않은 나머지 → #${id}`, r.id);
      // An action's remainder keeps its owner, due date and condition (memory-actions.ts).
      if (old.kind === 'action') copyActionRow(db, r.id, id);
      rests.push({ old: r.id, id });
    }
    return { saved, superseded, rests };
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
      `SELECT ${MEMORY_COLS('m')} FROM memories m WHERE id IN (${ids.map(() => '?').join(',')})
       AND valid_to IS NULL AND kind != 'summary' AND created_at >= ? ORDER BY id`,
    )
    .all(...ids, sinceIso) as unknown as Memory[];
}

/** Marks a memory as no longer true. History is kept; it just stops being recalled. */
export function forget(db: DatabaseSync, id: number, reason: string): boolean {
  return transaction(db, () => invalidateInTx(db, id, reason, null, nowIso()));
}

/**
 * Marks a memory as replaced by one already saved (`byId`, active): the memory consolidation's judge, when a memory
 * saved in the chat already says what the candidate says and an old one it changes or ends is still live.
 */
export function supersedeWith(db: DatabaseSync, id: number, byId: number): boolean {
  return transaction(db, () => {
    const by = db.prepare('SELECT valid_to FROM memories WHERE id = ?').get(byId) as { valid_to: string | null } | undefined;
    if (!by || by.valid_to !== null || id === byId) return false;
    return invalidateInTx(db, id, `superseded by #${byId}`, byId, nowIso());
  });
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
  return db.prepare(`SELECT ${MEMORY_COLS('m')} FROM memories m WHERE id = ?`).get(id) as Memory | undefined;
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
    // The topic key ("텃밭", "비서/상황판"), or a topic tag alone.
    where.push(TOPIC_WHERE('m'));
    params.push(cleanTag(opts.topic));
  }
  const sql = `SELECT ${MEMORY_COLS('m')} FROM memories m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
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
      `SELECT ${MEMORY_COLS('m')}, bm25(memories_fts) AS rank
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
      `SELECT m.id, m.content, ${TAGS_SQL('m')} AS tags FROM memories m
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

/** Active memories per topic key (tag-names.ts topicKey), summaries not counted, with the topic's current summary id if any. */
export function topics(
  db: DatabaseSync,
): Array<{ topic: string; count: number; summaryId: number | null; summaryAt: string | null; latestAt: string }> {
  const rows = db
    .prepare(`SELECT id, kind, ${TOPIC_SQL('m')} AS topic, created_at FROM memories m WHERE valid_to IS NULL ORDER BY id`)
    .all() as Array<{ id: number; kind: string; topic: string; created_at: string }>;
  const by = new Map<string, { topic: string; count: number; summaryId: number | null; summaryAt: string | null; latestAt: string }>();
  for (const r of rows) {
    const topic = r.topic;
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

/** Active memories of a topic key made after `after` (a summary's created_at), summaries left out, oldest first. */
export function newerInTopic(db: DatabaseSync, topic: string, after: string, limit: number): number[] {
  const t = cleanTag(topic);
  if (!t) return [];
  const rows = db
    .prepare(
      `SELECT id FROM memories m WHERE valid_to IS NULL AND kind != 'summary' AND created_at > ?
       AND ${TOPIC_SQL('m')} = ? ORDER BY id LIMIT ?`,
    )
    .all(after, t, limit) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/**
 * The topic's memories that stopped holding after `after` (a topic summary's time): replaced or marked untrue since the
 * summary was written, so the summary may still say them (fix C11 of the 2026-11-13 source review; hindsight keeps
 * "retractions" apart from new memories because a vanished memory raises no "newer" mark). Summaries are left out.
 */
export function endedInTopic(db: DatabaseSync, topic: string, after: string, limit: number): Array<{ id: number; by: number | null }> {
  const t = cleanTag(topic);
  if (!t) return [];
  return (
    db
      .prepare(
        `SELECT id, superseded_by AS by FROM memories m WHERE valid_to IS NOT NULL AND valid_to > ? AND kind != 'summary'
         AND ${TOPIC_SQL('m')} = ? ORDER BY id LIMIT ?`,
      )
      .all(after, t, limit) as Array<{ id: number; by: number | null }>
  ).map((r) => ({ id: r.id, by: r.by }));
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

/** Tags as the word index and the meaning vector read them: cleaned (tag-names.ts tagList) and joined by spaces. */
export function normalizeTags(tags: string[] | undefined): string {
  return tagList(tags).join(' ');
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
