import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import {
  CODE_MAX_MS,
  executePurge,
  parsePurgeCommand,
  planPurge,
  PURGE_REASON,
  purgeHook,
  purgeNotice,
  QUARANTINE_FILE,
  quarantinePath,
  restorePurged,
  type HookAction,
  type HookDeps,
  type PurgePlan,
  type PurgeSpec,
} from '../src/log/purge.ts';
import { runPreview } from '../src/log/purge-initials.ts';
import type { LogEntry, Store } from '../src/store/store.ts';
import { tempDir, tempStore } from './helpers.ts';

/** A marker only the "bad" rows hold, to prove their text went nowhere it should not. */
const BAD = 'ZQXBADMARK';
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. 요약';
const noCatchUp: HookDeps = { catchUp: () => {}, dirs: [] };
const ctx = (a: HookAction | null) => (a && 'context' in a ? a.context : '');
/** The code's turn: deleted in the hook, then handed to the secretary with only the result to pass on. */
const done = (a: HookAction | null) => {
  const c = ctx(a);
  assert.match(c, /^<secretary-purge-done>\n[^\n]*그대로 전한다[^]*\n\[대화 지우기\] 지웠어요\. [^]*<\/secretary-purge-done>$/);
  return c;
};
const preview = (s: Store, spec: PurgeSpec, here = 's1') => runPreview(s, spec, { here, dirs: [] });
const codeIn = (text: string) => /승인 코드: ([0-9a-z]{6})/.exec(text)![1];

let clock = 0;
const at = () => new Date((clock += 1000)).toISOString();
type Row = Omit<LogEntry, 'id'>;
const row = (session: string, uuid: string, role: 'user' | 'assistant', content: string): Row => ({ session_id: session, message_uuid: uuid, role, content, created_at: at() });

/**
 * s1 and s2 interleaved, s1 compacted between its 2nd and 3rd prompts (the summary is logged as a user row).
 * Rows are a second apart and end a few seconds before now.
 */
function conversation(): { s: Store; id: (uuid: string) => number; rows: Row[] } {
  clock = Date.now() - 30_000;
  const rows = [
    row('s1', 'p1', 'user', '첫 질문'),
    row('s1', 'a1', 'assistant', '첫 답'),
    row('s2', 'x1', 'user', '다른 세션 질문'),
    row('s1', 'p2', 'user', '둘째 질문'),
    row('s1', 'a2', 'assistant', `둘째 답 ${BAD}`),
    row('s1', 'sum', 'user', SUMMARY),
    row('s1', 'p3', 'user', `셋째 질문 ${BAD}`),
    row('s1', 'a3', 'assistant', '셋째 답'),
    row('s2', 'y1', 'assistant', '다른 세션 답'),
  ];
  const s = tempStore();
  s.appendLog(rows);
  const id = (uuid: string) => (s.db.prepare('SELECT id FROM raw_log WHERE message_uuid = ?').get(uuid) as { id: number }).id;
  return { s, id, rows };
}

const uuids = (plan: PurgePlan | { error: string }) => ('error' in plan ? plan.error : plan.rows.map((r) => r.message_uuid));
const sessionUuids = (s: Store, sid: string) => s.sessionTail(sid, 50).map((e) => e.message_uuid);

