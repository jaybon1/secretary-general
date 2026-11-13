import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../core/config.ts';
import { formatLocal, nowIso } from '../core/kst-time.ts';

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
  // Embeddings for semantic search, written by the server process (semantic-search/client.ts).
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
  // The big-work board, out of the profile: one row per change, the latest row per name is its state.
  // Append-only, so every change keeps its history. The user's-turn state was once named after the user; migration 15
  // renames it in a DB made before, so this one (run only by a DB older than 10) already takes today's name.
  `
  CREATE TABLE big_work (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('진행 중', '사용자 차례', '보류', '운영 중', '끝남', '지움')),
    note          TEXT NOT NULL DEFAULT '',
    source_log_id INTEGER REFERENCES raw_log (id),
    created_at    TEXT NOT NULL
  );
  CREATE INDEX big_work_name ON big_work (name, id);
  `,
  // Conversation rows the user deleted ("비서 대화 삭제", log/purge.ts): identifiers only, so ingest never logs them again.
  // The rows themselves went to a separate file under backups/error/ that may be deleted any time; this list stays.
  `
  CREATE TABLE purged_log_ids (
    message_uuid TEXT PRIMARY KEY,
    log_id       INTEGER NOT NULL,
    session_id   TEXT NOT NULL,
    purged_at    TEXT NOT NULL
  );
  `,
  // raw_log ids are never handed out again (AUTOINCREMENT): deleting the newest rows (rewind, "비서 대화 삭제") used to
  // free their ids for the next rows, so a watermark or a quarantined row could point at a different conversation.
  // Rebuilt keeping every id (the search index, memories.source_log_id and big_work.source_log_id key on them);
  // the counter starts above every id anything recorded, deleted rows and watermarks included.
  `
  CREATE TABLE raw_log_v11 (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    message_uuid TEXT NOT NULL UNIQUE,
    role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  INSERT INTO raw_log_v11 (id, session_id, message_uuid, role, content, created_at)
    SELECT id, session_id, message_uuid, role, content, created_at FROM raw_log ORDER BY id;
  DROP TABLE raw_log;
  ALTER TABLE raw_log_v11 RENAME TO raw_log;
  CREATE INDEX raw_log_session ON raw_log (session_id, id);
  DELETE FROM sqlite_sequence WHERE name IN ('raw_log', 'raw_log_v11');
  INSERT INTO sqlite_sequence (name, seq) SELECT 'raw_log', max(
    (SELECT coalesce(max(id), 0) FROM raw_log),
    (SELECT coalesce(max(log_id), 0) FROM purged_log_ids),
    coalesce((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'consolidated_through_log_id'), 0),
    coalesce((SELECT CASE WHEN json_valid(value) THEN CAST(json_extract(value, '$.lastLogId') AS INTEGER) END FROM meta WHERE key = 'situation_board'), 0),
    coalesce((SELECT CASE WHEN json_valid(value) THEN CAST(json_extract(value, '$.lastLogId') AS INTEGER) END FROM meta WHERE key = 'open_questions'), 0)
  );
  `,
  // Mistake guards (feature 'mistake-guards', src/mistake-guards/): the tools each turn called and what the Stop hook's checks found
  // (one row per turn, written when the turn really ends), and the mistakes record the secretary writes itself
  // (record_mistake). Both are for measuring mistakes and grading the eval set; nothing reads them to answer.
  `
  CREATE TABLE turn_tools (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL,
    turn_uuid   TEXT NOT NULL,
    tools       TEXT NOT NULL,
    guard       TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    UNIQUE (session_id, turn_uuid)
  );
  CREATE TABLE mistakes (
    id          INTEGER PRIMARY KEY,
    happened_at TEXT NOT NULL,
    session_id  TEXT,
    what        TEXT NOT NULL,
    made_by     TEXT NOT NULL,
    found_by    TEXT NOT NULL CHECK (found_by IN ('사용자', '비서', '검수', '장치')),
    group_name  TEXT NOT NULL,
    cause       TEXT NOT NULL CHECK (cause IN ('규칙 없음', '안 지킴', '정보 부족', '도구 부족')),
    log_ids     TEXT NOT NULL DEFAULT '',
    rule_ref    TEXT NOT NULL DEFAULT '',
    harm        TEXT NOT NULL DEFAULT '',
    guard       TEXT NOT NULL DEFAULT '',
    eval_ids    TEXT NOT NULL DEFAULT '',
    recurred    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX mistakes_group ON mistakes (group_name, id);
  `,
  // A task whose result the user must see for themselves (screens, video, design) waits in 'review' after the report
  // is checked, and is done only once the user says so. review_needed is the plan's "검수 대기: 예"; review_since is when
  // it went into review (asked again after a few days). SQLite can't alter a CHECK, so the table is rebuilt keeping ids.
  `
  CREATE TABLE tasks_v13 (
    id            INTEGER PRIMARY KEY,
    workspace_id  INTEGER NOT NULL REFERENCES workspaces (id),
    name          TEXT NOT NULL,
    title         TEXT NOT NULL,
    goal          TEXT NOT NULL,
    output_dir    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('ready', 'running', 'review', 'done', 'failed', 'cancelled')),
    session_ref   TEXT,
    result        TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    review_needed INTEGER NOT NULL DEFAULT 0,
    review_since  TEXT,
    UNIQUE (workspace_id, output_dir)
  );
  INSERT INTO tasks_v13 (id, workspace_id, name, title, goal, output_dir, status, session_ref, result, created_at, updated_at)
    SELECT id, workspace_id, name, title, goal, output_dir, status, session_ref, result, created_at, updated_at FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v13 RENAME TO tasks;
  CREATE INDEX tasks_status ON tasks (status, updated_at);
  CREATE INDEX tasks_workspace ON tasks (workspace_id, id);
  `,
  // 14: emptied (2026-11-10). It moved the weekly tool notice's old meta key to its new name; the one DB that had the old
  // key has run it, and at worst one old report shows again. Its slot stays: the version is counted by this array's order.
  '',
  // The big-work state "the user's turn" is '사용자 차례' (2026-11-10): it used to carry the user's own name, which belongs
  // in the profile, not in the code. SQLite can't alter a CHECK, so the table is rebuilt keeping ids and history. Any state
  // outside the other five is the old CHECK's user's-turn value, whichever name it had (a release DB already has
  // '사용자 차례' and keeps it), so the old name is never written here.
  `
  CREATE TABLE big_work_v15 (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('진행 중', '사용자 차례', '보류', '운영 중', '끝남', '지움')),
    note          TEXT NOT NULL DEFAULT '',
    source_log_id INTEGER REFERENCES raw_log (id),
    created_at    TEXT NOT NULL
  );
  INSERT INTO big_work_v15 (id, name, state, note, source_log_id, created_at)
    SELECT id, name, CASE WHEN state IN ('진행 중', '보류', '운영 중', '끝남', '지움') THEN state ELSE '사용자 차례' END, note, source_log_id, created_at
    FROM big_work ORDER BY id;
  DROP TABLE big_work;
  ALTER TABLE big_work_v15 RENAME TO big_work;
  CREATE INDEX big_work_name ON big_work (name, id);
  `,
  // No more waiting for the user's look (2026-11-12): a task is closed as done once the secretary has checked its report,
  // so the 'review' status and its two fields go. A task still in 'review' is done. Rebuilt keeping ids and records.
  `
  CREATE TABLE tasks_v16 (
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
  INSERT INTO tasks_v16 (id, workspace_id, name, title, goal, output_dir, status, session_ref, result, created_at, updated_at)
    SELECT id, workspace_id, name, title, goal, output_dir, CASE WHEN status = 'review' THEN 'done' ELSE status END,
           session_ref, result, created_at, updated_at
    FROM tasks ORDER BY id;
  DROP TABLE tasks;
  ALTER TABLE tasks_v16 RENAME TO tasks;
  CREATE INDEX tasks_status ON tasks (status, updated_at);
  CREATE INDEX tasks_workspace ON tasks (workspace_id, id);
  `,
  // Names (2026-11-12): the big-work board is the main agenda (main_agenda, "주요 현안"); the memory kind 'task' is
  // 'action' ("할 일", apart from the tasks table of delegated work); mistakes.eval_ids, unread since the eval set went,
  // is dropped. The memories table is rebuilt (SQLite can't alter a CHECK) keeping ids, so memories_fts (rowid = id),
  // memory_vectors and superseded_by still point at the same rows; it has no triggers. Contents keep the words they had.
  `
  ALTER TABLE big_work RENAME TO main_agenda;
  DROP INDEX big_work_name;
  CREATE INDEX main_agenda_name ON main_agenda (name, id);
  ALTER TABLE mistakes DROP COLUMN eval_ids;
  CREATE TABLE memories_v17 (
    id               INTEGER PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'event', 'action', 'person', 'note', 'summary')),
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
  INSERT INTO memories_v17 (id, kind, content, tags, importance, valid_from, valid_to, superseded_by, invalid_reason,
                            source_session, source_log_id, created_at, last_accessed_at, access_count)
    SELECT id, CASE WHEN kind = 'task' THEN 'action' ELSE kind END, content, tags, importance, valid_from, valid_to, superseded_by,
           invalid_reason, source_session, source_log_id, created_at, last_accessed_at, access_count
    FROM memories ORDER BY id;
  DROP TABLE memories;
  ALTER TABLE memories_v17 RENAME TO memories;
  CREATE INDEX memories_valid ON memories (valid_to, kind);
  `,
  // 2026-11-13 (the user's calls): (1) a decision memory keeps a short quote of the user's own words, checked
  // by code to stand word for word in a logged user message (memory/source-quote.ts): its own table, so the memories table
  // is not rebuilt and older memories simply have none. status: 'pending' until the turn it was saved in is logged (the
  // Stop hook links it), 'found' with the row and line it stands on, 'missing' when it is in none. (2) The mistakes record
  // had one kind of slip, a recommendation made without checking its source, under four group names; they become one
  // ('확인 없이 추천', mistake-guards/answer-check-table.ts RECOMMEND_UNCHECKED), and the repeat flag is counted again.
  `
  CREATE TABLE IF NOT EXISTS memory_quotes (
    memory_id  INTEGER PRIMARY KEY REFERENCES memories (id),
    quote      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('pending', 'found', 'missing')),
    log_id     INTEGER REFERENCES raw_log (id),
    line       INTEGER,
    checked_at TEXT
  );
  UPDATE mistakes SET group_name = '확인 없이 추천'
    WHERE group_name IN ('근거 없는 추천', '확인 없이 추천', '추천 근거 안 봄', 'basis-unopened');
  UPDATE mistakes SET recurred = CASE WHEN id = (
      SELECT m2.id FROM mistakes m2 WHERE m2.group_name = '확인 없이 추천' ORDER BY m2.happened_at, m2.id LIMIT 1
    ) THEN 0 ELSE 1 END
    WHERE group_name = '확인 없이 추천';
  `,
];

