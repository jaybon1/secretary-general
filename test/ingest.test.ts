import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ingestTranscript, parseTranscriptLine } from '../src/log/ingest-transcript.ts';
import { formatLocal } from '../src/core/kst-time.ts';
import { planPurge, type PurgePlan } from '../src/log/purge.ts';
import { tempDir, tempStore } from './helpers.ts';

const line = (o: object) => JSON.stringify({ sessionId: 's1', timestamp: '2026-10-16T11:00:00Z', isSidechain: false, ...o });

const userMsg = (uuid: string, content: unknown) => line({ type: 'user', uuid, message: { role: 'user', content } });
const asstMsg = (uuid: string, content: unknown) => line({ type: 'assistant', uuid, message: { role: 'assistant', content } });

// [늘 남김] 없으면 놓치는 실수: 사용자가 한 말이나 비서의 답이 대화 저장에서 빠지거나, 도구 호출 같은 잡음이 대화로 저장된다(대화 저장).
test('keeps real user prompts and assistant text, drops plumbing', () => {
  assert.equal(parseTranscriptLine(userMsg('u1', '안녕'))[0]?.content, '안녕');
  assert.equal(parseTranscriptLine(asstMsg('a1', [{ type: 'text', text: '네' }]))[0]?.content, '네');
  assert.deepEqual(parseTranscriptLine(asstMsg('a2', [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }])), []);
  assert.deepEqual(parseTranscriptLine(userMsg('u2', [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])), []);
  assert.deepEqual(parseTranscriptLine(userMsg('u3', '<command-name>/clear</command-name>')), []);
  assert.deepEqual(parseTranscriptLine(line({ type: 'user', uuid: 'u4', isMeta: true, message: { content: 'meta' } })), []);
  assert.deepEqual(parseTranscriptLine(line({ type: 'attachment', uuid: 'x' })), []);
  assert.deepEqual(parseTranscriptLine('{not json'), []);
});

// [늘 남김] 없으면 놓치는 실수: 같은 기록을 두 번 읽어 대화가 겹쳐 저장되거나, 쓰다 만 마지막 줄에서 저장이 깨진다(대화 저장).
test('incremental, idempotent, and safe with a half-written last line', () => {
  const s = tempStore();
  const file = path.join(tempDir(), 't.jsonl');
  fs.writeFileSync(file, `${userMsg('u1', '첫 질문')}\n${asstMsg('a1', [{ type: 'text', text: '첫 답' }])}\n`);
  assert.equal(ingestTranscript(s, file).added, 2);
  assert.equal(ingestTranscript(s, file).added, 0);

  const partial = userMsg('u2', '두 번째 질문');
  fs.appendFileSync(file, partial.slice(0, 20));
  assert.equal(ingestTranscript(s, file).added, 0);
  fs.appendFileSync(file, `${partial.slice(20)}\n`);
  assert.equal(ingestTranscript(s, file).added, 1);

  assert.equal(s.stats().logEntries, 3);
  assert.equal(s.searchLog('두 번째', { limit: 5 })[0]?.message_uuid, 'u2');
});

const wrapUp = (uuid: string, input: object) =>
  asstMsg(uuid, [{ type: 'tool_use', id: uuid, name: 'mcp__ccd_turn__wrap_up', input }]);

test('archives AskUserQuestion picks and end-of-turn recaps', () => {
  const answered = line({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q', content: 'answered' }] },
    toolUseResult: { questions: [], answers: { '언어는?': 'Node/TypeScript', '범위는?': ['대화만'] } },
  });
  assert.equal(parseTranscriptLine(answered)[0]?.content, '[선택 응답]\n- 언어는? → Node/TypeScript\n- 범위는? → 대화만');
  assert.equal(parseTranscriptLine(answered)[0]?.role, 'user');

  const recap = parseTranscriptLine(wrapUp('a1', { recap: '구현을 마쳤어요.', ask: '커밋할까요?' }));
  assert.equal(recap[0]?.content, '[턴 요약] 구현을 마쳤어요.\n[질문] 커밋할까요?');
});

// [늘 남김] 없으면 놓치는 실수: 턴 중간의 진행 글까지 답으로 저장돼, 상황판과 기억 정리가 마지막 답을 잘못 읽는다(대화 저장).
test('keeps only the last assistant prose of each turn', () => {
  const s = tempStore();
  const file = path.join(tempDir(), 't.jsonl');
  const tool = (uuid: string) => asstMsg(uuid, [{ type: 'tool_use', id: uuid, name: 'Write', input: {} }]);
  fs.writeFileSync(
    file,
    [
      userMsg('u1', '만들어줘'),
      asstMsg('a1', [{ type: 'text', text: '이제 스키마를 만들게요.' }]),
      tool('t1'),
      asstMsg('a2', [{ type: 'text', text: 'Now rewrite the reranker.' }]),
      tool('t2'),
      wrapUp('w1', { recap: '다 만들었어요.' }),
      asstMsg('a3', [{ type: 'text', text: '완성했습니다.' }]),
      userMsg('u2', '고마워'),
      asstMsg('a4', [{ type: 'text', text: '천만에요.' }]),
    ].join('\n') + '\n',
  );
  ingestTranscript(s, file);
  assert.deepEqual(
    s.unconsolidatedLog(50).map((e) => e.content),
    ['만들어줘', '[턴 요약] 다 만들었어요.', '완성했습니다.', '고마워', '천만에요.'],
  );
});

