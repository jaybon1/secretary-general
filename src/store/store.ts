/**
 * 비서 DB의 입구: Store 클래스가 갈래별 파일(기억 memories, 대화 기록 conversation-log, 큰 일 big-work,
 * 공간·업무 workspaces-tasks, meta·사용량 meta-usage)의 함수를 메서드로 묶는다. 바깥은 여기서만 가져다 쓴다.
 */
import type { DatabaseSync } from 'node:sqlite';
import * as bigWorkDb from './big-work.ts';
import type { BigWork, BigWorkState } from './big-work.ts';
import * as logDb from './conversation-log.ts';
import type { LogEntry, LogRowInfo } from './conversation-log.ts';
import * as memoryDb from './memories.ts';
import type { Memory, MemoryKind, NewMemory, Profile } from './memories.ts';
import * as metaDb from './meta-usage.ts';
import * as workDb from './workspaces-tasks.ts';
import type { Task, TaskStatus, TaskWithWorkspace, Workspace, WorkspaceKind } from './workspaces-tasks.ts';
import * as guardDb from './guards.ts';
import type { GuardHit, Mistake, MistakeCause, NewMistake, TurnTools } from './guards.ts';

export {
  MEMORY_KINDS,
  MemoryRaceError,
  SUMMARY_MIN_MEMORIES,
  SUMMARY_SKIP_TOPICS,
  normalizeTags,
  type Memory,
  type MemoryKind,
  type NewMemory,
  type Profile,
} from './memories.ts';
export { BIG_WORK_CHECK, BIG_WORK_LIMITS, BIG_WORK_STATES, renderBigWork, type BigWork, type BigWorkState } from './big-work.ts';
export type { LogEntry, LogRowInfo } from './conversation-log.ts';
export {
  MISTAKE_CAUSES,
  MISTAKE_FINDERS,
  type GuardHit,
  type Mistake,
  type MistakeCause,
  type MistakeFinder,
  type NewMistake,
  type TurnTools,
} from './guards.ts';
export {
  TASK_STATUSES,
  WORKSPACE_KINDS,
  type Task,
  type TaskStatus,
  type TaskWithWorkspace,
  type Workspace,
  type WorkspaceKind,
} from './workspaces-tasks.ts';