// [늘 남김] 없으면 놓치는 실수: 지우라는 말이 섞인 보통 대화가 삭제 문구로 읽혀 대화가 지워진다(대화 지우기).
test('the phrase: only the whole message "비서 대화 삭제 N턴 | #번호 | #번호-#번호", spaces anywhere aside; the old "대화 지워" and anything around it are plain talk', () => {
  assert.deepEqual(parsePurgeCommand('비서 대화 삭제 2턴'), { spec: { kind: 'turns', n: 2 } });
  assert.deepEqual(parsePurgeCommand('비서대화삭제2턴'), { spec: { kind: 'turns', n: 2 } });
  assert.deepEqual(parsePurgeCommand(' 비서 대화삭제  2 턴\n'), { spec: { kind: 'turns', n: 2 } });
  assert.deepEqual(parsePurgeCommand('비서 대화 삭제 #120'), { spec: { kind: 'turn', id: 120 } });
  assert.deepEqual(parsePurgeCommand('비서대화삭제#120'), { spec: { kind: 'turn', id: 120 } });
  assert.deepEqual(parsePurgeCommand('비서 대화 삭제 #135-#120'), { spec: { kind: 'range', from: 120, to: 135 } });
  assert.deepEqual(parsePurgeCommand('비서대화삭제#120-#135'), { spec: { kind: 'range', from: 120, to: 135 } });
  // The phrase alone: the secretary answers with how to write it.
  assert.deepEqual(parsePurgeCommand('비서 대화 삭제'), {});
  // The old phrase is no longer the command.
  for (const p of ['대화 지워 2턴', '대화지워 #120', '비서 대화 지워 2턴', '대화 지워 #120-#135', '대화 지워']) assert.equal(parsePurgeCommand(p), null, p);
  // Anything else around it, or another way to write the target, is plain talk.
  for (const p of [
    '대화 삭제 2턴',
    '비서 대화 삭제 2턴 해 줘',
    '그럼 비서 대화 삭제 2턴',
    '비서 대화 삭제: 2턴',
    '비서 대화 삭제 마지막 2턴',
    '비서 대화 삭제 2턴 확인',
    '비서 대화 삭제 120',
    '비서 대화 삭제 #120~#135',
    '비서 대화 삭제 #120-135',
    '"비서 대화 삭제 2턴"',
    '비서 대화 삭제 그거',
    '비서 대화 삭제 기능 어떻게 돼?',
  ]) assert.equal(parsePurgeCommand(p), null, p);
});

test('choosing rows: turns skip the compaction summary and other sessions; a turn by id; a range stays in one session', () => {
  const { s, id } = conversation();
  // Two turns back is p2, not the summary: the summary rides along inside the turn it follows.
  assert.deepEqual(uuids(planPurge(s, { kind: 'turns', n: 2 }, { sessionId: 's1', dirs: [] })), ['p2', 'a2', 'sum', 'p3', 'a3']);
  assert.deepEqual(uuids(planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] })), ['p3', 'a3']);
  // More turns than there are: all of them, said so.
  const all = planPurge(s, { kind: 'turns', n: 9 }, { sessionId: 's1', dirs: [] }) as PurgePlan;
  assert.deepEqual(uuids(all), ['p1', 'a1', 'p2', 'a2', 'sum', 'p3', 'a3']);
  assert.match(all.notes.join(), /3개뿐/);
  // A fresh session (after /clear) with nothing logged: the latest other session.
  const fallback = planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's3', dirs: [] }) as PurgePlan;
  assert.equal(fallback.sessionId, 's2');
  assert.match(fallback.notes.join(), /앞 세션/);
  assert.deepEqual(uuids(planPurge(s, { kind: 'turns', n: 1 }, { sessionPrefix: 's1', dirs: [] })), ['p3', 'a3']);

  assert.deepEqual(uuids(planPurge(s, { kind: 'turn', id: id('a2') }, { dirs: [] })), ['p2', 'a2', 'sum']);
  assert.deepEqual(uuids(planPurge(s, { kind: 'turn', id: id('a3') }, { dirs: [] })), ['p3', 'a3']);

  const range = planPurge(s, { kind: 'range', from: id('p1'), to: id('a2') }, { dirs: [] }) as PurgePlan;
  assert.deepEqual(uuids(range), ['p1', 'a1', 'p2', 'a2']);
  assert.equal(range.otherSession, 1);
  assert.match((planPurge(s, { kind: 'turn', id: 9999 }, { dirs: [] }) as { error: string }).error, /없어요/);
  assert.match((planPurge(s, { kind: 'turns', n: 21 }) as { error: string }).error, /1~20/);
});

