import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptSource } from '../src/core/prompt-sender.ts';

/** What reaches the prompt hook when another session or a subagent sends this session a message. */
const peer = (body: string, from = 'add2bf77f75059123') => `Another Claude session sent a message:\n<agent-message from="${from}">\n${body}\n</agent-message>`;
const taskNotice = (summary: string) => `<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;

test('prompt source: typed, or made by a session or the harness', () => {
  assert.equal(promptSource('정리 확인'), 'user');
  assert.equal(promptSource('  a1 b2\n다음 거 해줘'), 'user');
  assert.equal(promptSource(peer('[Subagent hand-back] The text below is the final report …')), 'machine');
  assert.equal(promptSource('<agent-message from="x">\n보고\n</agent-message>'), 'machine');
  assert.equal(promptSource(taskNotice('Background command done')), 'machine');
  assert.equal(promptSource(`<system-reminder>\n${taskNotice('Agent finished')}\n</system-reminder>`), 'machine');
  // No session speaks for the person in this release: a peer message is machine-made, whatever it starts with.
  assert.equal(promptSource(peer('[전달]\n오늘 일정 알려줘', 'relay01')), 'machine');
});