/** The schema a fully migrated DB has (its PRAGMA user_version). */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** `upTo` stops at an older schema (tests of a migration); everything else takes them all. */
export function openDb(file: string = DB_PATH, upTo: number = MIGRATIONS.length): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
    `);
    migrate(db, upTo);
  } catch (err) {
    // A failed migration (or pragma) must not leave the file held open: the caller only gets the error.
    db.close();
    throw err;
  }
  return db;
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/**
 * The DB as a daily backup names it (secretary-YYYYMMDD-HHMM.db, local time) in `dir`, by default backups/ beside
 * the DB, so scripts/scheduled/backup-db.ps1 rotates it and sends it to the main PC like the others. VACUUM INTO reads one
 * consistent snapshot without blocking other connections. With `reuse`, a file of the same minute counts as done.
 */
export function backupDb(db: DatabaseSync, dir?: string, reuse = false): string {
  const target = dir ?? path.join(path.dirname(db.location() ?? '.'), 'backups');
  fs.mkdirSync(target, { recursive: true });
  const stamp = formatLocal(nowIso()).replace(/[-:]/g, '').replace(' ', '-');
  const file = path.join(target, `secretary-${stamp}.db`);
  if (reuse && fs.existsSync(file)) return file;
  try {
    db.prepare('VACUUM INTO ?').run(file);
  } catch (err) {
    // Another process (a hook, the MCP server) made it in the same moment.
    if (!(reuse && fs.existsSync(file))) throw err;
  }
  return file;
}

function migrate(db: DatabaseSync, upTo: number): void {
  const current = userVersion(db);
  if (current >= upTo) return;
  // An existing DB (not a fresh one) is copied before any migration runs; a failed copy stops the migration.
  if (current > 0 && db.location()) backupDb(db, undefined, true);
  // Table rebuilds drop a referenced table; foreign keys can only be switched off outside a transaction.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = current; v < upTo; v++) {
      transaction(db, () => {
        // Another process (MCP server, a hook) may have run it while this one waited for the write lock.
        if (userVersion(db) > v) return;
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