// [늘 남김] 없으면 놓치는 실수: 삭제 문구만으로(승인 코드 없이) 대화가 지워지거나, 지운 글이 격리 파일 밖에 남는다(대화 지우기).
test('the hook: the phrase gets only the preview order, the code deletes, and the text goes only to the quarantine file', async () => {
  const { s, id, rows } = conversation();
  const [first, last] = [id('p2'), id('a3')];
  const old = s.remember({ kind: 'fact', content: '앞 대화의 기억' }).id;
  s.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3600_000).toISOString(), old);
  const doomed = s.remember({ kind: 'fact', content: '지울 턴의 기억', sourceLogId: id('p3') }).id;
  // Linked to the turn only by a race: saved long after it.
  const late = s.remember({ kind: 'fact', content: '나중 기억', sourceLogId: id('p2') }).id;
  s.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(new Date(Date.now() + 3600_000).toISOString(), late);
  s.setMainAgenda({ name: '시험 일', state: '진행 중', sourceLogId: id('p2') });
  s.setJson('situation_board', { text: `요약: ${BAD} 이야기`, lastLogId: id('y1'), updatedAt: new Date().toISOString() });
  s.setJson('open_questions', {
    lastLogId: id('a3'),
    open: ['A', 'B'],
    defs: { A: { text: 'A. 지울 질문?', session: 's1', at: rows[4].created_at, logId: id('a2') }, B: { text: 'B. 남을 질문?', session: 's1', at: rows[1].created_at, logId: id('a1') } },
  });

  // The phrase: not blocked, only the order to run the preview (no '#' on the command line: PowerShell comment).
  const order = ctx(purgeHook(s, '비서 대화 삭제 2턴', 's1', undefined, noCatchUp));
  assert.match(order, /^<secretary-purge-preview>/);
  assert.match(order, /^node src\/cli\.ts purge-log preview 2턴 --here s1$/m);
  assert.match(ctx(purgeHook(s, '비서 대화 삭제 #135-#120', 's1', undefined, noCatchUp)), /preview 120-135 --here s1$/m);
  assert.match(ctx(purgeHook(s, '비서대화삭제#120', undefined, undefined, noCatchUp)), /preview 120$/m);

  const preview2 = preview(s, { kind: 'turns', n: 2 });
  assert.match(preview2, /^\[대화 지우기 미리 보기\] 아직 안 지웠어요\./);
  assert.match(preview2, new RegExp(`^#${id('p2')} 사용자 \\d+자 · \\d+단어 — \\S( \\S)*$`, 'm'));
  assert.match(preview2, new RegExp(`^#${id('a2')} 비서 \\d+자 · \\d+단어 — \\S( \\S)*$`, 'm'));
  assert.match(preview2, new RegExp(`^무효 처리할 기억\\(그 턴에 저장된 것\\) 1개:\n기억 #${doomed} 8자 · 3단어 — 지 턴 기$`, 'm'));
  assert.match(preview2, /상황판: 이 대화를 이미 읽었으니/);
  assert.match(preview2, /남은 질문에서 뺄 것: A$/m);
  assert.match(preview2, /남은 질문에서 뺄 것: A\n승인 코드: [0-9a-z]{6}\n지우려면 30분 안에 이 코드만 보내세요/);
  assert.doesNotMatch(preview2, new RegExp(`${BAD}|둘째|셋째|지울 턴의 기억`), 'no row or memory text in the list');
  assert.equal(s.stats().logEntries, 9, 'nothing deleted yet');
  assert.equal(fs.existsSync(quarantinePath(s)), false);

  const result = done(purgeHook(s, codeIn(preview2), 's1', undefined, noCatchUp));
  // The result as ids, times, roles, lengths, memory numbers, board and questions: never the text.
  assert.match(result, new RegExp(`^- #${first} \\d{2}-\\d{2} \\d{2}:\\d{2} 사용자 \\d+자$`, 'm'));
  assert.match(result, new RegExp(`^- #${last} .* 비서 \\d+자$`, 'm'));
  assert.match(result, new RegExp(`^지운 줄 5개 \\(#${first}~#${last}\\), 무효 처리한 기억: #${doomed}$`, 'm'));
  assert.match(result, /^상황판: 비웠어요[^\n]*남은 질문에서 뺀 것: A$/m);
  assert.match(result, /\/clear/, 'same session: the context still holds it');
  assert.doesNotMatch(result, new RegExp(`<secretary-(memory|board|continuity|usage|purge>)|${BAD}|둘째|셋째|지울 턴의 기억`));
  assert.deepEqual(sessionUuids(s, 's1'), ['p1', 'a1']);
  assert.deepEqual(sessionUuids(s, 's2'), ['x1', 'y1'], 'the other session is untouched');
  assert.equal(s.searchLog(BAD, { limit: 5 }).length, 0, 'search index cleaned');
  assert.equal(s.getMemory(doomed)?.invalid_reason, PURGE_REASON);
  assert.equal(s.getMemory(old)?.valid_to, null);
  assert.equal(s.getMemory(late)?.valid_to, null);
  assert.equal(s.mainAgenda()[0].source_log_id, null);
  const board = s.getJson<{ text: string; lastLogId: number }>('situation_board')!;
  assert.equal(board.text, '');
  assert.ok(board.lastLogId < id('y1'), 'the rewrite reads the remaining rows again');
  const q = s.getJson<{ open: string[]; defs: Record<string, unknown> }>('open_questions')!;
  assert.deepEqual(q.open, ['B']);
  assert.deepEqual(Object.keys(q.defs), ['B']);

  // Block list: identifiers only, and ingest does not log those rows again.
  const cols = (s.db.prepare('PRAGMA table_info(purged_log_ids)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols, ['message_uuid', 'log_id', 'session_id', 'purged_at']);
  assert.equal(s.appendLog(rows), 0);
  assert.deepEqual(sessionUuids(s, 's1'), ['p1', 'a1']);

  // The main DB file holds no trace of the text (secure_delete, FTS merged, WAL written back).
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = fs.readFileSync(s.db.location()!).toString('latin1');
  assert.ok(!bytes.includes(BAD) && !bytes.includes(BAD.toLowerCase()), 'text left in the main DB file');

  // The quarantine has the rows, appends only.
  const qdb = new DatabaseSync(quarantinePath(s));
  const kept = qdb.prepare('SELECT log_id, message_uuid, content FROM quarantined_log ORDER BY seq').all() as Array<{ log_id: number; message_uuid: string; content: string }>;
  assert.deepEqual(kept.map((r) => r.message_uuid), ['p2', 'a2', 'sum', 'p3', 'a3']);
  assert.ok(kept.some((r) => r.content.includes(BAD)));
  assert.throws(() => qdb.exec("UPDATE quarantined_log SET content = 'x'"), /append-only/);
  assert.throws(() => qdb.exec('DELETE FROM quarantined_log'), /append-only/);
  qdb.close();

  // The code's turn already told the secretary: no second word of it on the next prompt.
  assert.equal(purgeNotice(s), '');
});

