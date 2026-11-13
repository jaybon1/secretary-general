import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { compress, lastAnswer, mergeHits, prevAnswerSearch } from '../src/memory/prev-answer-search.ts';
import type { SemanticHits, SemanticSearch } from '../src/semantic-search/client.ts';
import { tempDir } from './helpers.ts';

test('compress keeps the conclusion, the question and its options, and bold headings', () => {
  const answer = [
    '> 알림 시제품은 내일까지 끝낼 수 있어요.',
    '오늘 한 일을 길게 설명하는 문단입니다.',
    '**남은 일**',
    '- 테스트 보강',
    'A. 배포는 언제 할까요?',
    '1. 오늘 저녁 (추천)',
    '2. 내일 아침',
    '그 밖의 설명.',
  ].join('\n');
  assert.equal(compress(answer), '알림 시제품은 내일까지 끝낼 수 있어요.\n남은 일\nA. 배포는 언제 할까요?\n1. 오늘 저녁\n2. 내일 아침');
});

test('compress reads the older bolded question line', () => {
  const answer = '결론입니다.\n**I. 어느 쪽으로 갈까요?** 둘 다 장단점이 있어요.\n1. 빠른 쪽\n2. 안전한 쪽';
  assert.equal(compress(answer), '결론입니다.\nI. 어느 쪽으로 갈까요? 둘 다 장단점이 있어요.\n1. 빠른 쪽\n2. 안전한 쪽');
});

test('compress adds the end of an answer without a question, and stays under 1500 chars', () => {
  const answer = `첫 줄 결론.\n${'가'.repeat(2000)}\n마지막 줄`;
  const c = compress(answer);
  assert.ok(c.startsWith('첫 줄 결론.\n'));
  assert.equal(c, `첫 줄 결론.\n${answer.slice(-600)}`);
  assert.ok(compress(`${'나'.repeat(1400)}\n${'다'.repeat(1000)}`).length <= 1500);
});

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
const leads = (r: SemanticHits | null) => r!.hits.map((h) => [h.id, Number((h.sim - r!.median).toFixed(4))]);

test('merging compares leads, docks the second search, and keeps the top 10 on the question median', () => {
  const q = hits(0.4, [1, 0.7], [2, 0.6]);
  const p = hits(0.5, [1, 0.85], [2, 0.75], [3, 0.9]);
  // id 1: 0.30 vs 0.35-0.02 → 0.33; id 2: 0.20 vs 0.23; id 3 only in the second: 0.38.
  assert.deepEqual(leads(mergeHits(q, p)), [[3, 0.38], [1, 0.33], [2, 0.23]]);
  assert.equal(mergeHits(q, p)!.median, 0.4);
  const many = hits(0.3, ...Array.from({ length: 15 }, (_, i) => [100 + i, 0.8 - i * 0.01] as [number, number]));
  assert.equal(mergeHits(q, many)!.hits.length, 10);
  assert.deepEqual(leads(mergeHits(null, p)), [[3, 0.38], [1, 0.33], [2, 0.23]]);
  assert.equal(mergeHits(null, null), null);
});

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
