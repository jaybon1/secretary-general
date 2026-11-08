import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/store/schema.ts';
import { Store } from '../src/store/store.ts';
import { tempDir, tempStore, testDb, testStore } from './helpers.ts';

/** The schema before raw_log got AUTOINCREMENT. */
const BEFORE = 10;

/** A DB on the old schema with what the rebuild must keep: gaps in the ids, links to rows, the block list, watermarks. */
function oldDb(): { dir: string; file: string } {
  const dir = tempDir();
  const file = path.join(dir, 'secretary.db');
  const s = testStore(file, BEFORE);
  const t0 = Date.now() - 60_000;
  s.appendLog(
    Array.from({ length: 30 }, (_, i) => ({
      session_id: i % 3 ? 's1' : 's2',
      message_uuid: `m${i + 1}`,
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `대화 ${i + 1} 서울에서 kiwi${i % 5} 이야기`,
      created_at: new Date(t0 + i * 1000).toISOString(),
    })),
  );
  s.remember({ kind: 'fact', content: '첫 기억', sourceLogId: 5 });
  s.remember({ kind: 'fact', content: '둘째 기억', sourceLogId: 12 });
  s.setBigWork({ name: '시험 일', state: '진행 중', sourceLogId: 7 });
  // Deleted the old way: one row in the middle, and the two newest (their ids were free again).
  s.dropLogRows([10, 29, 30], [], 'x', new Date().toISOString());
  s.markConsolidated(28);
  s.setJson('situation_board', { text: '요약: 판', lastLogId: 31, updatedAt: new Date().toISOString() });
  s.setJson('open_questions', { lastLogId: 33, open: [], defs: {} });
  s.db.close();
  return { dir, file };
}

function snapshot(db: DatabaseSync) {
  const all = (sql: string) => db.prepare(sql).all();
  const search = (q: string) => (db.prepare('SELECT rowid FROM raw_log_fts WHERE raw_log_fts MATCH ? ORDER BY rowid').all(q) as Array<{ rowid: number }>).map((r) => r.rowid);
  return {
    rows: all('SELECT id, session_id, message_uuid, role, content, created_at FROM raw_log ORDER BY id'),
    fts: ['서울', 'kiwi3', '이야'].map(search),
    joined: all('SELECT l.id, l.message_uuid FROM raw_log_fts f JOIN raw_log l ON l.id = f.rowid ORDER BY l.id'),
    memories: all('SELECT id, source_log_id FROM memories ORDER BY id'),
    bigWork: all('SELECT id, source_log_id FROM big_work ORDER BY id'),
    meta: all("SELECT key, value FROM meta WHERE key NOT LIKE 'ingest_offset:%' ORDER BY key"),
    purged: all('SELECT * FROM purged_log_ids ORDER BY log_id'),
  };
}

const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const backups = (dir: string) => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')) : []);

test('raw_log becomes AUTOINCREMENT keeping ids, search index and links; a backup is made first', () => {
  const { dir, file } = oldDb();
  const raw = new DatabaseSync(file);
  const before = snapshot(raw);
  raw.close();
  assert.deepEqual(before.fts[0].length, 27);
  assert.deepEqual(backups(dir), []);

  const db = testDb(file);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.deepEqual(snapshot(db), before, 'ids, rows, search index, links, watermarks unchanged');
  assert.match((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'raw_log'").get() as { sql: string }).sql, /AUTOINCREMENT/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'raw_log_session'").get());
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  // The counter starts above every id anything recorded (the open-questions position, 33, is the highest).
  assert.equal(Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'raw_log'").get() as { seq: number }).seq), 33);

  // The backup, named as the daily ones, holds the old schema.
  const made = backups(dir);
  assert.equal(made.length, 1);
  assert.match(made[0], /^secretary-\d{8}-\d{4}\.db$/);
  const old = new DatabaseSync(path.join(dir, 'backups', made[0]), { readOnly: true });
  assert.equal(version(old), BEFORE);
  assert.equal(Number((old.prepare('SELECT count(*) AS n FROM raw_log').get() as { n: number }).n), 27);
  old.close();

  // New rows take ids above it, and the newest ids are not handed out again after a deletion.
  const s = new Store(db);
  s.appendLog([{ session_id: 's1', message_uuid: 'n1', role: 'user', content: '새 질문', created_at: new Date().toISOString() }]);
  assert.deepEqual(s.logAfter(28).map((e) => e.id), [34]);
  s.dropLogRows([34], [], 'x', new Date().toISOString());
  s.appendLog([{ session_id: 's1', message_uuid: 'n2', role: 'user', content: '또 새 질문', created_at: new Date().toISOString() }]);
  assert.deepEqual(s.logAfter(28).map((e) => e.id), [35]);
  db.close();

  // Opened again: nothing to migrate, no second backup.
  testDb(file).close();
  assert.equal(backups(dir).length, 1);
});

test('a failed rebuild leaves the old table as it was', () => {
  const { file } = oldDb();
  const raw = new DatabaseSync(file);
  const before = snapshot(raw);
  // Something in the way of the rebuild: the migration's first statement fails.
  raw.exec('CREATE TABLE raw_log_v11 (x)');
  raw.close();
  assert.throws(() => testDb(file), /raw_log_v11 already exists/);
  // The failed open let go of the file (Windows refuses to move a file that is still open).
  fs.renameSync(file, `${file}.moved`);
  fs.renameSync(`${file}.moved`, file);

  const check = new DatabaseSync(file);
  assert.equal(version(check), BEFORE);
  assert.deepEqual(snapshot(check), before);
  assert.doesNotMatch((check.prepare("SELECT sql FROM sqlite_master WHERE name = 'raw_log'").get() as { sql: string }).sql, /AUTOINCREMENT/);
  check.exec('DROP TABLE raw_log_v11');
  check.close();
  const db = testDb(file);
  assert.equal(version(db), SCHEMA_VERSION);
  db.close();
});

test('a new DB gets the AUTOINCREMENT table without a backup', () => {
  const s = tempStore();
  assert.match((s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'raw_log'").get() as { sql: string }).sql, /AUTOINCREMENT/);
  assert.deepEqual(backups(path.dirname(s.db.location()!)), []);
  s.appendLog([{ session_id: 's', message_uuid: 'u1', role: 'user', content: 'x', created_at: new Date().toISOString() }]);
  assert.equal(s.logAfter(0)[0].id, 1);
});