test('a deletion run directly (purge-log --confirm) is told once on the next prompt, numbers only', () => {
  const { s, id } = conversation();
  const [p3, a3] = [id('p3'), id('a3')];
  const doomed = s.remember({ kind: 'fact', content: '지울 턴의 기억', sourceLogId: p3 }).id;
  executePurge(s, planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] }) as PurgePlan);
  const notice = purgeNotice(s);
  assert.match(notice, new RegExp(`<secretary-purge>.*#${p3}~#${a3}\\(2줄\\).*#${doomed}`));
  assert.doesNotMatch(notice, new RegExp(`${BAD}|지울 턴의 기억`));
  assert.equal(purgeNotice(s), '');
});

// [늘 남김] 없으면 놓치는 실수: 지난 코드나 다른 줄의 코드, 글 속에 섞인 코드로 대화가 지워진다(대화 지우기).
test('the approval code: the whole message only (spaces around it aside), within 30 minutes, for the very rows and memories it was made for', async () => {
  const { s, id } = conversation();
  const code = codeIn(preview(s, { kind: 'turns', n: 1 }));
  assert.match(code, /^[0-9a-z]{6}$/);
  // Anything more than the code: ordinary talk, nothing deleted.
  const near = [`${code}.`, `${code} 확인`, `코드 ${code}`, `${code}${code}`, `"${code}"`];
  if (code.toUpperCase() !== code) near.push(code.toUpperCase());
  for (const p of near) assert.equal(purgeHook(s, p, 's1', undefined, noCatchUp), null, p);
  assert.equal(purgeHook(s, code.slice(0, 5), 's1', undefined, noCatchUp), null);
  assert.equal(s.stats().logEntries, 9);

  // Too late: told why, nothing deleted.
  const late = { ...noCatchUp, now: () => Date.now() + CODE_MAX_MS + 60_000 };
  assert.match(ctx(purgeHook(s, code, 's1', undefined, late)), /<secretary-purge-code>[^]*30분이 지나 아무것도 안 지웠다[^]*비서 대화 삭제 1턴/);
  assert.equal(s.stats().logEntries, 9);

  // The rows changed after the preview (a new turn came in, so "1턴" is another turn now): nothing deleted.
  const code2 = codeIn(preview(s, { kind: 'turns', n: 1 }));
  assert.notEqual(code2, code, 'each preview its own code');
  s.appendLog([row('s1', 'p4', 'user', '넷째 질문'), row('s1', 'a4', 'assistant', '넷째 답')]);
  assert.match(ctx(purgeHook(s, code2, 's1', undefined, noCatchUp)), /지울 대화나 기억이 바뀌어 아무것도 안 지웠다/);
  assert.equal(s.stats().logEntries, 11);
  // So did the memories (one saved in that turn after the preview): nothing deleted.
  const code3 = codeIn(preview(s, { kind: 'turns', n: 1 }));
  s.remember({ kind: 'fact', content: '넷째 턴 기억', sourceLogId: id('p4') });
  assert.match(ctx(purgeHook(s, code3, 's1', undefined, noCatchUp)), /바뀌어/);
  assert.equal(s.stats().logEntries, 11);

  // The code alone, spaces and a line break around it: deleted, from any session; once only.
  const code4 = codeIn(preview(s, { kind: 'turns', n: 1 }));
  const fromOther = done(purgeHook(s, `  ${code4} \n`, 'other', undefined, noCatchUp));
  assert.doesNotMatch(fromOther, /\/clear/, 'another session: its context never held them');
  assert.equal(s.stats().logEntries, 9);
  assert.deepEqual(sessionUuids(s, 's1').slice(-2), ['p3', 'a3']);
  assert.match(ctx(purgeHook(s, code4, 's1', undefined, noCatchUp)), /이미 그 코드로 지웠다/);
  assert.equal(s.stats().logEntries, 9);

  // The phrase alone: how to write it; errors come from the preview; plain talk is not the command.
  assert.match(ctx(purgeHook(s, '비서 대화 삭제', 's1', undefined, noCatchUp)), /지울 대상 없이 보냈다[^]*쓰는 법[^]*비서 대화 삭제 #120-#135/);
  assert.match(preview(s, { kind: 'turn', id: 9999 }), /없어요[^]*쓰는 법/);
  assert.equal(purgeHook(s, '비서 대화 삭제 해 줘', 's1', undefined, noCatchUp), null);
  assert.equal(purgeHook(s, '대화 지워 2턴', 's1', undefined, noCatchUp), null, 'the old phrase');
  assert.equal(s.stats().logEntries, 9);
});

test('turn counting leaves out the delete phrase, its preview answer, the code message and its result answer', async () => {
  const { s, id } = conversation();
  const shown = preview(s, { kind: 'turns', n: 1 });
  const code = codeIn(shown);
  // The preview turn is logged after it (Stop hook), then the code message.
  s.appendLog([row('s1', 'c1', 'user', '비서 대화 삭제 1턴'), row('s1', 'c2', 'assistant', shown), row('s1', 'c3', 'user', ` ${code} `)]);
  assert.deepEqual(uuids(planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] })), ['p3', 'a3'], 'a second preview targets the same turn');
  assert.deepEqual(uuids(planPurge(s, { kind: 'turns', n: 2 }, { sessionId: 's1', dirs: [] })), ['p2', 'a2', 'sum', 'p3', 'a3']);
  assert.match((planPurge(s, { kind: 'turn', id: id('c2') }, { dirs: [] }) as { error: string }).error, /미리 보기 줄이라/);
  const range = planPurge(s, { kind: 'range', from: id('a3'), to: id('c3') }, { dirs: [] }) as PurgePlan;
  assert.deepEqual(uuids(range), ['a3']);
  assert.match(range.notes.join(), /명령·미리 보기 줄 3개는 빼요/);
  // A new session whose only turn is a delete phrase has nothing to delete: the session before.
  s.appendLog([row('s3', 'd1', 'user', '비서대화삭제1턴'), row('s3', 'd2', 'assistant', '미리 보기')]);
  const before = planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's3', dirs: [] }) as PurgePlan;
  assert.equal(before.sessionId, 's1');
  assert.deepEqual(uuids(before), ['p3', 'a3']);
  // And the code still matches: the logged preview turn did not change its rows.
  const result = done(purgeHook(s, code, 's3', undefined, noCatchUp));
  assert.deepEqual(sessionUuids(s, 's1'), ['p1', 'a1', 'p2', 'a2', 'sum', 'c1', 'c2', 'c3']);
  // The code message now reaches the model, so it and the result answer are logged: not conversation either.
  s.appendLog([row('s3', 'd3', 'user', code), row('s3', 'd4', 'assistant', result)]);
  const after = planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's3', dirs: [] }) as PurgePlan;
  assert.equal(after.sessionId, 's1', 's3 still holds no turn of its own');
  assert.deepEqual(uuids(after), ['p2', 'a2', 'sum']);
  s.appendLog([row('s1', 'c4', 'user', code), row('s1', 'c5', 'assistant', result)]);
  assert.deepEqual(uuids(planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] })), ['p2', 'a2', 'sum']);
  assert.match((planPurge(s, { kind: 'turn', id: id('c5') }, { dirs: [] }) as { error: string }).error, /미리 보기 줄이라/);
});

