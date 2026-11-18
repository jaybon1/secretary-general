import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { type Store } from '../src/store/store.ts';
import { tempDir, tempStore, testStore } from './helpers.ts';

/** The id set_main_agenda needs to change a line already on the board (what the caller saw). */
const seen = (s: Store, name: string) => s.mainAgenda().find((r) => r.name === name)?.id;

test('main agenda: one line at a time, history kept, 끝남·지움 take a line off the board', () => {
  const s = tempStore();
  assert.deepEqual(s.mainAgenda(), []);
  s.setMainAgenda({ name: '이사 준비', state: '진행 중', note: '견적 비교' });
  s.setMainAgenda({ name: '블로그', state: '운영 중' });
  s.setMainAgenda({ name: '이사 준비', state: '보류', note: '비용 승인되면 다시', seenId: seen(s, '이사 준비') });
  assert.deepEqual(
    s.mainAgenda().map((r) => [r.name, r.state, r.note]),
    [['이사 준비', '보류', '비용 승인되면 다시'], ['블로그', '운영 중', '']],
    'changing one line leaves the others and keeps first-seen order',
  );
  assert.equal(s.setMainAgenda({ name: '이사 준비', state: '보류', note: '비용 승인되면 다시', seenId: seen(s, '이사 준비') }), null, 'no change, no new row');
  assert.deepEqual(s.mainAgendaHistory('이사 준비').map((r) => r.state), ['진행 중', '보류']);

  s.setMainAgenda({ name: '이사 준비', state: '끝남', seenId: seen(s, '이사 준비') });
  assert.deepEqual(s.mainAgenda().map((r) => r.name), ['블로그']);
  assert.deepEqual(s.mainAgendaHistory('이사 준비').map((r) => r.state), ['진행 중', '보류', '끝남'], 'ending keeps the history');
  assert.throws(() => s.setMainAgenda({ name: '이사 준비', state: '지움' }), /주요 현안에 없는 안건/);
  assert.throws(() => s.setMainAgenda({ name: '없는 일', state: '끝남' }), /주요 현안에 없는 안건/);
  s.setMainAgenda({ name: '이사 준비', state: '진행 중' });
  assert.equal(s.mainAgenda().length, 2, 'an ended work can start again');
});

// [늘 남김] 없으면 놓치는 실수: 옛 DB(v8)에 주요 현안 표를 더하다가 이미 있던 자료를 건드린다(DB 옮기기).
test('migration 9 adds the board table (big_work, main_agenda from 17) to an existing v8 database without touching its data', () => {
  const file = path.join(tempDir(), 'v8.db');
  // A real v8 database (made by the first eight migrations): none of the tables later migrations add. (It used to be a
  // current one with those tables dropped and its version set back, which broke once a later migration changed a kept table.)
  const v8 = testStore(file, 8);
  v8.updateProfile('옛 프로필', 'v8');
  v8.db.close();
  const s = testStore(file);
  assert.equal(s.getProfile()?.content, '옛 프로필');
  assert.deepEqual(s.mainAgenda(), []);
  s.setMainAgenda({ name: '새 일', state: '진행 중' });
  assert.equal(s.mainAgenda().length, 1);
});

// [늘 남김] 없으면 놓치는 실수: 안건 상태 '사용자 차례'로 이름을 바꾸면서 옛 DB(상태 값이 사용자 이름으로 된 CHECK)의 줄을 안 옮기거나, 배포판 DB(이미 '사용자 차례')에서 옮기기가 깨진다.
test('migration 15: the user\'s-turn state takes the name 사용자 차례, from an old named value or already so, keeping ids and history', () => {
  for (const old of ['홍길동님 차례', '사용자 차례']) {
    const file = path.join(tempDir(), 'v14.db');
    const v14 = testStore(file, 14);
    v14.appendLog([{ session_id: 's', message_uuid: 'u1', role: 'user', content: '이사 계약은 내가 볼게', created_at: '2026-11-01T00:00:00.000Z' }]);
    v14.db.close();
    // The table as a DB made before had it: its user's-turn value in the CHECK (a release DB's was already 사용자 차례).
    const raw = new DatabaseSync(file);
    // Its table had its old name then (main_agenda from 17).
    raw.exec(`DROP TABLE big_work;
      CREATE TABLE big_work (id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('진행 중', '${old}', '보류', '운영 중', '끝남', '지움')),
        note TEXT NOT NULL DEFAULT '', source_log_id INTEGER REFERENCES raw_log (id), created_at TEXT NOT NULL);
      CREATE INDEX big_work_name ON big_work (name, id);`);
    const add = raw.prepare('INSERT INTO big_work (name, state, note, source_log_id, created_at) VALUES (?, ?, ?, ?, ?)');
    add.run('이사 계약', '진행 중', '', null, '2026-11-01T00:00:00.000Z');
    add.run('이사 계약', old, '집주인 답 확인', 1, '2026-11-02T00:00:00.000Z');
    add.run('블로그', '운영 중', '', null, '2026-11-03T00:00:00.000Z');
    raw.close();
    const s = testStore(file);
    assert.deepEqual(s.mainAgendaHistory('이사 계약').map((r) => [r.id, r.state, r.note, r.source_log_id]), [[1, '진행 중', '', null], [2, '사용자 차례', '집주인 답 확인', 1]], old);
    assert.deepEqual(s.mainAgenda().map((r) => [r.name, r.state]), [['이사 계약', '사용자 차례'], ['블로그', '운영 중']], old);
    // The new CHECK: the old name is refused, today's is taken.
    assert.throws(() => s.db.prepare("INSERT INTO main_agenda (name, state, created_at) VALUES ('x', '홍길동님 차례', 'now')").run(), /CHECK/);
    assert.ok(s.setMainAgenda({ name: '블로그', state: '사용자 차례', seenId: 3 }));
    s.db.close();
  }
});
