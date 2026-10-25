import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOverridePhrase } from '../src/usage.ts';

test('only the "keep going past 90%" phrase lifts the usage guard', () => {
  assert.equal(isOverridePhrase('90퍼센트를 초과하더라도 진행해'), true);
  assert.equal(isOverridePhrase('이건 90% 초과하더라도 진행'), true);
  assert.equal(isOverridePhrase('90퍼센트 넘으면 멈춰'), false);
  assert.equal(isOverridePhrase('진행해'), false);
});
