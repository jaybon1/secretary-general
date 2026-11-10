import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recall } from '../src/memory/recall.ts';
import { disabled, VECTOR_KEY, searchWith, startServerArgs, type SemanticSearch } from '../src/semantic-search/client.ts';
import { semanticSearchEnv } from '../src/semantic-search/config.ts';
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

test('the server embeds memories that lack a vector, then ranks by similarity', async () => {
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

test('the server embeds tags along with the sentence', async () => {
  const s = tempStore();
  s.remember({ kind: 'fact', content: '알림 시제품을 만든다.', tags: ['텃밭'] });
  const seen: string[] = [];
  const embed = async (texts: string[]) => texts.map((t) => (seen.push(t), Float32Array.from([1])));
  await searchWith(s, embed, '텃밭', { limit: 5 });
  assert.equal(seen[0], '알림 시제품을 만든다.\n텃밭');
});

// Without it: the server is started by Node's spawn again, inherits the pipes of whoever waits for a run-job (run-job ->
// claude -p -> memory MCP server -> helper), and that caller waits for the server's idle hour (reproduced 2026-11-09).
test('the server is started through Start-Process (no inherited handles), each argument quoted, the starter named', () => {
  const { file, args, env } = startServerArgs(true);
  assert.equal(file, 'powershell.exe');
  assert.match(args.at(-1)!, /Start-Process -FilePath \$env:SECRETARY_SEMANTIC_SEARCH_SERVER_EXE -ArgumentList \$env:SECRETARY_SEMANTIC_SEARCH_SERVER_ARGS -WindowStyle Hidden -PassThru/);
  assert.equal(env.SECRETARY_SEMANTIC_SEARCH_SERVER_EXE, process.execPath);
  assert.match(env.SECRETARY_SEMANTIC_SEARCH_SERVER_ARGS!, /^"[^"]+cli\.ts" "semantic-search-server" "--refetch"$/);
  assert.equal(env.SECRETARY_SEMANTIC_SEARCH_SERVER_STARTER, String(process.pid));
});
// 없으면 놓치는 실수: 옛 이름 SECRETARY_EMBED=off로 의미 검색을 꺼 둔 PC가 이름이 바뀐 뒤 의미 검색 서버를 다시 띄운다.
test('semantic search is off by SECRETARY_SEMANTIC_SEARCH=off, and for a while by the old SECRETARY_EMBED=off', () => {
  assert.equal(disabled({ SECRETARY_SEMANTIC_SEARCH: 'off' }), true);
  assert.equal(disabled({ SECRETARY_EMBED: 'off' }), true, 'the old name');
  assert.equal(disabled({ SECRETARY_SEMANTIC_SEARCH: 'on', SECRETARY_EMBED: 'off' }), false, 'the new name wins');
  assert.equal(disabled({}), false);
});
// 없으면 놓치는 실수: 옛 이름 SECRETARY_EMBED_MODEL_DIR 등으로 모델 폴더를 옮겨 둔 PC가 이름이 바뀐 뒤 모델을 못 찾아 다시 받는다.
test('the semantic-search settings read SECRETARY_SEMANTIC_SEARCH_*, and for a while the old SECRETARY_EMBED_*', () => {
  assert.equal(semanticSearchEnv('MODEL_DIR', { SECRETARY_SEMANTIC_SEARCH_MODEL_DIR: 'new' }), 'new');
  assert.equal(semanticSearchEnv('MODEL_DIR', { SECRETARY_EMBED_MODEL_DIR: 'old' }), 'old', 'the old name');
  assert.equal(semanticSearchEnv('IDLE_MIN', { SECRETARY_SEMANTIC_SEARCH_IDLE_MIN: '5', SECRETARY_EMBED_IDLE_MIN: '9' }), '5', 'the new name wins');
  assert.equal(semanticSearchEnv('MODEL_REPO', {}), undefined);
});