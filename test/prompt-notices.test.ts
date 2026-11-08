import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptNotices, PROMPT_NOTICES } from '../src/hooks/prompt-notices.ts';
import { tempStore } from './helpers.ts';

test('prompt notices: joined in list order, the one marked first runs before the rest', async () => {
  const ran: string[] = [];
  const n = (name: string, text: string, first = false) => ({ name, first, run: () => (ran.push(name), text) });
  const out = await promptNotices({ store: tempStore(), prompt: '질문' }, [n('a', 'A'), n('b', ''), n('board', 'B', true), n('c', 'C')]);
  assert.equal(out, 'A\nB\nC');
  assert.deepEqual(ran, ['board', 'a', 'b', 'c']);
  assert.deepEqual(PROMPT_NOTICES.map((x) => x.name), ['guard-override', 'usage', 'setup', 'watch', 'context-size', 'consolidate', 'rewind', 'purge', 'board', 'memory', 'guard-warn', 'question-label']);
});
