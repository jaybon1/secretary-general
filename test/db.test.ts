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
  // The board's table had its old name then (main_agenda from 17); today's code that unlinks it sees it under the new one meanwhile.
  s.db.prepare("INSERT INTO big_work (name, state, source_log_id, created_at) VALUES ('시험 일', '진행 중', 7, ?)").run(new Date().toISOString());
  s.db.exec('ALTER TABLE big_work RENAME TO main_agenda');
  // Deleted the old way: one row in the middle, and the two newest (their ids were free again).
  s.dropLogRows([10, 29, 30], [], 'x', new Date().toISOString());
  s.db.exec('ALTER TABLE main_agenda RENAME TO big_work');
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
    mainAgenda: all(`SELECT id, source_log_id FROM ${version(db) < 17 ? 'big_work' : 'main_agenda'} ORDER BY id`),
    meta: all("SELECT key, value FROM meta WHERE key NOT LIKE 'ingest_offset:%' ORDER BY key"),
    purged: all('SELECT * FROM purged_log_ids ORDER BY log_id'),
  };
}

const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const backups = (dir: string) => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')) : []);

// [늘 남김] 없으면 놓치는 실수: 대화 기록 표를 다시 만들며 id·검색 색인·기억 연결이 어긋나거나, 백업 없이 옮긴다(DB 옮기기).
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

// [늘 남김] 없으면 놓치는 실수: 표 다시 만들기가 도중에 실패했는데 옛 표가 반쯤 바뀐 채 남아 대화 기록을 잃는다(DB 옮기기).
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

