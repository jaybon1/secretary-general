import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.ts';

/**
 * Schema migrations, applied in order. PRAGMA user_version records how many ran.
 * Append new entries; never edit a shipped one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Tier 1: core profile. Every update is a new version; the latest row is current.
  CREATE TABLE profile (
    version    INTEGER PRIMARY KEY,
    content    TEXT NOT NULL,
    reason     TEXT,
    tokens     INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Tier 3: raw conversation archive. Written by the Stop hook, never by the model.
  CREATE TABLE raw_log (
    id           INTEGER PRIMARY KEY,
    session_id   TEXT NOT NULL,
    message_uuid TEXT NOT NULL UNIQUE,
    role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX raw_log_session ON raw_log (session_id, id);
  CREATE VIRTUAL TABLE raw_log_fts USING fts5 (terms);

  -- Tier 2: distilled memories. Facts are invalidated (valid_to), never overwritten.
  CREATE TABLE memories (
    id               INTEGER PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'event', 'task', 'person', 'note')),
    content          TEXT NOT NULL,
    tags             TEXT NOT NULL DEFAULT '',
    importance       INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    valid_from       TEXT NOT NULL,
    valid_to         TEXT,
    superseded_by    INTEGER REFERENCES memories (id),
    invalid_reason   TEXT,
    source_session   TEXT,
    source_log_id    INTEGER REFERENCES raw_log (id),
    created_at       TEXT NOT NULL,
    last_accessed_at TEXT,
    access_count     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX memories_valid ON memories (valid_to, kind);
  CREATE VIRTUAL TABLE memories_fts USING fts5 (terms);

  -- What each injection/recall cost, so budgets can be tuned from real numbers.
  CREATE TABLE usage_log (
    id         INTEGER PRIMARY KEY,
    event      TEXT NOT NULL,
    tokens     INTEGER NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // Per-term document frequency, used to tell specific matches from common bigrams.
  `CREATE VIRTUAL TABLE memories_vocab USING fts5vocab (memories_fts, 'row');`,
  // Delegated work: one row per workspace folder the secretary hands to a worker session.
  `
  CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    title       TEXT NOT NULL,
    folder      TEXT NOT NULL UNIQUE,
    goal        TEXT NOT NULL,
    agents      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL CHECK (status IN ('ready', 'running', 'done', 'failed', 'cancelled')),
    session_ref TEXT,
    result      TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX tasks_status ON tasks (status, updated_at);
  `,
  // A folder is now a reusable workspace (quick / solo / team) holding many tasks,
  // each with its own output/<date>-<name>/ directory.
  `
  CREATE TABLE workspaces (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('quick', 'solo', 'team')),
    name       TEXT NOT NULL,
    title      TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    folder     TEXT NOT NULL UNIQUE,
    agents     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO workspaces (kind, name, title, purpose, folder, agents, created_at, updated_at)
    SELECT CASE WHEN agents = '' THEN 'solo' ELSE 'team' END, name, title, goal, folder, agents, created_at, updated_at
    FROM tasks;

  CREATE TABLE tasks_v4 (
    id           INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
    name         TEXT NOT NULL,
    title        TEXT NOT NULL,
    goal         TEXT NOT NULL,
    output_dir   TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('ready', 'running', 'done', 'failed', 'cancelled')),
    session_ref  TEXT,
    result       TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE (workspace_id, output_dir)
  );
  INSERT INTO tasks_v4 (id, workspace_id, name, title, goal, output_dir, status, session_ref, result, created_at, updated_at)
    SELECT t.id, w.id, t.name, t.title, t.goal, '.', t.status, t.session_ref, t.result, t.created_at, t.updated_at
    FROM tasks t JOIN workspaces w ON w.folder = t.folder;
  DROP TABLE tasks;
  ALTER TABLE tasks_v4 RENAME TO tasks;
  CREATE INDEX tasks_status ON tasks (status, updated_at);
  CREATE INDEX tasks_workspace ON tasks (workspace_id, id);
  `,
  // Embeddings for semantic search, written by the helper process (semantic.ts).
  // Keyed by model so switching models re-embeds instead of mixing vector spaces.
  `
  CREATE TABLE memory_vectors (
    memory_id INTEGER NOT NULL REFERENCES memories (id),
    model     TEXT NOT NULL,
    vector    BLOB NOT NULL,
    PRIMARY KEY (memory_id, model)
  );
  `,
  // Retired workspaces stay for their task history but drop out of the list work is handed to.
  `ALTER TABLE workspaces ADD COLUMN archived_at TEXT;`,
  // access_count now means explicit recalls only and feeds ranking; counts so far included auto-injection.
  `UPDATE memories SET access_count = 0, last_accessed_at = NULL;`,
  // Topic summaries are a memory kind; SQLite can't alter a CHECK, so rebuild the table keeping ids.
  `
  CREATE TABLE memories_v8 (
    id               INTEGER PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'event', 'task', 'person', 'note', 'summary')),
    content          TEXT NOT NULL,
    tags             TEXT NOT NULL DEFAULT '',
    importance       INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    valid_from       TEXT NOT NULL,
    valid_to         TEXT,
    superseded_by    INTEGER REFERENCES memories (id),
    invalid_reason   TEXT,
    source_session   TEXT,
    source_log_id    INTEGER REFERENCES raw_log (id),
    created_at       TEXT NOT NULL,
    last_accessed_at TEXT,
    access_count     INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO memories_v8 SELECT * FROM memories;
  DROP TABLE memories;
  ALTER TABLE memories_v8 RENAME TO memories;
  CREATE INDEX memories_valid ON memories (valid_to, kind);
  `,
];

export function openDb(file: string = DB_PATH): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
  `);
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (current >= MIGRATIONS.length) return;
  // Table rebuilds drop a referenced table; foreign keys can only be switched off outside a transaction.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      transaction(db, () => {
        db.exec(MIGRATIONS[v]);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`migration ${v + 1} broke ${broken.length} foreign keys`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
