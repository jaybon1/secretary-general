import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptNotices, PROMPT_NOTICES } from '../src/hooks/prompt-notices.ts';
import { tempStore } from './helpers.ts';
import { HOOK_NOTICE_KEYS, hookNoticeText } from '../src/core/hook-notice-text.ts';
import { FORMAT_NOTICE_KEYS } from '../src/mistake-guards/answer-check-table.ts';

// 없으면 놓치는 실수: .agents/hook-notices의 파일이나 `## 항목` 이름이 바뀌어, 훅이 붙이는 안내(상황판 읽는 법, 기억 정리 보고 때 할 일, 답 형식)가 빈 채로 나간다.
test('hook notices: every text a hook reads is in .agents/hook-notices, and a missing one is empty', () => {
  // The answer checks' pieces are listed by their own feature (2026-11-12: core does not import mistake-guards).
  assert.ok(FORMAT_NOTICE_KEYS.length > 0);
  for (const [name, keys] of Object.entries({ ...HOOK_NOTICE_KEYS, 'answer-format': FORMAT_NOTICE_KEYS })) for (const key of keys) assert.ok(hookNoticeText(name, key).length > 10, `${name}.md ## ${key}`);
  assert.equal(hookNoticeText('situation-board', 'no-such-key'), '');
  assert.equal(hookNoticeText('no-such-file', 'reading'), '');
});

test('prompt notices: joined in list order, the one marked first runs before the rest', async () => {
  const ran: string[] = [];
  const n = (name: string, text: string, first = false) => ({ name, first, run: () => (ran.push(name), text) });
  const out = await promptNotices({ store: tempStore(), prompt: '질문' }, [n('a', 'A'), n('b', ''), n('board', 'B', true), n('c', 'C')]);
  assert.equal(out, 'A\nB\nC');
  assert.deepEqual(ran, ['board', 'a', 'b', 'c']);
  assert.deepEqual(PROMPT_NOTICES.map((x) => x.name), ['usage-guard-override', 'subscription-routing', 'setup-check', 'watch-missing', 'context-size', 'memory-consolidation', 'rewind', 'purge', 'situation-board', 'memory-core', 'answer-check-warn', 'question-label']);
});