// [늘 남김] 없으면 놓치는 실수: 비서가 일하는 도중 사용자가 보낸 말이 대화 저장에서 빠지거나(2026-11-12), 대기열 줄
// (enqueue·attachment·remove)마다 겹쳐 저장되거나, 서브에이전트 보고·백그라운드 알림이 사용자 말로 저장된다(대화 저장).
// 다른 세션이 보낸 메시지가 무엇으로 시작하든 새 질문이나 끼어든 말로 저장된다.
test('stores a message the user sent mid-turn once, when it was sent, and no machine message as the user', () => {
  const s = tempStore();
  const file = path.join(tempDir(), 't.jsonl');
  const at = (sec: number) => `2026-11-11T20:45:${String(sec).padStart(2, '0')}.000Z`;
  const peer = '<agent-message from="a97">\n[Subagent hand-back] 보고 원문\n</agent-message>';
  const voice = (words: string) => `<agent-message from="relay01">\n[전달]\n${words}\n</agent-message>`;
  const fromSession = (body: string) => `Another Claude session sent a message:\n${body}`;
  const meta = (uuid: string, content: string, sec: number) =>
    stamp(line({ type: 'user', uuid, isMeta: true, origin: { kind: 'peer', from: 'x' }, message: { role: 'user', content } }), sec);
  const notice = '<task-notification>\n<task-id>a97</task-id>\n<status>completed</status>\n</task-notification>';
  const queue = (operation: string, content: string, sec: number) => JSON.stringify({ type: 'queue-operation', operation, timestamp: at(sec), sessionId: 's1', content });
  const queued = (uuid: string, prompt: string, kind: string, sec: number, taken: number) =>
    line({ type: 'attachment', uuid, timestamp: at(taken), attachment: { type: 'queued_command', prompt, commandMode: kind === 'human' ? 'prompt' : kind, origin: { kind }, timestamp: at(sec) } });
  const stamp = (l: string, sec: number) => l.replace('2026-10-16T11:00:00Z', at(sec));
  fs.writeFileSync(
    file,
    [
      stamp(userMsg('u1', '조사해줘'), 1),
      stamp(asstMsg('a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]), 2),
      queue('enqueue', 'j1', 15),
      queue('enqueue', peer, 30),
      queue('enqueue', voice('그것도 같이'), 20),
      queue('enqueue', notice, 31),
      stamp(asstMsg('a2', [{ type: 'text', text: '이제 보고서를 쓸게요.' }]), 33),
      stamp(userMsg('r1', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), 37),
      queued('q1', 'j1', 'human', 15, 37),
      queued('q2', peer, 'peer', 30, 37),
      queued('q3', notice, 'task-notification', 31, 37),
      queued('q4', voice('그것도 같이'), 'peer', 20, 37),
      queue('remove', 'j1', 52),
      queue('remove', voice('그것도 같이'), 52),
      queue('remove', peer, 52),
      queue('remove', notice, 52),
      stamp(asstMsg('a3', [{ type: 'text', text: '보고서를 썼고 j1대로 했어요.' }]), 55),
      meta('m1', fromSession('<agent-message from="a98">\n[Subagent hand-back] 보고: 전달 메시지(`[전달]`)\n</agent-message>'), 58),
      meta('m2', fromSession('<agent-message from="b2">\n오늘 일정 알려줘\n</agent-message>'), 59),
      meta('v1', fromSession(voice('오늘 일정 알려줘')), 60),
    ].join('\n') + '\n',
  );
  ingestTranscript(s, file);
  const rows = s.unconsolidatedLog(50);
  assert.deepEqual(
    rows.map((e) => [e.role, e.content]),
    [
      ['user', '조사해줘'],
      ['user', '[끼어든 말] j1'],
      ['assistant', '보고서를 썼고 j1대로 했어요.'],
    ],
  );
  assert.equal(rows[1].created_at, at(15));
  // It is said inside the turn: deleting the last turn takes it along, and it does not count as a turn of its own.
  assert.deepEqual((planPurge(s, { kind: 'turns', n: 1 }, { sessionId: 's1', dirs: [] }) as PurgePlan).rows.map((r) => r.message_uuid), ['u1', 'q1', 'a3']);
});

test('formats stored UTC as Korean time, 24-hour', () => {
  assert.equal(formatLocal('2026-10-16T11:43:00.000Z'), '2026-10-16 20:43');
  assert.equal(formatLocal('2026-10-16T15:30:00Z'), '2026-10-17 00:30');
  assert.equal(formatLocal('2026-10-16T15:30:00Z', true), '2026-10-17');
  assert.equal(formatLocal('not a date'), 'not a date');
});