test('a turn that ended in an error: its memories are found from the remember results in the transcript', async () => {
  clock = Date.now() - 30_000;
  const s = tempStore();
  const dir = tempDir();
  const memory = s.remember({ kind: 'fact', content: '오류 난 턴의 기억' }).id; // never linked: the Stop hook did not run
  const t = () => at();
  const line = (o: object) => JSON.stringify({ isSidechain: false, sessionId: 'e1', timestamp: t(), ...o });
  fs.writeFileSync(
    path.join(dir, 'e1.jsonl'),
    [
      line({ type: 'user', uuid: 'q1', parentUuid: null, message: { role: 'user', content: '앞 질문' } }),
      line({ type: 'assistant', uuid: 'r1', parentUuid: 'q1', message: { role: 'assistant', content: [{ type: 'text', text: '앞 답' }] } }),
      line({ type: 'user', uuid: 'q2', parentUuid: 'r1', message: { role: 'user', content: `오류 질문 ${BAD}` } }),
      line({ type: 'assistant', uuid: 'u1', parentUuid: 'q2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'mcp__secretary__remember', input: {} }] } }),
      line({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: `기억 #${memory} 저장` }] }] } }),
      line({ type: 'assistant', uuid: 'r2', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } }),
      '',
    ].join('\n'),
  );
  // The hook logs the transcript first (the errored turn was never logged); the preview then lists it.
  const file = path.join(dir, 'e1.jsonl');
  assert.match(ctx(purgeHook(s, '비서 대화 삭제 1턴', 'e1', file, noCatchUp)), /preview 1턴 --here e1/);
  const shown = runPreview(s, { kind: 'turns', n: 1 }, { here: 'e1', dirs: [dir] });
  assert.match(shown, new RegExp(`무효 처리할 기억\\(그 턴에 저장된 것\\) 1개:\n기억 #${memory} \\d+자 · \\d+단어 — .+$`, 'm'));
  assert.match(done(purgeHook(s, codeIn(shown), 'e1', file, { ...noCatchUp, dirs: [dir] })), /지웠어요/);
  assert.deepEqual(sessionUuids(s, 'e1'), ['q1', 'r1']);
  assert.equal(s.getMemory(memory)?.invalid_reason, PURGE_REASON);
  // Read again from the start (e.g. the offset was lost): still not logged.
  s.deleteMeta(`ingest_offset:${file}`);
  purgeHook(s, '비서 대화 삭제 1턴', 'e1', file, noCatchUp);
  assert.deepEqual(sessionUuids(s, 'e1'), ['q1', 'r1']);
});

