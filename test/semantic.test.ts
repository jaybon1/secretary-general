import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recall } from '../src/memory/recall.ts';
import { type SemanticSearch } from '../src/semantic-search/client.ts';
import { tempStore } from './helpers.ts';

test('a semantic hit is recalled without any shared words; one near the median is not', async () => {
  const s = tempStore();
  const dentist = s.remember({ kind: 'event', content: '치과 예약을 했다.' }).id;
  const coffee = s.remember({ kind: 'preference', content: '커피는 아이스 아메리카노를 좋아한다.' }).id;
  const semantic: SemanticSearch = async () => ({ median: 0.4, hits: [{ id: dentist, sim: 0.75 }, { id: coffee, sim: 0.5 }] });
  const r = await recall(s, '이 치료 받으러 가', { budgetTokens: 1000, minScore: 0.3, semantic });
  assert.deepEqual(r.items.map((i) => i.memory.id), [dentist]);
});
