import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/store/schema.ts';
import { ACTION_COND_KINDS, ACTION_OWNERS, ACTION_STATES, MAIN_AGENDA_STATES, MEMORY_KINDS, MISTAKE_CAUSES, MISTAKE_FINDERS, Store, TASK_STATUSES, WORKSPACE_KINDS } from '../src/store/store.ts';
import { STATUSES as DASHBOARD_STATUSES } from '../src/dashboard/collect.ts';
import { PAIR_VERDICTS } from '../src/memory/memory-pairs.ts';
import { tempDir, tempStore, testDb, testStore } from './helpers.ts';
import { ftsQuery, queryTerms } from '../src/store/search-terms.ts';

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
  // (Since migration 21 the index keeps no copy of its terms, and the tags left memories for the tag tables: compared without them.)
  const search = (db: DatabaseSync) => rows(db, 'SELECT f.rowid AS id, m.content FROM memories_fts f JOIN memories m ON m.id = f.rowid ORDER BY f.rowid');
  const before = {
    memories: memories(old.db).map(({ tags: _, ...m }) => ({ ...m, kind: m.kind === 'task' ? 'action' : m.kind })),
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
  assert.deepEqual(names, ['main_agenda', 'main_agenda_name', 'memories', 'memories_fts', 'memories_fts_config', 'memories_fts_data', 'memories_fts_docsize', 'memories_fts_idx', 'memories_valid', 'memories_vocab']);
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

// [늘 남김] 없으면 놓치는 실수: 답 검사가 검사 id(english, path-prose·path-pair·path-link)로 적은 실수가 옮기기(22) 뒤에도 사람이 쓰던
// 분류(영어 답, 경로 표기)와 갈라져 재발로 세지 못하거나, 다른 분류까지 바뀌거나, 백업 없이 옮긴다.
test('migration 22: the answer checks\' English and path group ids join the groups people wrote, repeats counted again', () => {
  const file = path.join(tempDir(), 'm22.db');
  const db = testDb(file, 21);
  const add = db.prepare("INSERT INTO mistakes (happened_at, what, made_by, found_by, group_name, cause, recurred, created_at) VALUES (?, 'x', '비서', '장치', ?, '안 지킴', 0, '2026-11-18T00:00:00Z')");
  const rows: Array<[string, string]> = [
    ['2026-11-10T00:00:00Z', 'english'],
    ['2026-11-01T00:00:00Z', '영어 답'],
    ['2026-11-12T00:00:00Z', 'path-link'],
    ['2026-11-11T00:00:00Z', 'path-pair'],
    ['2026-11-13T00:00:00Z', 'path-prose'],
    ['2026-11-14T00:00:00Z', '경로 표기'],
    ['2026-11-02T00:00:00Z', '지어낸 말'],
  ];
  for (const [at, g] of rows) add.run(at, g);
  db.close();
  const s = testStore(file);
  assert.equal(version(s.db), SCHEMA_VERSION);
  const got = s.db.prepare('SELECT group_name, recurred FROM mistakes ORDER BY id').all() as Array<{ group_name: string; recurred: number }>;
  assert.deepEqual(got.map((r) => r.group_name), ['영어 답', '영어 답', '경로 표기', '경로 표기', '경로 표기', '경로 표기', '지어낸 말']);
  // In each group the earliest is the first and the rest are repeats; another group is left as it was.
  assert.deepEqual(got.map((r) => r.recurred), [1, 0, 1, 0, 1, 1, 0]);
  assert.ok(fs.readdirSync(path.join(path.dirname(file), 'backups')).length >= 1, 'migrated after a backup');
});

// [늘 남김] 없으면 놓치는 실수: 할 일 표·일정 표를 더하는 옮기기(19)가 기억 표를 건드려 기억·대화가 어긋나거나, 백업 없이 옮기거나, 할 일 표가
// 대화를 가리킨 채 그 대화를 지울 때 외래 키에 막혀 "비서 대화 삭제"가 실패한다.
test('migration 19: the action and calendar tables come after a backup, memories and talk untouched; deleting a cited row unlinks it', () => {
  const file = path.join(tempDir(), 'm19.db');
  const old = testStore(file, 18);
  old.appendLog([{ session_id: 's', message_uuid: 'u1', role: 'user', content: '모종 사기', created_at: new Date().toISOString() }]);
  const action = old.remember({ kind: 'action', content: '토마토 모종을 산다.', sourceLogId: 1 });
  const before = old.db.prepare('SELECT id, kind, content, source_log_id FROM memories ORDER BY id').all();
  old.db.close();
  const s = testStore(file);
  assert.equal((s.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.deepEqual(s.db.prepare('SELECT id, kind, content, source_log_id FROM memories ORDER BY id').all(), before);
  assert.ok(fs.readdirSync(path.join(path.dirname(file), 'backups')).length >= 1, 'migrated after a backup');
  s.setAction(action.id, { owner: 'user', due: '2026-11-20', condition: { kind: 'task_done', value: '3' }, by: 'test', logId: 1 });
  assert.throws(() => s.db.prepare("UPDATE memory_actions SET state = 'gone' WHERE memory_id = ?").run(action.id), /CHECK constraint/);
  s.replaceCalendarRange('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', [{ uid: 'u', recurrence_at: '2026-11-02T01:00:00.000Z', start_at: '2026-11-02T01:00:00.000Z', end_at: null, all_day: false, title: '회의', location: null }], new Date().toISOString());
  assert.equal(s.calendarEventsBetween('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z').length, 1);
  s.dropLogRows([1], [], 'x', new Date().toISOString());
  assert.equal(s.getAction(action.id)?.marked_log_id, null, 'the deleted row is unlinked, the action kept');
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(), []);
});

// [늘 남김] 없으면 놓치는 실수: 질문 대기 상태를 더하려 tasks를 다시 만드는 옮기기(20)에서 업무 번호·기록·상태가 바뀌거나, 색인을 잃거나, 백업 없이 옮기거나,
// 새 상태가 CHECK에 걸려 업무 세션의 [질문]을 기록하지 못한다.
test('migration 20: tasks keep their ids, records and statuses, after a backup; asking is a status, anything else still refused', () => {
  const dir = tempDir();
  const file = path.join(dir, 'secretary.db');
  const old = testStore(file, 19);
  const ws = old.createWorkspace({ kind: 'solo', name: 'video', title: '영상', purpose: '영상 제작', folder: 'C:/ws/video', agents: [] });
  const now = new Date().toISOString();
  const add = old.db.prepare('INSERT INTO tasks (id, workspace_id, name, title, goal, output_dir, status, session_ref, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run(4, ws.id, 'a', 'A', 'g', 'o1', 'running', 'bg:1', null, now, now);
  add.run(8, ws.id, 'b', 'B', 'g', 'o2', 'done', 'bg:2', '보고 확인함', now, now);
  add.run(11, ws.id, 'c', 'C', 'g', 'o3', 'ready', null, null, now, now);
  const rows = (db: DatabaseSync) => db.prepare('SELECT * FROM tasks ORDER BY id').all().map((r) => ({ ...r }));
  const before = rows(old.db);
  old.db.close();

  const s = testStore(file);
  assert.equal(version(s.db), SCHEMA_VERSION);
  assert.deepEqual(rows(s.db), before);
  assert.equal(s.updateTask(4, { status: 'asking' })?.status, 'asking');
  assert.deepEqual(s.listTasks({ status: 'asking' }).map((t) => t.id), [4]);
  assert.throws(() => s.db.prepare("UPDATE tasks SET status = 'review' WHERE id = 8").run(), /CHECK constraint/);
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(), []);
  for (const name of ['tasks_workspace', 'tasks_status']) assert.ok(s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name), name);
  s.db.close();
  assert.equal(backups(dir).length, 1, 'the old DB is copied before the rebuild');
});
// [늘 남김] 없으면 놓치는 실수: 태그를 태그 표로 옮기고 단어 색인을 본문 사본 없는 방식으로 다시 만드는 옮기기(21)에서 태그·주제가 바뀌거나,
// 대화·기억 검색 결과가 달라지거나, 대화를 지워도 색인에 남거나, 백업 없이 옮긴다.
test('migration 21: tags move to the tag tables split by spaces, the word indexes keep no text copy, searches find the same; a backup first', () => {
  const dir = tempDir();
  const file = path.join(dir, 'secretary.db');
  const old = testStore(file, 20);
  const at = new Date(Date.now() - 60_000).toISOString();
  old.appendLog([
    { session_id: 's', message_uuid: 'u1', role: 'user', content: '토마토 모종을 서울에서 산다', created_at: at },
    { session_id: 's', message_uuid: 'u2', role: 'assistant', content: '서울 화원 목록을 찾았어요', created_at: at },
    { session_id: 's', message_uuid: 'u3', role: 'user', content: '감자는 다음 주에', created_at: at },
  ]);
  const a = old.remember({ kind: 'action', content: '토마토 모종을 산다.', tags: ['텃밭', '할 일'], sourceLogId: 1 }).id;
  const b = old.remember({ kind: 'decision', content: '감자는 다음 주에 심는다.', tags: ['텃밭'] }).id;
  const dup = old.remember({ kind: 'fact', content: '비서 배포판 실수를 줄인다.', tags: ['비서'] }).id;
  const gone = old.remember({ kind: 'fact', content: '옛 텃밭 위치', tags: ['텃밭', '위치'] }).id;
  old.forget(gone, '시험');
  // The old string could hold a word twice: one is kept, its index entry and vector stay as they were (searches rank as before).
  old.db.prepare("UPDATE memories SET tags = '비서 실수 비서 배포판' WHERE id = ?").run(dup);
  old.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(dup);
  old.db.prepare("INSERT INTO memories_fts (rowid, terms) VALUES (?, '비서 배포 포판 실수')").run(dup);
  for (const id of [a, b, dup]) old.db.prepare('INSERT INTO memory_vectors (memory_id, model, vector) VALUES (?, ?, ?)').run(id, 'm', new Uint8Array([1, 2, 3, 4]));
  const logHits = (s: Store) => ['서울', '토마토', '감자'].map((q) => s.searchLog(q, { limit: 10 }).map((r) => r.id));
  // Read the same way before and after (the store's readers need the tag tables): ids in bm25 order.
  const memHits = (s: Store) => ['토마토 모종', '감자', '텃밭', '할 일'].map((q) => (s.db.prepare('SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts), rowid').all(ftsQuery(queryTerms(q))) as Array<{ id: number }>).map((r) => r.id));
  const before = { log: logHits(old), mem: memHits(old), tags: old.db.prepare('SELECT id, tags FROM memories ORDER BY id').all().map((r) => ({ ...r })) };
  old.db.close();

  const s = testStore(file);
  assert.equal(version(s.db), SCHEMA_VERSION);
  assert.deepEqual(logHits(s), before.log, 'the conversation search finds the same rows in the same order');
  assert.deepEqual(memHits(s), before.mem, 'the memory search finds the same memories in the same order');
  // Split by spaces, joined again they read as before; the topic is the first.
  assert.deepEqual(s.tagsOf(a), ['텃밭', '할', '일']);
  assert.equal(s.getMemory(a)?.tags, '텃밭 할 일');
  assert.equal(s.getMemory(a)?.topic, '텃밭');
  assert.deepEqual(s.tagsOf(dup), ['비서', '실수', '배포판']);
  assert.equal(s.getMemory(dup)?.topic, '비서/실수', 'the secretary topic is summarised per its second tag');
  for (const r of before.tags) if (r.id !== dup) assert.equal(s.getMemory(Number(r.id))?.tags, r.tags);
  // Live memories with two tags or more are on the list to check; one alone or invalidated is not.
  assert.deepEqual(s.db.prepare('SELECT memory_id FROM memory_tag_checks ORDER BY memory_id').all().map((r) => r.memory_id), [a, dup]);
  assert.deepEqual(s.tagChecksDue(10).due.map((m) => m.id), [dup, a], 'newest first among those with as many tags');
  s.forget(a, '시험');
  assert.deepEqual(s.tagChecksDue(10), { due: [s.getMemory(dup)!], left: 1 }, 'one invalidated since is not handed out');
  assert.deepEqual(s.searchMemories('실수', { limit: 5 }).map((m) => m.id), [dup]);
  assert.deepEqual(s.db.prepare('SELECT memory_id FROM memory_vectors ORDER BY memory_id').all().map((r) => r.memory_id), [a, b, dup]);
  const columns = (s.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!columns.includes('tags'), columns.join(','));
  const names = (s.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%fts%' OR name LIKE 'usage_log%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(!names.includes('raw_log_fts_content') && !names.includes('memories_fts_content'), names.join(','));
  assert.ok(names.includes('usage_log_event'), names.join(','));
  assert.match((s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'raw_log_fts'").get() as { sql: string }).sql, /content=''.*contentless_delete=1/);
  assert.equal(s.corpusStats(['토마']).docFreq.get('토마'), 1, 'the vocabulary table reads the new index');
  // A tag of two words stays whole from now on; deleting a conversation row takes it out of the index.
  const c = s.remember({ kind: 'action', content: '고추 모종을 산다.', tags: ['텃밭', '할 일'] }).id;
  assert.deepEqual(s.tagsOf(c), ['텃밭', '할 일']);
  s.dropLogRows([1], [], 'x', new Date().toISOString());
  s.db.exec("INSERT INTO raw_log_fts (raw_log_fts) VALUES ('optimize')");
  assert.deepEqual(s.searchLog('토마토', { limit: 5 }), []);
  assert.deepEqual(s.searchLog('서울', { limit: 5 }).map((r) => r.id), [2]);
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((s.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok');
  s.db.close();
  assert.equal(backups(dir).length, 1, 'the old DB is copied before the migration');
});
// 없으면 놓치는 실수: 코드 상수에만 새 값(업무 상태, 기억 종류 등)을 넣어 입력 검사는 통과하는데 DB CHECK에 걸려 저장이 실패하거나,
// 대시보드가 자기 상태 목록에 없는 업무를 조용히 빼고 보여 준다.
test('every CHECK list in the schema matches the code constant it stands for, and the dashboard shows every task status', () => {
  const s = tempStore();
  const sqlOf = (table: string) => (s.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
  const check = (table: string, column: string) => {
    const m = new RegExp(`${column}\\s+TEXT[^,]*CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sqlOf(table)) ?? new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sqlOf(table));
    assert.ok(m, `${table}.${column} has a CHECK list`);
    return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
  };
  const sorted = (xs: readonly string[]) => [...xs].sort();
  assert.deepEqual(check('tasks', 'status'), sorted(TASK_STATUSES));
  assert.deepEqual(sorted(DASHBOARD_STATUSES), sorted(TASK_STATUSES));
  assert.deepEqual(check('memories', 'kind'), sorted(MEMORY_KINDS));
  assert.deepEqual(check('workspaces', 'kind'), sorted(WORKSPACE_KINDS));
  assert.deepEqual(check('main_agenda', 'state'), sorted(MAIN_AGENDA_STATES));
  assert.deepEqual(check('memory_actions', 'owner'), sorted(ACTION_OWNERS));
  assert.deepEqual(check('memory_actions', 'cond_kind'), sorted(ACTION_COND_KINDS));
  assert.deepEqual(check('memory_actions', 'state'), sorted(ACTION_STATES));
  assert.deepEqual(check('mistakes', 'found_by'), sorted(MISTAKE_FINDERS));
  assert.deepEqual(check('mistakes', 'cause'), sorted(MISTAKE_CAUSES));
  assert.deepEqual(check('memory_pair_checks', 'verdict'), sorted(PAIR_VERDICTS));
});