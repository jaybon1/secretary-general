import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDuplicates, duplicateMessage, DUP_MIN_SIM } from '../src/memory/duplicate-check.ts';
import { MemoryRaceError } from '../src/store/store.ts';
import { tempStore } from './helpers.ts';

test('duplicate check: a recent active memory close in meaning stops the save; superseded, old, summary and weak hits do not', async () => {
  const s = tempStore();
  const old = s.remember({ kind: 'fact', content: '오래된 같은 사실' });
  s.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 5 * 86_400_000).toISOString(), old.id);
  const recent = s.remember({ kind: 'decision', content: '2026-11-05 상황판은 쉬는 시간에 미리 고쳐 쓴다.' });
  const replaced = s.remember({ kind: 'fact', content: '옛 결정' });
  const summary = s.remember({ kind: 'summary', content: '요약' });
  const weak = s.remember({ kind: 'fact', content: '관계 적은 기억' });
  const queries: string[] = [];
  const search = async (q: string) => {
    queries.push(q);
    return { median: 0.3, hits: [old.id, recent.id, replaced.id, summary.id].map((id) => ({ id, sim: 0.9 })).concat([{ id: weak.id, sim: DUP_MIN_SIM - 0.01 }]) };
  };
  const r = await checkDuplicates(s, search, { content: ' 상황판은 쉬는 시간에 갱신한다 ', tags: ['비서', ' 상황판 '], supersedes: [replaced.id] });
  assert.deepEqual(queries, ['상황판은 쉬는 시간에 갱신한다\n비서 상황판'], 'same text the server embeds memories with');
  assert.deepEqual(r.similar.map((x) => x.memory.id), [recent.id]);
  assert.equal(r.maxId, weak.id);
  assert.match(duplicateMessage(r.similar, (iso) => iso.slice(0, 10)), new RegExp(`#${recent.id} decision [^\\n]*\\(점수 0\\.900\\): 2026-11-05 상황판은[\\s\\S]*supersedes[\\s\\S]*allow_similar: true`));

  const down = await checkDuplicates(s, async () => null, { content: 'x' });
  assert.deepEqual([down.skipped, down.similar.length], [true, 0], 'helper down: nothing compared, the save goes on');
});

test('duplicate check race: an insert is refused when another writer saved after the check (optimistic lock)', () => {
  const s = tempStore();
  const seen = s.maxMemoryId();
  s.remember({ kind: 'fact', content: '다른 쪽이 먼저 저장' });
  assert.throws(() => s.remember({ kind: 'fact', content: '같은 사실', expectMaxId: seen }), MemoryRaceError);
  assert.equal(s.maxMemoryId(), seen + 1, 'nothing inserted');
  assert.ok(s.remember({ kind: 'fact', content: '같은 사실', expectMaxId: s.maxMemoryId() }).id);
});
