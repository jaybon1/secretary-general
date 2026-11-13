/**
 * 맡긴 일의 기록: 작업 공간(workspaces)과 업무(tasks)를 DB에 읽고 쓰는 함수들.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './schema.ts';
import { nowIso } from '../core/kst-time.ts';

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

// ---- workspaces -----------------------------------------------------------

export function createWorkspace(
  db: DatabaseSync,
  w: { kind: WorkspaceKind; name: string; title: string; purpose: string; folder: string; agents: string[] },
): Workspace {
  const now = nowIso();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO workspaces (kind, name, title, purpose, folder, agents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(w.kind, w.name, w.title, w.purpose, w.folder, w.agents.join(','), now, now);
  return getWorkspace(db, Number(lastInsertRowid)) as Workspace;
}

export function getWorkspace(db: DatabaseSync, id: number): Workspace | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined;
}

/** Points a workspace at its folder's new location (the secretary was moved). */
export function moveWorkspace(db: DatabaseSync, id: number, folder: string): Workspace {
  db.prepare('UPDATE workspaces SET folder = ?, updated_at = ? WHERE id = ?').run(folder, nowIso(), id);
  return getWorkspace(db, id) as Workspace;
}

/** Retires a workspace whose folder was moved aside to `folder`; its tasks keep pointing at it. */
export function archiveWorkspace(db: DatabaseSync, id: number, folder: string): Workspace {
  const now = nowIso();
  const { changes } = db
    .prepare('UPDATE workspaces SET folder = ?, archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
    .run(folder, now, now, id);
  if (!changes) throw new Error(`공간 #${id}이 없거나 이미 보관됨`);
  return getWorkspace(db, id) as Workspace;
}

export function quickWorkspace(db: DatabaseSync): Workspace | undefined {
  return db
    .prepare("SELECT * FROM workspaces WHERE kind = 'quick' AND archived_at IS NULL ORDER BY id LIMIT 1")
    .get() as Workspace | undefined;
}

/** Workspaces still taking work, most recently used first, with how many tasks each has handled. */
export function listWorkspaces(db: DatabaseSync): Array<Workspace & { task_count: number }> {
  return db
    .prepare(
      `SELECT w.*, (SELECT count(*) FROM tasks t WHERE t.workspace_id = w.id) AS task_count
       FROM workspaces w WHERE w.archived_at IS NULL ORDER BY w.updated_at DESC, w.id DESC`,
    )
    .all() as unknown as Array<Workspace & { task_count: number }>;
}

// ---- tasks ----------------------------------------------------------------

export function createTask(db: DatabaseSync, t: { workspaceId: number; name: string; title: string; goal: string; outputDir: string }): Task {
  const now = nowIso();
  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO tasks (workspace_id, name, title, goal, output_dir, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
      )
      .run(t.workspaceId, t.name, t.title, t.goal, t.outputDir, now, now);
    db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(now, t.workspaceId);
    return getTask(db, Number(lastInsertRowid)) as Task;
  });
}

export function getTask(db: DatabaseSync, id: number): TaskWithWorkspace | undefined {
  return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskWithWorkspace | undefined;
}

/** Only the given fields change; returns undefined if there is no such task. */
export function updateTask(
  db: DatabaseSync,
  id: number,
  patch: { status?: TaskStatus; sessionRef?: string; result?: string },
): TaskWithWorkspace | undefined {
  const { changes } = db
    .prepare(
      `UPDATE tasks SET status = coalesce(?, status), session_ref = coalesce(?, session_ref),
                        result = coalesce(?, result), updated_at = ?
       WHERE id = ?`,
    )
    .run(patch.status ?? null, patch.sessionRef ?? null, patch.result ?? null, nowIso(), id);
  return Number(changes) ? getTask(db, id) : undefined;
}

/** Most recently updated first. */
export function listTasks(db: DatabaseSync, opts: { status?: TaskStatus; workspaceId?: number; limit?: number } = {}): TaskWithWorkspace[] {
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
  return db
    .prepare(
      `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
    )
    .all(...params, opts.limit ?? 20) as unknown as TaskWithWorkspace[];
}