// [늘 남김] 없으면 놓치는 실수: 격리 파일을 덮어써 앞서 지운 대화를 되살릴 수 없게 된다(대화 지우기).
test('the quarantine grows by appending, may be deleted any time, and rows can be put back', () => {
  const { s, id } = conversation();
  const p1 = id('p1');
  executePurge(s, planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] }) as PurgePlan);
  executePurge(s, planPurge(s, { kind: 'turn', id: p1 }, { dirs: [] }) as PurgePlan);
  const count = () => {
    const q = new DatabaseSync(quarantinePath(s));
    const n = Number((q.prepare('SELECT count(*) AS n FROM quarantined_log').get() as { n: number }).n);
    q.close();
    return n;
  };
  assert.equal(count(), 4);

  // Back from the quarantine: same ids, searchable again, off the block list. Nothing of the text is returned.
  const listed = restorePurged(s, p1, p1 + 7);
  assert.deepEqual(listed.map((r) => r.state), ['restore', 'restore', 'restore', 'restore']);
  assert.equal(JSON.stringify(listed).includes(BAD), false);
  assert.equal(s.stats().logEntries, 5, 'a dry run by default');
  const back = restorePurged(s, p1, p1 + 7, false);
  assert.deepEqual(back.map((r) => r.state), ['restored', 'restored', 'restored', 'restored']);
  assert.deepEqual(sessionUuids(s, 's1'), ['p1', 'a1', 'p2', 'a2', 'sum', 'p3', 'a3']);
  assert.equal(s.searchLog(BAD, { limit: 5 }).length, 2);
  assert.equal(Number((s.db.prepare('SELECT count(*) AS n FROM purged_log_ids').get() as { n: number }).n), 0);
  assert.deepEqual(restorePurged(s, p1, p1 + 7).map((r) => r.state), ['in-log', 'in-log', 'in-log', 'in-log']);

  // Delete again, then the user deletes the quarantine file: the block list stays, the next deletion makes a new file.
  executePurge(s, planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] }) as PurgePlan);
  fs.rmSync(quarantinePath(s));
  assert.equal(s.appendLog([{ session_id: 's1', message_uuid: 'p3', role: 'user', content: 'x', created_at: at() }]), 0);
  assert.throws(() => restorePurged(s, p1, p1 + 7), /격리 DB가 없어요/);
  executePurge(s, planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] }) as PurgePlan);
  assert.equal(count(), 3);
});

