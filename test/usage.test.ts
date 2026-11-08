import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffNote } from '../src/usage/handoff-level.ts';

test('account b goes first while it has used less than twice account a, else a sets the level', () => {
  assert.equal(handoffNote(30, 50), 'b 우선(작은 일도 넘김)');
  assert.equal(handoffNote(10, 0), 'b 우선(작은 일도 넘김)');
  assert.equal(handoffNote(30, 60), '넘기기 2단계');
  assert.equal(handoffNote(47, 95), '넘기기 3단계');
  assert.equal(handoffNote(0, 0), '넘기기 1단계');
});
