import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ingestTranscript } from '../src/log/ingest-transcript.ts';
import { QUARANTINE_FILE, quarantinePath } from '../src/log/purge.ts';
import { cleanRewound, findAbandoned, mayHaveRewind, REWIND_REASON, rewindNotice } from '../src/log/rewind.ts';
import { tempDir, tempStore } from './helpers.ts';

/** Fake transcript lines in Claude Code's shape (parentUuid first, as the real files have it). */
/** Lines are a second apart, starting just before now (memories saved in a branch are matched by time). */
let clock = 0;
const resetClock = () => (clock = Date.now() - 20_000);
const at = () => new Date((clock += 1000)).toISOString();
const base = (uuid: string, parent: string | null, o: object) =>
  JSON.stringify({ parentUuid: parent, isSidechain: false, ...o, uuid, sessionId: 's1', timestamp: at() });
const prompt = (uuid: string, parent: string | null, text: string, extra: object = {}) =>
  base(uuid, parent, { type: 'user', message: { role: 'user', content: text }, ...extra });
const answer = (uuid: string, parent: string, text: string) =>
  base(uuid, parent, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (uuid: string, parent: string, id: string, name: string) =>
  base(uuid, parent, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (uuid: string, parent: string, id: string, text: string) =>
  base(uuid, parent, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const stop = (uuid: string, parent: string) => base(uuid, parent, { type: 'system', subtype: 'stop_hook_summary' });
const marker = (cut: string, leaf: string) => JSON.stringify({ type: 'last-prompt', lastPrompt: 'x', leafUuid: leaf, rewound: true, cutUuid: cut, sessionId: 's1' });

const write = (lines: string[]) => {
  const file = path.join(tempDir(), 't.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
};
const append = (file: string, lines: string[]) => fs.appendFileSync(file, `${lines.join('\n')}\n`);

/** The first turn, then a turn that saves memory #id and gets rewound. */
function rewoundTurn(memoryId: number): { kept: string[]; old: string[] } {
  resetClock();
  const kept = [prompt('p1', null, '첫 질문'), answer('a1', 'p1', '첫 답'), stop('s1', 'a1')];
  const old = [
    prompt('p2', 's1', '오류를 부르는 질문'),
    toolUse('t1', 'p2', 'call1', 'mcp__secretary__remember'),
    toolResult('r1', 't1', 'call1', `기억 #${memoryId} 저장`),
    answer('a2', 'r1', '버려질 답'),
    stop('s2', 'a2'),
    prompt('p3', 's2', '버려진 갈래의 다음 질문'),
    answer('a3', 'p3', '버려질 두 번째 답'),
  ];
  return { kept, old };
}

test('a rewound branch: its rows go, its memories are invalidated and reported once, the rest stays', () => {
  const s = tempStore();
  const kept = s.remember({ kind: 'fact', content: '앞 대화의 기억' }).id;
  // Saved an hour before this conversation, so the turn does not pick it up.
  s.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3600_000).toISOString(), kept);
  const doomed = s.remember({ kind: 'fact', content: '버려진 턴의 기억' }).id;
  const { kept: first, old } = rewoundTurn(doomed);
  const file = write([...first, ...old]);
  ingestTranscript(s, file);
  s.linkTurnMemories('s1');
  s.setBigWork({ name: '시험 일', state: '진행 중', sourceLogId: s.logInfoByUuids(['p2'])[0].id });
  assert.equal(s.stats().logEntries, 6);

  // The user rewinds to a1 and asks again: a sibling of p2 under the same stop line.
  append(file, [marker('p2', 'a1'), prompt('p2b', 's1', '다시 묻는 질문'), answer('a2b', 'p2b', '새 답')]);
  ingestTranscript(s, file);

  assert.deepEqual(
    s.sessionTail('s1', 10).map((e) => e.message_uuid),
    ['p1', 'a1', 'p2b', 'a2b'],
  );
  assert.equal(s.searchLog('버려질', { limit: 5 }).length, 0, 'search index cleaned too');
  assert.equal(s.getMemory(doomed)?.invalid_reason, REWIND_REASON);
  assert.equal(s.getMemory(kept)?.valid_to, null);
  assert.equal(s.bigWork()[0].source_log_id, null);

  const notice = rewindNotice(s);
  assert.match(notice, new RegExp(`<secretary-rewind>.*#${doomed}[^0-9]`));
  assert.doesNotMatch(notice, /버려진 턴의 기억/, 'numbers only, no content');
  assert.equal(rewindNotice(s), '', 'reported once');

  // Deleted the way "비서 대화 삭제" deletes: the rows go to the quarantine (no whole-DB copy), and are blocked.
  const backups = fs.readdirSync(path.join(path.dirname(s.db.location()!), 'backups', 'error'));
  assert.deepEqual(backups, [QUARANTINE_FILE]);
  const q = new DatabaseSync(quarantinePath(s));
  assert.deepEqual(
    (q.prepare('SELECT message_uuid FROM quarantined_log ORDER BY seq').all() as Array<{ message_uuid: string }>).map((r) => r.message_uuid),
    ['p2', 'a2', 'p3', 'a3'],
  );
  q.close();
  s.deleteMeta(`ingest_offset:${file}`);
  ingestTranscript(s, file);
  assert.deepEqual(s.sessionTail('s1', 10).map((e) => e.message_uuid), ['p1', 'a1', 'p2b', 'a2b'], 'read again from the start: not logged again');
});

test('a rewound branch takes its board and open questions along, and leaves no text in the DB file', () => {
  const s = tempStore();
  const { kept, old } = rewoundTurn(999);
  const file = write([...kept, ...old]);
  ingestTranscript(s, file);
  const [p2] = s.logInfoByUuids(['p2']);
  const [a1] = s.logInfoByUuids(['a1']);
  s.setJson('situation_board', { text: '요약: 버려질 이야기', lastLogId: p2.id + 3, updatedAt: new Date().toISOString() });
  s.setJson('open_questions', {
    lastLogId: p2.id + 3,
    open: ['A', 'B'],
    defs: { A: { text: 'A. 버려진 질문?', session: 's1', at: p2.created_at, logId: p2.id + 1 }, B: { text: 'B. 남을 질문?', session: 's1', at: a1.created_at, logId: a1.id } },
  });

  append(file, [marker('p2', 'a1'), prompt('p2b', 's1', '다시'), answer('a2b', 'p2b', '새 답')]);
  const plan = cleanRewound(s, file, { dryRun: true });
  assert.equal(plan.boardReset, true);
  assert.deepEqual(plan.questions, ['A']);
  ingestTranscript(s, file);

  assert.equal(s.getJson<{ text: string }>('situation_board')!.text, '', 'emptied for a rewrite');
  assert.deepEqual(s.getJson<{ open: string[] }>('open_questions')!.open, ['B']);
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = fs.readFileSync(s.db.location()!).toString('utf8');
  assert.ok(!bytes.includes('버려질'), 'text left in the main DB file');
});

test('prompt hook right after a rewind: only the marker is written, and it is enough', () => {
  const s = tempStore();
  const doomed = s.remember({ kind: 'fact', content: '버려진 턴의 기억' }).id;
  const { kept, old } = rewoundTurn(doomed);
  const file = write([...kept, ...old]);
  ingestTranscript(s, file);
  s.linkTurnMemories('s1');

  // Before the marker, nothing is touched.
  assert.equal(rewindNotice(s, file), '');
  assert.equal(s.stats().logEntries, 6);

  // The new prompt is not in the file yet when the prompt hook runs (only the queue line and the marker).
  append(file, [marker('p2', 'a1'), JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '다시 묻는 질문' })]);
  assert.match(rewindNotice(s, file), new RegExp(`#${doomed}`));
  assert.deepEqual(s.sessionTail('s1', 10).map((e) => e.message_uuid), ['p1', 'a1']);

  // Later the new turn arrives and is logged as usual; nothing more is removed.
  append(file, [prompt('p2b', 's1', '다시 묻는 질문'), answer('a2b', 'p2b', '새 답')]);
  ingestTranscript(s, file);
  assert.deepEqual(s.sessionTail('s1', 10).map((e) => e.message_uuid), ['p1', 'a1', 'p2b', 'a2b']);
  assert.equal(rewindNotice(s, file), '');
});

