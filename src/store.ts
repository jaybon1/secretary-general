import type { DatabaseSync } from 'node:sqlite';
import { BUDGET } from './config.ts';
import { transaction } from './db.ts';
import { assertNoThreat } from './threats.ts';
import { estimateTokens, ftsQuery, indexText, nowIso, queryTerms, redactSecrets } from './text.ts';

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

export interface LogEntry {
  id: number;
  session_id: string;
  message_uuid: string;
  role: 'user' | 'assistant';
  content: string;
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
}

export const TASK_STATUSES = ['ready', 'running', 'done', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WORKSPACE_KINDS = ['quick', 'solo', 'team'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** A reusable folder the secretary hands work to: the shared quick folder, a solo worker, or a team. */
export interface Workspace {
  id: number;
  kind: WorkspaceKind;
  name: string;
  title: string;
  purpose: string;
  folder: string;
  /** Comma-separated role names; empty unless kind is 'team'. */
  agents: string;
  created_at: string;
  updated_at: string;
  /** Set once the workspace is retired (folder moved aside); null while it takes work. */
  archived_at: string | null;
}

/** One assignment to a workspace; its files live in `output_dir` (relative to the workspace folder). */
export interface Task {
  id: number;
  workspace_id: number;
  name: string;
  title: string;
  goal: string;
  output_dir: string;
  status: TaskStatus;
  session_ref: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskWithWorkspace = Task & { workspace_title: string; workspace_kind: WorkspaceKind; folder: string };

const TASK_SELECT = `SELECT t.*, w.title AS workspace_title, w.kind AS workspace_kind, w.folder
  FROM tasks t JOIN workspaces w ON w.id = t.workspace_id`;

const CONSOLIDATED_KEY = 'consolidated_through_log_id';

export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ---- memories -------------------------------------------------------------

  remember(input: NewMemory): { id: number; superseded: number[] } {
    const content = redactSecrets(input.content.trim());
    if (!content) throw new Error('content is empty');
    assertNoThreat(content, '기억');
    const tags = normalizeTags(input.tags);
    const now = nowIso();
    // Store every timestamp as UTC ISO so ordering and display stay consistent.
    const t = input.validFrom === undefined ? Date.parse(now) : Date.parse(input.validFrom);
    if (Number.isNaN(t)) throw new Error(`valid_from is not a date: ${input.validFrom}`);
    const validFrom = new Date(t).toISOString();

    return transaction(this.db, () => {
      const { lastInsertRowid } = this.db
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
      this.db.prepare('INSERT INTO memories_fts (rowid, terms) VALUES (?, ?)').run(id, indexText(content, tags));

      const superseded: number[] = [];
      for (const oldId of input.supersedes ?? []) {
        if (oldId === id) continue;
        if (this.invalidateInTx(oldId, `superseded by #${id}`, id, now)) superseded.push(oldId);
      }
      return { id, superseded };
    });
  }

  /** Marks a memory as no longer true. History is kept; it just stops being recalled. */
  forget(id: number, reason: string): boolean {
    return transaction(this.db, () => this.invalidateInTx(id, reason, null, nowIso()));
  }

  private invalidateInTx(id: number, reason: string, supersededBy: number | null, at: string): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE memories SET valid_to = ?, invalid_reason = ?, superseded_by = ?
         WHERE id = ? AND valid_to IS NULL`,
      )
      .run(at, reason, supersededBy, id);
    return Number(changes) > 0;
  }

  getMemory(id: number): Memory | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
  }

  listMemories(opts: { kind?: MemoryKind; topic?: string; includeInvalid?: boolean; limit?: number } = {}): Memory[] {
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
    return this.db.prepare(sql).all(...params, opts.limit ?? 50) as unknown as Memory[];
  }

  /** Full-text candidates, best bm25 first. `rank` is FTS5 bm25 (lower = better). */
  searchMemories(query: string, opts: { includeInvalid?: boolean; limit: number }): Array<Memory & { rank: number }> {
    const match = ftsQuery(queryTerms(query));
    if (!match) return [];
    return this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS rank
         FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? ${opts.includeInvalid ? '' : 'AND m.valid_to IS NULL'}
         ORDER BY rank LIMIT ?`,
      )
      .all(match, opts.limit) as unknown as Array<Memory & { rank: number }>;
  }

  /** Document frequency of each term across all indexed memories, plus the corpus size. */
  corpusStats(terms: string[]): { docCount: number; docFreq: Map<string, number> } {
    const docCount = Number((this.db.prepare('SELECT count(*) n FROM memories_fts').get() as { n: number }).n);
    const docFreq = new Map<string, number>();
    if (terms.length > 0) {
      const rows = this.db
        .prepare(`SELECT term, doc FROM memories_vocab WHERE term IN (${terms.map(() => '?').join(',')})`)
        .all(...terms) as Array<{ term: string; doc: number }>;
      for (const r of rows) docFreq.set(r.term, Number(r.doc));
    }
    return { docCount, docFreq };
  }

  memoriesWithoutVector(model: string): Array<{ id: number; content: string; tags: string }> {
    return this.db
      .prepare(
        `SELECT m.id, m.content, m.tags FROM memories m
         LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ?
         WHERE v.memory_id IS NULL ORDER BY m.id`,
      )
      .all(model) as Array<{ id: number; content: string; tags: string }>;
  }

  /** Removes vectors left by an earlier model or embedding input. */
  dropVectorsExcept(model: string): void {
    this.db.prepare('DELETE FROM memory_vectors WHERE model != ?').run(model);
  }

  saveVectors(model: string, rows: Array<{ id: number; vector: Float32Array }>): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO memory_vectors (memory_id, model, vector) VALUES (?, ?, ?)');
    transaction(this.db, () => {
      for (const r of rows) stmt.run(r.id, model, new Uint8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength));
    });
  }

  /** Active memories per topic (first tag), summaries not counted, with the topic's current summary id if any. */
  topics(): Array<{ topic: string; count: number; summaryId: number | null; summaryAt: string | null; latestAt: string }> {
    const rows = this.db
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

  vectors(model: string, includeInvalid = false): Array<{ id: number; vector: Float32Array }> {
    const rows = this.db
      .prepare(
        `SELECT v.memory_id AS id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
         WHERE v.model = ? ${includeInvalid ? '' : 'AND m.valid_to IS NULL'}`,
      )
      .all(model) as Array<{ id: number; vector: Uint8Array }>;
    return rows.map((r) => ({ id: r.id, vector: new Float32Array(r.vector.slice().buffer) })); // copy: the blob may not be 4-byte aligned
  }

  touch(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
    );
    const now = nowIso();
    transaction(this.db, () => {
      for (const id of ids) stmt.run(now, id);
    });
  }

  // ---- profile --------------------------------------------------------------

  getProfile(): Profile | undefined {
    return this.db.prepare('SELECT * FROM profile ORDER BY version DESC LIMIT 1').get() as Profile | undefined;
  }

  updateProfile(content: string, reason: string): Profile {
    const text = content.trim();
    assertNoThreat(text, '프로필');
    const tokens = estimateTokens(text);
    if (tokens > BUDGET.profileMax) {
      throw new Error(
        `profile is ~${tokens} tokens, over the ${BUDGET.profileMax}-token cap. ` +
          'Compress it: move details into memories and keep only what every conversation needs.',
      );
    }
    const now = nowIso();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO profile (content, reason, tokens, created_at) VALUES (?, ?, ?, ?)')
      .run(text, reason, tokens, now);
    return { version: Number(lastInsertRowid), content: text, reason, tokens, created_at: now };
  }

  // ---- raw log --------------------------------------------------------------

  /** Idempotent: entries already archived (same message_uuid) are skipped. */
  appendLog(entries: Array<Omit<LogEntry, 'id'>>): number {
    if (entries.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO raw_log (session_id, message_uuid, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const index = this.db.prepare('INSERT INTO raw_log_fts (rowid, terms) VALUES (?, ?)');
    return transaction(this.db, () => {
      let added = 0;
      for (const e of entries) {
        const { changes, lastInsertRowid } = insert.run(e.session_id, e.message_uuid, e.role, e.content, e.created_at);
        if (Number(changes) === 0) continue;
        index.run(Number(lastInsertRowid), indexText(e.content));
        added++;
      }
      return added;
    });
  }

  searchLog(query: string, opts: { limit: number; sessionId?: string }): Array<LogEntry & { rank: number }> {
    const match = ftsQuery(queryTerms(query));
    if (!match) return [];
    const params: Array<string | number> = [match];
    let sessionFilter = '';
    if (opts.sessionId) {
      sessionFilter = 'AND l.session_id = ?';
      params.push(opts.sessionId);
    }
    return this.db
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
  linkTurnMemories(sessionId: string): number {
    const prompt = this.db
      .prepare("SELECT id, created_at FROM raw_log WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { id: number; created_at: string } | undefined;
    if (!prompt) return 0;
    const { changes } = this.db
      .prepare('UPDATE memories SET source_log_id = ?, source_session = ? WHERE source_log_id IS NULL AND created_at >= ?')
      .run(prompt.id, sessionId, new Date(Date.parse(prompt.created_at)).toISOString());
    return Number(changes);
  }

  /** The conversation around one log entry, within its session, oldest first. */
  logAround(logId: number, before: number, after: number): LogEntry[] {
    const center = this.db.prepare('SELECT session_id FROM raw_log WHERE id = ?').get(logId) as { session_id: string } | undefined;
    if (!center) return [];
    const earlier = this.db
      .prepare('SELECT * FROM raw_log WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(center.session_id, logId, before) as unknown as LogEntry[];
    const rest = this.db
      .prepare('SELECT * FROM raw_log WHERE session_id = ? AND id >= ? ORDER BY id LIMIT ?')
      .all(center.session_id, logId, after + 1) as unknown as LogEntry[];
    return [...earlier.reverse(), ...rest];
  }

  /** The most recently active session other than `excludeId`, with its last entry time. */
  lastOtherSession(excludeId?: string): { session_id: string; last_at: string } | undefined {
    return this.db
      .prepare('SELECT session_id, created_at AS last_at FROM raw_log WHERE session_id != ? ORDER BY id DESC LIMIT 1')
      .get(excludeId ?? '') as { session_id: string; last_at: string } | undefined;
  }

  /** The last `n` entries of a session (id or 8-char prefix), oldest first. */
  sessionTail(sessionId: string, n: number, role?: 'user' | 'assistant'): LogEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM raw_log WHERE session_id LIKE ? ${role ? 'AND role = ?' : ''} ORDER BY id DESC LIMIT ?`)
      .all(...(role ? [`${sessionId}%`, role, n] : [`${sessionId}%`, n])) as unknown as LogEntry[];
    return rows.reverse();
  }

  /** A session's entries with id in (afterId, beforeId), oldest first. */
  sessionBetween(sessionId: string, afterId: number, beforeId: number, role?: 'user' | 'assistant'): LogEntry[] {
    return this.db
      .prepare(`SELECT * FROM raw_log WHERE session_id LIKE ? AND id > ? AND id < ? ${role ? 'AND role = ?' : ''} ORDER BY id`)
      .all(...(role ? [`${sessionId}%`, afterId, beforeId, role] : [`${sessionId}%`, afterId, beforeId])) as unknown as LogEntry[];
  }

  /** Every log entry after `logId`, across sessions, oldest first. */
  logAfter(logId: number): LogEntry[] {
    return this.db.prepare('SELECT * FROM raw_log WHERE id > ? ORDER BY id').all(logId) as unknown as LogEntry[];
  }

  /** Active memories saved in a session (linked by the Stop hook or /consolidate). */
  sessionMemoryIds(sessionId: string): number[] {
    return (
      this.db
        .prepare('SELECT id FROM memories WHERE source_session = ? AND valid_to IS NULL ORDER BY id')
        .all(sessionId) as Array<{ id: number }>
    ).map((r) => r.id);
  }

  /** Log entries after the consolidation watermark, oldest first. */
  unconsolidatedLog(limit: number): LogEntry[] {
    return this.db
      .prepare('SELECT * FROM raw_log WHERE id > ? ORDER BY id LIMIT ?')
      .all(this.consolidatedThrough(), limit) as unknown as LogEntry[];
  }

  consolidatedThrough(): number {
    return Number(this.getMeta(CONSOLIDATED_KEY) ?? 0);
  }

  markConsolidated(throughLogId: number): void {
    if (throughLogId < this.consolidatedThrough()) {
      throw new Error(`watermark only moves forward (currently ${this.consolidatedThrough()})`);
    }
    this.setMeta(CONSOLIDATED_KEY, String(throughLogId));
  }

  // ---- delegated work -------------------------------------------------------

  createWorkspace(w: { kind: WorkspaceKind; name: string; title: string; purpose: string; folder: string; agents: string[] }): Workspace {
    const now = nowIso();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO workspaces (kind, name, title, purpose, folder, agents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(w.kind, w.name, w.title, w.purpose, w.folder, w.agents.join(','), now, now);
    return this.getWorkspace(Number(lastInsertRowid)) as Workspace;
  }

  getWorkspace(id: number): Workspace | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined;
  }

  /** Points a workspace at its folder's new location (the secretary was moved). */
  moveWorkspace(id: number, folder: string): Workspace {
    this.db.prepare('UPDATE workspaces SET folder = ?, updated_at = ? WHERE id = ?').run(folder, nowIso(), id);
    return this.getWorkspace(id) as Workspace;
  }

  /** Retires a workspace whose folder was moved aside to `folder`; its tasks keep pointing at it. */
  archiveWorkspace(id: number, folder: string): Workspace {
    const now = nowIso();
    const { changes } = this.db
      .prepare('UPDATE workspaces SET folder = ?, archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(folder, now, now, id);
    if (!changes) throw new Error(`공간 #${id}이 없거나 이미 보관됨`);
    return this.getWorkspace(id) as Workspace;
  }

  quickWorkspace(): Workspace | undefined {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE kind = 'quick' AND archived_at IS NULL ORDER BY id LIMIT 1")
      .get() as Workspace | undefined;
  }

  /** Workspaces still taking work, most recently used first, with how many tasks each has handled. */
  listWorkspaces(): Array<Workspace & { task_count: number }> {
    return this.db
      .prepare(
        `SELECT w.*, (SELECT count(*) FROM tasks t WHERE t.workspace_id = w.id) AS task_count
         FROM workspaces w WHERE w.archived_at IS NULL ORDER BY w.updated_at DESC, w.id DESC`,
      )
      .all() as unknown as Array<Workspace & { task_count: number }>;
  }

  createTask(t: { workspaceId: number; name: string; title: string; goal: string; outputDir: string }): Task {
    const now = nowIso();
    return transaction(this.db, () => {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO tasks (workspace_id, name, title, goal, output_dir, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
        )
        .run(t.workspaceId, t.name, t.title, t.goal, t.outputDir, now, now);
      this.db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(now, t.workspaceId);
      return this.getTask(Number(lastInsertRowid)) as Task;
    });
  }

  getTask(id: number): TaskWithWorkspace | undefined {
    return this.db
      .prepare(`${TASK_SELECT} WHERE t.id = ?`)
      .get(id) as TaskWithWorkspace | undefined;
  }

  /** Only the given fields change; returns undefined if there is no such task. */
  updateTask(id: number, patch: { status?: TaskStatus; sessionRef?: string; result?: string }): TaskWithWorkspace | undefined {
    const { changes } = this.db
      .prepare(
        `UPDATE tasks SET status = coalesce(?, status), session_ref = coalesce(?, session_ref),
                          result = coalesce(?, result), updated_at = ?
         WHERE id = ?`,
      )
      .run(patch.status ?? null, patch.sessionRef ?? null, patch.result ?? null, nowIso(), id);
    return Number(changes) ? this.getTask(id) : undefined;
  }

  /** Most recently updated first. */
  listTasks(opts: { status?: TaskStatus; workspaceId?: number; limit?: number } = {}): TaskWithWorkspace[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.status) {
      where.push('t.status = ?');
      params.push(opts.status);
    }
    if (opts.workspaceId !== undefined) {
      where.push('t.workspace_id = ?');
      params.push(opts.workspaceId);
    }
    return this.db
      .prepare(
        `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
      )
      .all(...params, opts.limit ?? 20) as unknown as TaskWithWorkspace[];
  }

  // ---- meta / usage ---------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  metaWithPrefix(prefix: string): Array<{ key: string; value: string }> {
    return this.db.prepare("SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\'").all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) as Array<{
      key: string;
      value: string;
    }>;
  }

  logUsage(event: string, tokens: number, detail?: unknown): void {
    this.db
      .prepare('INSERT INTO usage_log (event, tokens, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(event, tokens, detail === undefined ? null : JSON.stringify(detail), nowIso());
  }

  /**
   * Memory ids auto-injected into this session since its context was last
   * reset (/clear, compaction). Those are still in the conversation, so
   * injecting them again would only pay for them twice.
   */
  injectedIds(sessionId: string): Set<number> {
    const rows = this.db
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

  stats() {
    const one = (sql: string, ...params: number[]) => Number((this.db.prepare(sql).get(...params) as { n: number }).n);
    return {
      memoriesActive: one('SELECT count(*) n FROM memories WHERE valid_to IS NULL'),
      memoriesInvalidated: one('SELECT count(*) n FROM memories WHERE valid_to IS NOT NULL'),
      logEntries: one('SELECT count(*) n FROM raw_log'),
      unconsolidated: one('SELECT count(*) n FROM raw_log WHERE id > ?', this.consolidatedThrough()),
      profileVersion: this.getProfile()?.version ?? 0,
      injectedTokensLast7d: one(
        `SELECT coalesce(sum(tokens), 0) n FROM usage_log WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`,
      ),
    };
  }
}

function normalizeTags(tags: string[] | undefined): string {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].join(' ');
}