// [늘 남김] 없으면 놓치는 실수: 지운 대화의 id가 새 대화에 다시 쓰여, 기억 정리·상황판이 읽은 자리가 어긋나 새 대화를 건너뛴다(대화 지우기).
test('deleting the newest rows: their ids are not handed out again, so watermarks stay where they are', () => {
  clock = Date.now() - 30_000;
  const s = tempStore();
  s.appendLog([row('t', 'p1', 'user', '질문'), row('t', 'a1', 'assistant', '답'), row('t', 'p2', 'user', `질문 ${BAD}`), row('t', 'a2', 'assistant', '답')]);
  s.markConsolidated(4);
  s.setJson('situation_board', { text: '요약: 옛 판', lastLogId: 2, updatedAt: new Date().toISOString() });
  s.setJson('open_questions', { lastLogId: 4, open: [], defs: {} });
  const r = executePurge(s, planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 't', dirs: [] }) as PurgePlan);
  assert.equal(r.boardReset, false, 'the board had not read them');
  assert.equal(s.consolidatedThrough(), 4);
  assert.equal(s.getJson<{ lastLogId: number }>('open_questions')!.lastLogId, 4);
  assert.equal(s.getJson<{ lastLogId: number }>('situation_board')!.lastLogId, 2);
  s.appendLog([row('t', 'p3', 'user', '새 질문')]);
  assert.deepEqual(s.logAfter(2).map((e) => e.id), [5], 'a new id, not 3');
  assert.equal(s.stats().unconsolidated, 1, 'the new row is not taken as consolidated');
  // Put back: the row takes its old id again.
  restorePurged(s, 3, 3, false);
  assert.deepEqual(s.logAfter(2).map((e) => e.id), [3, 5]);
});

