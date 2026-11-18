import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lastReply, lastSteps, parseLine, parseLines } from '../src/core/transcript.ts';

// Lines shaped like a real transcript (made-up words): one answer written as several lines with the same message.id.
const UUID = 'abcd1234-0000-4000-8000-000000000000';
const line = (o: object) => JSON.stringify({ sessionId: UUID, timestamp: '2026-11-14T05:00:00.000Z', ...o });
const part = (msg: string, n: number, content: object[]) => line({ type: 'assistant', uuid: `${msg}-${n}`, isSidechain: false, message: { id: msg, role: 'assistant', content, stop_reason: 'end_turn', usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } });
const prompt = (text: string) => line({ type: 'user', uuid: `u-${text.length}`, message: { role: 'user', content: text } });
const result = line({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const noise = [line({ type: 'atis-latch' }), line({ type: 'api-request', requestId: 'x' }), line({ type: 'last-prompt', leafUuid: 'm2-3' }), '{"type":"assist'];

function workSession(choices = 60) {
  const long = Array.from({ length: choices }, (_, i) => `${i + 1}. 선택지 ${i + 1}`).join('\n');
  return [
    prompt('보고서를 써 주세요'),
    part('m1', 1, [{ type: 'thinking', thinking: '...' }]),
    part('m1', 2, [{ type: 'text', text: '먼저 자료를 볼게요.' }]),
    part('m1', 3, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: '시험 돌리기' } }]),
    result,
    part('m2', 1, [{ type: 'thinking', thinking: '...' }]),
    part('m2', 2, [{ type: 'text', text: `[질문] 어느 쪽으로 할까요?\n${long}` }]),
    part('m2', 3, [{ type: 'text', text: `${choices + 1}. 기타 (직접 입력)` }]),
    line({ type: 'assistant', uuid: 's1', isSidechain: true, message: { id: 'sub', content: [{ type: 'text', text: '서브에이전트 보고' }] } }),
    ...noise,
    '',
  ];
}

// 없으면 놓치는 실수: 한 답이 message.id가 같은 여러 줄로 나뉘어 있어, 마지막 줄 하나만 읽으면 긴 [질문]의 앞부분(질문 줄)을 잃는다.
// 서브에이전트 줄이나 알 수 없는 줄 종류(atis-latch, api-request 등)를 답으로 읽어도 안 된다.
test('the last answer is every text line of its message.id, sub-agents and unknown line kinds left out', () => {
  const records = parseLines(workSession());
  const reply = lastReply(records, { withText: true });
  assert.equal(reply?.id, 'm2');
  assert.equal(reply?.texts.length, 2);
  const text = reply!.texts.join('\n\n').trim();
  assert.match(text, /^\[질문\] 어느 쪽으로 할까요\?\n1\. 선택지 1\n/);
  assert.match(text, /60\. 선택지 60\n\n61\. 기타 \(직접 입력\)$/);
  // An answer with no text is passed over; a prompt typed after it ends the search when asked to.
  const later = parseLines([...workSession(3), part('m3', 1, [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.md' } }])]);
  assert.equal(lastReply(later, { withText: true })?.id, 'm2');
  assert.equal(lastReply(later)?.id, 'm3');
  assert.equal(lastReply(parseLines([...workSession(3), prompt('다음')]), { untilPrompt: true }), null);
  assert.equal(parseLine('{"type":"assist'), null);
  assert.equal(parseLine('[1]'), null);
  // The last steps for a stall notice: the last tool and what it was for, the start of the last text.
  const steps = lastSteps(later);
  assert.equal(steps.tool, 'Read - a.md');
  assert.match(steps.text, /^4\. 기타/);
  assert.equal(lastSteps(parseLines(workSession(3))).tool, 'Bash - 시험 돌리기');
});