// [늘 남김] 없으면 놓치는 실수: 백업할 옮기기 번호를 목록으로 골라 두면, 새 옮기기를 목록에 안 넣었을 때 백업 없이 기존 DB를 바꾼다.
test('an existing DB is backed up before any migration, not only a table rebuild; an up-to-date one is not', () => {
  const dir = tempDir();
  const file = path.join(dir, 'secretary.db');
  testStore(file, 11).db.close();
  assert.deepEqual(backups(dir), []);
  // 12 rebuilds no table.
  testDb(file, 12).close();
  const made = backups(dir);
  assert.equal(made.length, 1);
  const old = new DatabaseSync(path.join(dir, 'backups', made[0]), { readOnly: true });
  assert.equal(version(old), 11);
  old.close();
  fs.rmSync(path.join(dir, 'backups'), { recursive: true });
  testDb(file, 12).close();
  assert.deepEqual(backups(dir), [], 'nothing to migrate, no backup');
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
// [늘 남김] 없으면 놓치는 실수: 비운 옮기기 자리(14번)를 배열에서 지워 버전 수가 줄어, 이미 15인 DB에서는 뒤에 더한 옮기기가 돌지 않고 13인 DB는 15를 건너뛴다.
test('an emptied migration keeps its slot: a DB at 13 still opens at the full version, which never goes below 15', () => {
  assert.ok(SCHEMA_VERSION >= 15, 'the version the real DBs already have');
  const file = path.join(tempDir(), 'secretary.db');
  testStore(file, 13).db.close();
  const db = testDb(file);
  assert.equal(version(db), SCHEMA_VERSION);
  db.close();
});

// [늘 남김] 없으면 놓치는 실수: 검수 대기를 없애며 tasks를 다시 만들 때 업무 번호·기록이 바뀌거나, 검수 대기에 남아 있던 업무가 어느 칸에도 없는 상태로 남는다.
test('migration 16: tasks keep their ids and records, a task still in review is done, and the review fields are gone; a backup is made first', () => {
  const dir = tempDir();
  const file = path.join(dir, 'secretary.db');
  const old = testStore(file, 15);
  const ws = old.createWorkspace({ kind: 'solo', name: 'video', title: '영상', purpose: '영상 제작', folder: 'C:/ws/video', agents: [] });
  const now = new Date().toISOString();
  const add = old.db.prepare(
    'INSERT INTO tasks (id, workspace_id, name, title, goal, output_dir, status, session_ref, result, created_at, updated_at, review_needed, review_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  add.run(7, ws.id, 'a', 'A', 'g', 'o1', 'review', 'bg:1', '보고 확인함', now, now, 1, now);
  add.run(9, ws.id, 'b', 'B', 'g', 'o2', 'running', null, null, now, now, 1, null);
  add.run(12, ws.id, 'c', 'C', 'g', 'o3', 'failed', 'bg:3', '실패', now, now, 0, null);
  old.db.close();

  const db = testDb(file);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.deepEqual(
    db.prepare('SELECT id, workspace_id, status, session_ref, result, created_at, updated_at FROM tasks ORDER BY id').all().map((r) => ({ ...r })),
    [
      { id: 7, workspace_id: ws.id, status: 'done', session_ref: 'bg:1', result: '보고 확인함', created_at: now, updated_at: now },
      { id: 9, workspace_id: ws.id, status: 'running', session_ref: null, result: null, created_at: now, updated_at: now },
      { id: 12, workspace_id: ws.id, status: 'failed', session_ref: 'bg:3', result: '실패', created_at: now, updated_at: now },
    ],
  );
  const columns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!columns.includes('review_needed') && !columns.includes('review_since'), columns.join(','));
  assert.throws(() => db.prepare("UPDATE tasks SET status = 'review' WHERE id = 9").run(), /CHECK constraint/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tasks_workspace'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tasks_status'").get());
  db.close();
  assert.equal(backups(dir).length, 1, 'the old DB is copied before the rebuild');
});

// [늘 남김] 없으면 놓치는 실수: 이름 바꾸기(17)에서 기억 표를 다시 만들며 id·검색 색인·벡터·대체 연결이 어긋나거나, 'task' 기억이 새 CHECK에 걸려
// 옮기기가 멈추거나, 주요 현안 이력·실수 기록을 잃는다(2026-11-12 이름 바꾸기).
test('migration 17: big_work becomes main_agenda, memory kind task becomes action, mistakes.eval_ids goes; ids, search, vectors and links kept', () => {
  const dir = tempDir();
  const file = path.join(dir, 'secretary.db');
  const old = testStore(file, 16);
  const at = '2026-11-01T00:00:00.000Z';
  old.appendLog([{ session_id: 's', message_uuid: 'u1', role: 'user', content: '이사 계약 이야기', created_at: at }]);
  const first = old.remember({ kind: 'fact', content: '이사 날짜는 12월 1일이다', sourceLogId: 1 });
  old.remember({ kind: 'note', content: '지울 기억' });
  const action = old.remember({ kind: 'task' as never, content: '집주인에게 계약서 보내기', sourceLogId: 1 });
  const later = old.remember({ kind: 'fact', content: '이사 날짜는 12월 8일이다', supersedes: [first.id] });
  old.db.prepare('INSERT INTO memory_vectors (memory_id, model, vector) VALUES (?, ?, ?)').run(action.id, 'm', new Uint8Array([1, 2, 3]));
  const agenda = old.db.prepare('INSERT INTO big_work (name, state, note, source_log_id, created_at) VALUES (?, ?, ?, ?, ?)');
  agenda.run('이사', '진행 중', '', null, at);
  agenda.run('이사', '사용자 차례', '계약서', 1, at);
  old.recordMistake({ what: '보고를 영어로 씀', group: '영어 답', madeBy: '비서', foundBy: '장치', cause: '안 지킴', logIds: [1] });
  old.db.prepare("UPDATE mistakes SET eval_ids = 'E1'").run();
  const rows = (db: DatabaseSync, sql: string, ...params: string[]) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
  const memories = (db: DatabaseSync) => rows(db, 'SELECT * FROM memories ORDER BY id');
  // The search index is keyed by memory id (rowid): each entry must still join to the same memory.
  const search = (db: DatabaseSync) => rows(db, 'SELECT f.rowid AS id, f.terms, m.content FROM memories_fts f JOIN memories m ON m.id = f.rowid ORDER BY f.rowid');
  const before = {
    memories: memories(old.db).map((m) => ({ ...m, kind: m.kind === 'task' ? 'action' : m.kind })),
    search: search(old.db),
    vectors: rows(old.db, 'SELECT * FROM memory_vectors'),
    agenda: rows(old.db, 'SELECT * FROM big_work ORDER BY id'),
    mistakes: rows(old.db, 'SELECT * FROM mistakes').map(({ eval_ids: _, ...m }) => m),
  };
  old.db.close();
  assert.equal(before.search.length, 4);

  const s = testStore(file);
  assert.equal(version(s.db), SCHEMA_VERSION);
  assert.deepEqual(memories(s.db), before.memories, 'same ids, rows and supersede links; task is action');
  assert.equal(memories(s.db).find((m) => m.id === first.id)?.superseded_by, later.id);
  assert.deepEqual(search(s.db), before.search, 'the search index still points at the same rows');
  assert.deepEqual(s.searchMemories('계약서', { limit: 5 }).map((m) => m.id), [action.id]);
  assert.deepEqual(rows(s.db, 'SELECT * FROM memory_vectors'), before.vectors);
  assert.deepEqual(rows(s.db, 'SELECT * FROM main_agenda ORDER BY id'), before.agenda);
  assert.deepEqual(s.mainAgendaHistory('이사').map((r) => r.state), ['진행 중', '사용자 차례']);
  assert.deepEqual(rows(s.db, 'SELECT * FROM mistakes'), before.mistakes, 'eval_ids gone, the rest kept');
  assert.deepEqual(s.listMemories({ kind: 'action' }).map((m) => m.id), [action.id]);
  const names = rows(s.db, "SELECT name FROM sqlite_master WHERE name LIKE 'big_work%' OR name LIKE 'main_agenda%' OR name LIKE 'memories%' ORDER BY name").map((r) => r.name);
  assert.deepEqual(names, ['main_agenda', 'main_agenda_name', 'memories', 'memories_fts', 'memories_fts_config', 'memories_fts_content', 'memories_fts_data', 'memories_fts_docsize', 'memories_fts_idx', 'memories_valid', 'memories_vocab']);
  assert.throws(() => s.db.prepare("UPDATE memories SET kind = 'task' WHERE id = ?").run(action.id), /CHECK constraint/);
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((s.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok');
  s.db.close();
  assert.equal(backups(dir).length, 1, 'the old DB is copied before the rebuild');
});

// [늘 남김] 없으면 놓치는 실수: 같은 실수를 네 이름으로 적어 재발로 세지 못하던 기록(근거 없는 추천·확인 없이 추천·추천 근거 안 봄·basis-unopened)이 옮기기(18) 뒤에도 갈라져 있거나, 다른 분류까지 바뀌거나, 결정 원문 표가 없어 저장이 실패한다.
test('migration 18: the four group names of recommending without checking become one, repeats counted again; decision quotes get their table', () => {
  const file = path.join(tempDir(), 'm18.db');
  const db = testDb(file, 17);
  const add = db.prepare("INSERT INTO mistakes (happened_at, what, made_by, found_by, group_name, cause, recurred, created_at) VALUES (?, 'x', '비서', '사용자', ?, '안 지킴', 0, '2026-11-13T00:00:00Z')");
  for (const [at, g] of [['2026-11-01T00:00:00Z', '추천 근거 안 봄'], ['2026-10-30T00:00:00Z', '근거 없는 추천'], ['2026-11-05T00:00:00Z', 'basis-unopened'], ['2026-11-06T00:00:00Z', '확인 없이 추천'], ['2026-11-06T00:00:00Z', '지어낸 말']]) add.run(at, g);
  db.close();
  const s = testStore(file);
  assert.equal(version(s.db), SCHEMA_VERSION);
  const rows = s.db.prepare('SELECT group_name, recurred, happened_at FROM mistakes ORDER BY id').all() as Array<{ group_name: string; recurred: number; happened_at: string }>;
  assert.deepEqual(rows.map((r) => r.group_name), ['확인 없이 추천', '확인 없이 추천', '확인 없이 추천', '확인 없이 추천', '지어낸 말']);
  // The earliest of the merged group is the first; the rest are repeats.
  assert.deepEqual(rows.map((r) => r.recurred), [1, 0, 1, 1, 0]);
  assert.ok(fs.readdirSync(path.join(path.dirname(file), 'backups')).length >= 1, 'migrated after a backup');
  const m = s.remember({ kind: 'decision', content: 'x로 정함.' });
  s.db.prepare("INSERT INTO memory_quotes (memory_id, quote, status) VALUES (?, 'x로 하자', 'pending')").run(m.id);
});
