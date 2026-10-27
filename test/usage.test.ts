import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOverridePhrase } from '../src/usage.ts';

test('close wordings of "keep going past 90%" lift the usage guard, other talk about 90% does not', () => {
  for (const p of ['90퍼 초과하더라도 진행 깃헙에 올려줘', '90% 넘어도 계속해', '90프로 넘더라도 진행해줘', '90 초과해도 진행']) assert.equal(isOverridePhrase(p), true, p);
  for (const p of ['90%가 넘으면 멈춰', '90퍼 초과했어?', '90% 넘으면 진행하지 마']) assert.equal(isOverridePhrase(p), false, p);
  assert.equal(isOverridePhrase('90퍼센트를 초과하더라도 진행해'), true);
  assert.equal(isOverridePhrase('이건 90% 초과하더라도 진행'), true);
  assert.equal(isOverridePhrase('90퍼센트 넘으면 멈춰'), false);
  assert.equal(isOverridePhrase('진행해'), false);
});