export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ---- memories (store/memories.ts) ----------------------------------------

  remember(input: NewMemory): { id: number; superseded: number[] } {
    return memoryDb.remember(this.db, input);
  }

  maxMemoryId(): number {
    return memoryDb.maxMemoryId(this.db);
  }

  /**
   * Active memories (summaries left out) among `ids` saved after `sinceIso`: the candidates
   * a new memory may be repeating.
   */
  recentMemories(ids: number[], sinceIso: string): Memory[] {
    return memoryDb.recentMemories(this.db, ids, sinceIso);
  }

  /** Marks a memory as no longer true. History is kept; it just stops being recalled. */
  forget(id: number, reason: string): boolean {
    return memoryDb.forget(this.db, id, reason);
  }

  getMemory(id: number): Memory | undefined {
    return memoryDb.getMemory(this.db, id);
  }

  listMemories(opts?: { kind?: MemoryKind; topic?: string; includeInvalid?: boolean; limit?: number }): Memory[] {
    return memoryDb.listMemories(this.db, opts);
  }

  /** Full-text candidates, best bm25 first. `rank` is FTS5 bm25 (lower = better). */
  searchMemories(query: string, opts: { includeInvalid?: boolean; limit: number }): Array<Memory & { rank: number }> {
    return memoryDb.searchMemories(this.db, query, opts);
  }

  /** Document frequency of each term across all indexed memories, plus the corpus size. */
  corpusStats(terms: string[]): { docCount: number; docFreq: Map<string, number> } {
    return memoryDb.corpusStats(this.db, terms);
  }

  memoriesWithoutVector(model: string): Array<{ id: number; content: string; tags: string }> {
    return memoryDb.memoriesWithoutVector(this.db, model);
  }

  /** Removes vectors left by an earlier model or embedding input. */
  dropVectorsExcept(model: string): void {
    memoryDb.dropVectorsExcept(this.db, model);
  }

  saveVectors(model: string, rows: Array<{ id: number; vector: Float32Array }>): void {
    memoryDb.saveVectors(this.db, model, rows);
  }

  /** Active memories per topic (first tag), summaries not counted, with the topic's current summary id if any. */
  topics(): Array<{ topic: string; count: number; summaryId: number | null; summaryAt: string | null; latestAt: string }> {
    return memoryDb.topics(this.db);
  }

  vectors(model: string, includeInvalid?: boolean): Array<{ id: number; vector: Float32Array }> {
    return memoryDb.vectors(this.db, model, includeInvalid);
  }

  touch(ids: number[]): void {
    memoryDb.touch(this.db, ids);
  }

  /** Active memories saved in a session (linked by the Stop hook or /consolidate). */
  sessionMemoryIds(sessionId: string): number[] {
    return memoryDb.sessionMemoryIds(this.db, sessionId);
  }

  // ---- profile (store/memories.ts) -----------------------------------------

  getProfile(): Profile | undefined {
    return memoryDb.getProfile(this.db);
  }

  updateProfile(content: string, reason: string): Profile {
    return memoryDb.updateProfile(this.db, content, reason);
  }

  // ---- big work (store/big-work.ts) ----------------------------------------

  /** The board: each work's latest row, off-board states left out, in order of first appearance. */
  bigWork(): BigWork[] {
    return bigWorkDb.bigWork(this.db);
  }

  /** Every change to one work, oldest first. */
  bigWorkHistory(name: string): BigWork[] {
    return bigWorkDb.bigWorkHistory(this.db, name);
  }

  /**
   * Adds, changes or removes (끝남/지움) one line of the board; the rest is untouched. Each call
   * appends a row, so the history stays. Returns null when nothing changed.
   */
  setBigWork(input: { name: string; state: BigWorkState; note?: string; sourceLogId?: number; seenId?: number }): BigWork | null {
    return bigWorkDb.setBigWork(this.db, input);
  }

  // ---- raw log (store/conversation-log.ts) ----------------------------------------------

  /** Idempotent: entries already archived (same message_uuid) are skipped. */
  appendLog(entries: Array<Omit<LogEntry, 'id'>>): number {
    return logDb.appendLog(this.db, entries);
  }

  searchLog(query: string, opts: { limit: number; sessionId?: string }): Array<LogEntry & { rank: number }> {
    return logDb.searchLog(this.db, query, opts);
  }

  /**
   * Run after a turn is archived: memories saved during the turn (created after its prompt
   * and not yet linked) point at that prompt, so their source conversation can be opened later.
   */
  linkTurnMemories(sessionId: string): number {
    return logDb.linkTurnMemories(this.db, sessionId);
  }

  /** Log rows of these transcript messages (a recap's derived uuid included), oldest first, without their text. */
  logInfoByUuids(uuids: string[]): LogRowInfo[] {
    return logDb.logInfoByUuids(this.db, uuids);
  }

  /** Still-valid memories linked to these log entries, or among `ids`, with when they were saved. */
  memoriesForRewind(logIds: number[], ids: number[]): Array<{ id: number; created_at: string }> {
    return logDb.memoriesForRewind(this.db, logIds, ids);
  }

  /**
   * Removes log entries for good, keeps ingest from logging them again, and invalidates `forgetIds`, in one
   * transaction. Only log/purge.ts deleteLogRows calls it (it copies the rows aside first).
   */
  dropLogRows(logIds: number[], forgetIds: number[], reason: string, at: string): { forgotten: number[] } {
    return logDb.dropLogEntries(this.db, logIds, forgetIds, reason, at);
  }

  /** The conversation around one log entry, within its session, oldest first. */
  logAround(logId: number, before: number, after: number): LogEntry[] {
    return logDb.logAround(this.db, logId, before, after);
  }

  /** The most recently active session other than `excludeId`, with its last entry time. */
  lastOtherSession(excludeId?: string): { session_id: string; last_at: string } | undefined {
    return logDb.lastOtherSession(this.db, excludeId);
  }

  /** The last `n` entries of a session (id or 8-char prefix), oldest first. */
  sessionTail(sessionId: string, n: number, role?: 'user' | 'assistant'): LogEntry[] {
    return logDb.sessionTail(this.db, sessionId, n, role);
  }

  /** A session's entries with id in (afterId, beforeId), oldest first. */
  sessionBetween(sessionId: string, afterId: number, beforeId: number, role?: 'user' | 'assistant'): LogEntry[] {
    return logDb.sessionBetween(this.db, sessionId, afterId, beforeId, role);
  }

  /** When the newest log entry was written (any session), or undefined for an empty log. */
  lastLogAt(): string | undefined {
    return logDb.lastLogAt(this.db);
  }

  /** Every log entry after `logId`, across sessions, oldest first. */
  logAfter(logId: number): LogEntry[] {
    return logDb.logAfter(this.db, logId);
  }

  /** Log entries after the consolidation watermark, oldest first. */
  unconsolidatedLog(limit: number): LogEntry[] {
    return logDb.unconsolidatedLog(this.db, limit);
  }

  consolidatedThrough(): number {
    return logDb.consolidatedThrough(this.db);
  }

  markConsolidated(throughLogId: number): void {
    logDb.markConsolidated(this.db, throughLogId);
  }

  // ---- delegated work (store/workspaces-tasks.ts) --------------------------------------

  createWorkspace(w: { kind: WorkspaceKind; name: string; title: string; purpose: string; folder: string; agents: string[] }): Workspace {
    return workDb.createWorkspace(this.db, w);
  }

  getWorkspace(id: number): Workspace | undefined {
    return workDb.getWorkspace(this.db, id);
  }

  /** Points a workspace at its folder's new location (the secretary was moved). */
  moveWorkspace(id: number, folder: string): Workspace {
    return workDb.moveWorkspace(this.db, id, folder);
  }

  /** Retires a workspace whose folder was moved aside to `folder`; its tasks keep pointing at it. */
  archiveWorkspace(id: number, folder: string): Workspace {
    return workDb.archiveWorkspace(this.db, id, folder);
  }

  quickWorkspace(): Workspace | undefined {
    return workDb.quickWorkspace(this.db);
  }

  /** Workspaces still taking work, most recently used first, with how many tasks each has handled. */
  listWorkspaces(): Array<Workspace & { task_count: number }> {
    return workDb.listWorkspaces(this.db);
  }

  /** review: the plan said "검수 대기: 예" (the user sees the result before it is done). */
  createTask(t: { workspaceId: number; name: string; title: string; goal: string; outputDir: string; review?: boolean }): Task {
    return workDb.createTask(this.db, t);
  }

  getTask(id: number): TaskWithWorkspace | undefined {
    return workDb.getTask(this.db, id);
  }

  /** Only the given fields change; returns undefined if there is no such task. */
  updateTask(id: number, patch: { status?: TaskStatus; sessionRef?: string; result?: string; review?: boolean }): TaskWithWorkspace | undefined {
    return workDb.updateTask(this.db, id, patch);
  }

  /** Most recently updated first. */
  listTasks(opts?: { status?: TaskStatus; workspaceId?: number; limit?: number }): TaskWithWorkspace[] {
    return workDb.listTasks(this.db, opts);
  }

  /** In 'review' since before `before` (ISO), longest waiting first. */
  reviewWaiting(before: string): TaskWithWorkspace[] {
    return workDb.reviewWaiting(this.db, before);
  }

  // ---- meta / usage (store/meta-usage.ts) ----------------------------------------

  getMeta(key: string): string | undefined {
    return metaDb.getMeta(this.db, key);
  }

  setMeta(key: string, value: string): void {
    metaDb.setMeta(this.db, key, value);
  }

  /** A meta value stored as JSON (see setJson). */
  getJson<T>(key: string): T | undefined {
    return metaDb.getJson<T>(this.db, key);
  }

  setJson(key: string, value: unknown): void {
    metaDb.setJson(this.db, key, value);
  }

  /**
   * The "tell once" notices: true (and `mark` saved under `key`) unless the saved mark already
   * covers this one (`covered`, by default: the same mark).
   */
  markOnce(key: string, mark: string, covered?: (last: string) => boolean): boolean {
    return metaDb.markOnce(this.db, key, mark, covered);
  }

  /** Drops per-session meta keys (prefix + session id) of sessions with nothing logged for `idleMs`. Returns how many. */
  pruneSessionMeta(prefixes: string[], idleMs: number, now?: number): number {
    return metaDb.pruneSessionMeta(this.db, prefixes, idleMs, now);
  }

  deleteMeta(key: string): void {
    metaDb.deleteMeta(this.db, key);
  }

  metaWithPrefix(prefix: string): Array<{ key: string; value: string }> {
    return metaDb.metaWithPrefix(this.db, prefix);
  }

  logUsage(event: string, tokens: number, detail?: unknown): void {
    metaDb.logUsage(this.db, event, tokens, detail);
  }

  /**
   * Memory ids auto-injected into this session since its context was last
   * reset (/clear, compaction). Those are still in the conversation, so
   * injecting them again would only pay for them twice.
   */
  injectedIds(sessionId: string): Set<number> {
    return metaDb.injectedIds(this.db, sessionId);
  }

  // ---- mistake guards (store/guards.ts) -----------------------------------------

  /** One turn's tool names and check results (the Stop hook, when the turn really ends). */
  saveTurnTools(t: { sessionId: string; turnUuid: string; tools: string[]; guard: GuardHit[] }): void {
    guardDb.saveTurnTools(this.db, t);
  }

  /** Newest first. */
  turnTools(opts?: { sessionId?: string; limit?: number }): TurnTools[] {
    return guardDb.turnTools(this.db, opts);
  }

  recordMistake(m: NewMistake): Mistake {
    return guardDb.recordMistake(this.db, m);
  }

  updateMistake(id: number, patch: { guard?: string; evalIds?: string[]; recurred?: boolean; harm?: string; ruleRef?: string }): Mistake | undefined {
    return guardDb.updateMistake(this.db, id, patch);
  }

  /** Newest first. */
  listMistakes(opts?: { group?: string; cause?: MistakeCause; limit?: number }): Mistake[] {
    return guardDb.listMistakes(this.db, opts);
  }

  mistakeGroups(): ReturnType<typeof guardDb.mistakeGroups> {
    return guardDb.mistakeGroups(this.db);
  }

  /** Counts across every part of the DB (the stats tool, the CLI, the hooks' notices). */
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