test('a memory saved in another session at the same time is not invalidated', () => {
  const s = tempStore();
  const { kept, old } = rewoundTurn(999);
  const file = write([...kept, ...old]);
  ingestTranscript(s, file);
  // Saved after the branch ended by more than the window: linked to this turn only by a race.
  const late = s.remember({ kind: 'fact', content: '다른 세션 기억' }).id;
  s.db.prepare('UPDATE memories SET source_log_id = ?, created_at = ? WHERE id = ?').run(s.logInfoByUuids(['p3'])[0].id, new Date(clock + 3600_000).toISOString(), late);
  append(file, [marker('p2', 'a1'), prompt('p2b', 's1', '다시'), answer('a2b', 'p2b', '새 답')]);
  ingestTranscript(s, file);
  assert.equal(s.getMemory(late)?.valid_to, null);
  assert.equal(s.getMemory(late)?.source_log_id, null, 'its link to the removed row is dropped');
});

test('dry run and keep-memories', () => {
  const s = tempStore();
  const doomed = s.remember({ kind: 'fact', content: '버려진 턴의 기억' }).id;
  const { kept, old } = rewoundTurn(doomed);
  const file = write([...kept, ...old, marker('p2', 'a1'), prompt('p2b', 's1', '다시'), answer('a2b', 'p2b', '새 답')]);
  // Logged directly by the test without the cleanup, as an older version would have.
  s.appendLog(['p1', 'a1', 'p2', 'a2', 'p2b'].map((u) => ({ session_id: 's1', message_uuid: u, role: u.startsWith('p') ? 'user' : 'assistant', content: u, created_at: at() })));

  const plan = cleanRewound(s, file, { dryRun: true });
  assert.deepEqual(plan.rows.map((r) => r.message_uuid), ['p2', 'a2']);
  assert.deepEqual(plan.memoryIds, [doomed]);
  assert.equal(s.stats().logEntries, 5, 'dry run changes nothing');
  assert.equal(fs.existsSync(path.join(path.dirname(s.db.location()!), 'backups')), false);

  const r = cleanRewound(s, file, { keepMemories: true });
  assert.deepEqual(r.forgotten, []);
  assert.equal(s.stats().logEntries, 3);
  assert.equal(s.getMemory(doomed)?.valid_to, null);
  // Handled once: a later hook does not come back for the memory.
  cleanRewound(s, file);
  assert.equal(s.getMemory(doomed)?.valid_to, null);
});

