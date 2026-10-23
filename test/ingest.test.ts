import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ingestTranscript, parseTranscriptLine } from '../src/ingest.ts';
import { formatLocal } from '../src/text.ts';
import { tempDir, tempStore } from './helpers.ts';

const line = (o: object) => JSON.stringify({ sessionId: 's1', timestamp: '2026-10-16T11:00:00Z', isSidechain: false, ...o });

const userMsg = (uuid: string, content: unknown) => line({ type: 'user', uuid, message: { role: 'user', content } });
const asstMsg = (uuid: string, content: unknown) => line({ type: 'assistant', uuid, message: { role: 'assistant', content } });

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

test('formats stored UTC as Korean time, 24-hour', () => {
  assert.equal(formatLocal('2026-10-16T11:43:00.000Z'), '2026-10-16 20:43');
  assert.equal(formatLocal('2026-10-16T15:30:00Z'), '2026-10-17 00:30');
  assert.equal(formatLocal('2026-10-16T15:30:00Z', true), '2026-10-17');
  assert.equal(formatLocal('not a date'), 'not a date');
});
