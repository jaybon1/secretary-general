import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { lastAnswer, prevAnswerSearch } from '../src/memory/prev-answer-search.ts';
import type { SemanticHits, SemanticSearch } from '../src/semantic-search/client.ts';
import { tempDir } from './helpers.ts';

const line = (o: object) => JSON.stringify({ uuid: crypto.randomUUID(), sessionId: 's', ...o });
const user = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });
const assistant = (...content: object[]) => line({ type: 'assistant', message: { role: 'assistant', content } });

test('the previous answer is the prose after the last tool call since the last prompt', () => {
  const file = path.join(tempDir(), 't.jsonl');
  fs.writeFileSync(file, [
    user('예전 질문'),
    assistant({ type: 'text', text: '예전 답' }),
    user('배포 준비해 줘'),
    assistant({ type: 'text', text: '확인하고 있어요.' }, { type: 'tool_use', name: 'Bash', input: {} }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    assistant({ type: 'text', text: '준비했어요.' }),
    assistant({ type: 'text', text: 'A. 언제 배포할까요?' }),
    user('오늘'),
    '',
  ].join('\n'));
  assert.equal(lastAnswer(file, '오늘'), '준비했어요.\nA. 언제 배포할까요?');
  const first = path.join(tempDir(), 'first.jsonl');
  fs.writeFileSync(first, user('안녕') + '\n');
  assert.equal(lastAnswer(first, '안녕'), '');
  // 없으면 놓치는 실수: 다른 세션이 보낸 메시지 줄에서 멈춰 이전 답을 못 찾는다.
  const voice = 'Another Claude session sent a message:\n<agent-message from="relay01">\n[전달]\n오늘\n</agent-message>';
  const spoken = path.join(tempDir(), 'voice.jsonl');
  fs.writeFileSync(spoken, [user('배포 준비해 줘'), assistant({ type: 'text', text: '준비했어요.' }), line({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: voice } }), ''].join('\n'));
  assert.equal(lastAnswer(spoken, voice), '준비했어요.');
});

const hits = (median: number, ...h: Array<[number, number]>): SemanticHits => ({ median, hits: h.map(([id, sim]) => ({ id, sim })) });

// [늘 남김] 없으면 놓치는 실수: 앞 답으로 하는 두 번째 검색이 늦거나 없을 때 기억 주입이 통째로 빠진다(기억 주입, 2026-11-12 늘 남김으로 올림).
test('the question search is used alone when the second one times out, or without a previous answer', async () => {
  const q = hits(0.4, [1, 0.7]);
  const seen: string[] = [];
  const quick: SemanticSearch = async (query) => (seen.push(query), q);
  const timedOut: SemanticSearch = async (query) => (seen.push(query), null); // semanticClient's answer past its timeout
  assert.deepEqual(await prevAnswerSearch('A. 언제 배포할까요?', [quick, timedOut])('오늘', { limit: 10 }), q);
  assert.deepEqual(seen, ['오늘', '오늘\nA. 언제 배포할까요?']);
  seen.length = 0;
  assert.deepEqual(await prevAnswerSearch('', [quick, timedOut])('오늘', { limit: 10 }), q);
  assert.deepEqual(seen, ['오늘']);
});