test('compaction, parallel tool calls and sidechains are not rewinds', () => {
  resetClock();
  const lines = [
    prompt('p1', null, '질문'),
    toolUse('t1', 'p1', 'c1', 'Read'),
    toolUse('t2', 't1', 'c2', 'Grep'), // a parallel call: t1 has two children
    toolResult('r1', 't1', 'c1', 'ok'),
    toolResult('r2', 't2', 'c2', 'ok'),
    answer('a1', 'r2', '답'),
    stop('s1', 'a1'),
    // A sidechain prompt under the same parent as the next real prompt.
    prompt('side', 's1', '서브에이전트 지시', { isSidechain: true }),
    prompt('p2', 's1', '두 번째 질문'),
    answer('a2', 'p2', '두 번째 답'),
    // Compaction: the chain restarts with parentUuid null and points back through logicalParentUuid.
    JSON.stringify({ parentUuid: null, logicalParentUuid: 'a2', isSidechain: false, type: 'system', subtype: 'compact_boundary', uuid: 'cb', sessionId: 's1', timestamp: at() }),
    prompt('sum', 'cb', 'This session is being continued from a previous conversation...', { isCompactSummary: true }),
    prompt('p3', 'sum', '요약 뒤 질문'),
    answer('a3', 'p3', '요약 뒤 답'),
  ];
  assert.deepEqual(findAbandoned(lines.join('\n')), []);

  // A rewind after compaction (back to the summary) drops only the branch after it.
  const rewound = [...lines, marker('p3', 'sum'), prompt('p3b', 'sum', '다시 묻기'), answer('a3b', 'p3b', '새 답')];
  assert.deepEqual(findAbandoned(rewound.join('\n')).map((b) => [b.root, b.uuids]), [['p3', ['p3', 'a3']]]);

  // A boundary that cannot be followed back: pre-compact siblings are left alone.
  const broken = [
    prompt('q1', null, '질문'),
    answer('b1', 'q1', '답'),
    prompt('q2', 'b1', '옛 갈래'),
    prompt('q2b', 'b1', '새 갈래'),
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary', uuid: 'cb2', sessionId: 's1', timestamp: at() }),
    prompt('q3', 'cb2', '요약 뒤 질문'),
  ];
  assert.deepEqual(findAbandoned(broken.join('\n')), []);
});

test('ambiguous cases are left alone', () => {
  const head = [prompt('p1', null, '질문'), answer('a1', 'p1', '답')];
  // The older sibling is the live one (the newer one led nowhere): not a rewind.
  assert.deepEqual(findAbandoned([...head, prompt('n1', 'a1', '새 질문'), prompt('o1', 'a1', '먼저'), answer('x', 'n1', '답')].join('\n')), []);
  // A marker whose cut branch went on after it: still in use.
  const kept = [...head, prompt('p2', 'a1', '질문2'), marker('p2', 'a1'), answer('a2', 'p2', '이어진 답')];
  assert.deepEqual(findAbandoned(kept.join('\n')), []);
  // A marker pointing at a leaf that is not above the cut.
  const odd = [...head, prompt('p2', 'a1', '질문2'), answer('a2', 'p2', '답2'), marker('p2', 'a2')];
  assert.deepEqual(findAbandoned(odd.join('\n')), []);
  // No marker and no siblings: the cheap check says no.
  assert.equal(mayHaveRewind([...head, prompt('p2', 'a1', '질문2')].join('\n')), false);
  assert.equal(cleanRewound(tempStore(), path.join(tempDir(), 'missing.jsonl')).rows.length, 0);
});
