import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { leftoverRenamedFiles, moveRenamedLocalFiles, RENAMED_LOCAL_FILES } from '../src/core/local-settings.ts';
import { CHECKS } from '../src/setup/check-items.ts';
import { CHECK } from '../src/core/names.ts';
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

// 없으면 놓치는 실수: 이름이 바뀐 이 PC 파일(scripts의 이 PC 설정, 의미 검색 서버의 DB 옆 파일)이 옛 이름으로 남아 읽히지 않는다.
test("this PC's renamed files move once to their new names; a new one already there wins", () => {
  const root = tempDir();
  const db = path.join(root, 'secretary.db');
  fs.mkdirSync(path.join(root, 'scripts'));
  const [oldName, newName] = Object.entries(RENAMED_LOCAL_FILES)[0];
  fs.writeFileSync(path.join(root, ...oldName.split('/')), '[]');
  fs.writeFileSync(`${db}.embedder-failures.log`, 'old log\n');
  fs.writeFileSync(`${db}.embedder.json`, 'old');
  fs.writeFileSync(`${db}.semantic-search-server.json`, 'new');
  const moved = moveRenamedLocalFiles(root, db, {});
  assert.equal(moved.length, 2);
  assert.equal(fs.readFileSync(path.join(root, ...newName.split('/')), 'utf8'), '[]');
  assert.equal(fs.readFileSync(`${db}.semantic-search-server-failures.log`, 'utf8'), 'old log\n');
  assert.equal(fs.readFileSync(`${db}.semantic-search-server.json`, 'utf8'), 'new', 'the new file is kept');
  assert.ok(fs.existsSync(`${db}.embedder.json`), 'the old one is left when both are there');
  assert.deepEqual(moveRenamedLocalFiles(root, db, {}), [], 'once');
  // 없으면 놓치는 실수: 새·옛 이름 파일이 둘 다 있어 옛 파일을 그대로 둔 것을 아무도 모르고, 옛 파일에만 있던 값이 읽히지 않는 채 남는다.
  assert.deepEqual(leftoverRenamedFiles(root, db, {}), [[`${db}.embedder.json`, `${db}.semantic-search-server.json`]]);
  const item = CHECKS.find((c) => c.id === CHECK.renamedLocalFiles)!;
  const out = item.run({ o: { root, dbPath: db } } as Parameters<typeof item.run>[0]) as { status: string; detail?: string };
  assert.equal(out.status, 'missing');
  assert.match(out.detail!, /embedder\.json \(새 이름 secretary\.db\.semantic-search-server\.json 있음\)/);
  fs.rmSync(`${db}.embedder.json`);
  assert.deepEqual(leftoverRenamedFiles(root, db, {}), []);
});

// 없으면 놓치는 실수: 첫 세션 훅보다 의미 검색 서버(cli semantic-search-server)나 다른 cli 명령이 먼저 돌아 새 이름 파일을 만들고,
// 옛 파일이 그대로 남는다(2026-11-09 secretary.db.embedder*.json 두 개). 모든 cli 명령이 무엇보다 먼저 옮긴다.
test('every cli command moves the renamed files first, before it can make a new one', () => {
  const dir = tempDir();
  const db = path.join(dir, 'secretary.db');
  fs.writeFileSync(`${db}.embedder.json`, '{"pid":1}');
  fs.writeFileSync(`${db}.embedder-memory.json`, '{"peakMb":1}');
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'memory-stats'], { encoding: 'utf8', env: { ...process.env, SECRETARY_DB: db } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(`${db}.semantic-search-server.json`, 'utf8'), '{"pid":1}');
  assert.equal(fs.readFileSync(`${db}.semantic-search-server-memory.json`, 'utf8'), '{"peakMb":1}');
  assert.ok(!fs.existsSync(`${db}.embedder.json`) && !fs.existsSync(`${db}.embedder-memory.json`));
});