test('nothing that searches, injects or serves tools names the quarantine', () => {
  const src = path.join(PROJECT_ROOT, 'src');
  const files = (fs.readdirSync(src, { recursive: true }) as string[]).map((f) => f.split(path.sep).join('/'));
  assert.ok(files.includes('log/purge.ts') && files.length > 40, 'the walk reaches the area folders');
  for (const f of files.filter((f) => f.endsWith('.ts') && f !== 'log/purge.ts')) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    for (const word of [QUARANTINE_FILE, 'quarantined_log', 'ATTACH']) assert.ok(!text.includes(word), `${f} mentions ${word}`);
  }
});

test('cli: the phrase reaches the model with only the preview order, the preview prints a code, the code deletes and only its result reaches the model', () => {
  const home = tempDir();
  const db = path.join(home, 'test.db');
  const s = conversation().s;
  const source = s.db.location()!;
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  s.db.close();
  fs.copyFileSync(source, db);
  // No real transcripts or keys: an empty home.
  const env = { ...process.env, SECRETARY_DB: db, USERPROFILE: home, HOME: home, SECRETARY_KEYS_DIR: home, CLAUDE_CONFIG_DIR: '', SECRETARY_SEMANTIC_SEARCH: 'off' };
  const cli = (args: string[], input = '') => execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'cli.ts'), ...args], { input, encoding: 'utf8', env });
  const run = (prompt: string) => cli(['hook', 'prompt'], JSON.stringify({ session_id: 's1', prompt, hook_event_name: 'UserPromptSubmit' }));
  const first = JSON.parse(run('비서 대화 삭제 1턴'));
  assert.equal(first.decision, undefined, 'not blocked: a block reason does not show on the phone');
  const context: string = first.hookSpecificOutput.additionalContext;
  assert.match(context, /^<secretary-purge-preview>[^]*purge-log preview 1턴 --here s1\n<\/secretary-purge-preview>$/);
  assert.doesNotMatch(context, /<secretary-(memory|board|continuity|usage|consolidate)/, 'nothing else on this prompt');
  const shown = cli(['purge-log', 'preview', '1턴', '--here', 's1']);
  assert.match(shown, /^#\d+ 사용자 \d+자 · \d+단어 — \S( \S)*$/m, 'first letters, no model call');
  assert.doesNotMatch(shown, new RegExp(BAD));
  const second = JSON.parse(run(` ${codeIn(shown)} `));
  assert.equal(second.decision, undefined, 'not blocked: the secretary passes the result on');
  const told: string = second.hookSpecificOutput.additionalContext;
  assert.match(told, /^<secretary-purge-done>[^]*지웠어요[^]*<\/secretary-purge-done>$/);
  assert.doesNotMatch(told, /<secretary-(memory|board|continuity|usage|consolidate|purge>)/, 'nothing else on this prompt');
  assert.doesNotMatch(told, new RegExp(BAD));
  // Nothing waits for the next prompt: no second notice of it.
  const meta = new DatabaseSync(db);
  const pending = meta.prepare("SELECT value FROM meta WHERE key = 'purge_notice'").get() as { value: string } | undefined;
  meta.close();
  assert.ok(!pending || JSON.parse(pending.value).length === 0, 'no next-prompt notice queued');
  const check = new DatabaseSync(db);
  assert.equal(Number((check.prepare("SELECT count(*) AS n FROM raw_log WHERE session_id = 's1'").get() as { n: number }).n), 5);
  check.close();
  assert.ok(fs.existsSync(path.join(home, 'backups', 'error', QUARANTINE_FILE)));
});
