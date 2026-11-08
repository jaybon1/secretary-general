import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recall } from '../src/memory/recall.ts';
import { VECTOR_KEY, searchWith, type SemanticSearch } from '../src/semantic/client.ts';
import { tempStore } from './helpers.ts';

test('a semantic hit is recalled without any shared words; one near the median is not', async () => {
  const s = tempStore();
  const dentist = s.remember({ kind: 'event', content: '치과 예약을 했다.' }).id;
  const coffee = s.remember({ kind: 'preference', content: '커피는 아이스 아메리카노를 좋아한다.' }).id;
  const semantic: SemanticSearch = async () => ({ median: 0.4, hits: [{ id: dentist, sim: 0.75 }, { id: coffee, sim: 0.5 }] });
  const r = await recall(s, '이 치료 받으러 가', { budgetTokens: 1000, minScore: 0.3, semantic });
  assert.deepEqual(r.items.map((i) => i.memory.id), [dentist]);
});

test('semantic hits on invalidated memories are dropped unless asked for', async () => {
  const s = tempStore();
  const old = s.remember({ kind: 'fact', content: '사용자는 부산에 산다.' }).id;
  s.forget(old, '이사');
  const semantic: SemanticSearch = async () => ({ median: 0.3, hits: [{ id: old, sim: 0.6 }] });
  assert.equal((await recall(s, '어디 살아', { budgetTokens: 1000, semantic })).items.length, 0);
  assert.equal((await recall(s, '어디 살아', { budgetTokens: 1000, semantic, includeInvalid: true })).items.length, 1);
});

test('the helper embeds memories that lack a vector, then ranks by similarity', async () => {
  const s = tempStore();
  const a = s.remember({ kind: 'fact', content: 'aaa' }).id;
  const b = s.remember({ kind: 'fact', content: 'bbb' }).id;
  // Fake model: a text's vector points along its first letter.
  const embed = async (texts: string[]) => texts.map((t) => Float32Array.from([t.startsWith('a') ? 1 : 0, t.startsWith('b') ? 1 : 0]));
  const r = await searchWith(s, embed, 'bravo', { limit: 5 });
  assert.deepEqual(r.hits.map((h) => h.id), [b, a]);
  assert.equal(s.memoriesWithoutVector(VECTOR_KEY).length, 0);
  assert.deepEqual([...s.vectors(VECTOR_KEY).find((v) => v.id === a)!.vector], [1, 0]);
});

test('the helper embeds tags along with the sentence', async () => {
  const s = tempStore();
  s.remember({ kind: 'fact', content: '알림 시제품을 만든다.', tags: ['텃밭'] });
  const seen: string[] = [];
  const embed = async (texts: string[]) => texts.map((t) => (seen.push(t), Float32Array.from([1])));
  await searchWith(s, embed, '텃밭', { limit: 5 });
  assert.equal(seen[0], '알림 시제품을 만든다.\n텃밭');
});
