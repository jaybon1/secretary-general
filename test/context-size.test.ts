import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { contextNudge } from '../src/hooks/context-size-nudge.ts';
import { sessionStartContext } from '../src/hooks/session-start.ts';
import { tempStore } from './helpers.ts';

test('the /clear nudge comes once at 150k and again every 50k', () => {
  const store = tempStore();
  assert.equal(contextNudge(store, 's', 149_000), '');
  assert.match(contextNudge(store, 's', 151_000), /약 15만 토큰/);
  // 없으면 놓치는 실수: 같은 이야기를 이어 가는데도 /clear만 권해, 사용자가 앞 대화를 비우고 처음부터 다시 설명한다(2026-11-12 결정: 이어 가면 /compact).
  assert.match(contextNudge(store, 'compact', 151_000), /\/compact\(같은 이야기를 이어 갈 때[^]*\/clear\(다른 이야기로 넘어갈 때/);
  // 없으면 놓치는 실수: 할 일이 남은 답에서 /clear를 권해, 사용자가 이어 할 일의 앞 대화를 비운다(2026-11-14 사용자 결정: 그때는 /compact만).
  assert.match(contextNudge(store, 'todo', 151_000), /"없음"이면:[^]*\/clear[^]*할 일이 있으면:[^]*\/compact/);
  assert.doesNotMatch(contextNudge(store, 'todo2', 151_000).split('할 일이 있으면')[1], /\/clear/);
  assert.equal(contextNudge(store, 's', 190_000), '');
  assert.match(contextNudge(store, 's', 202_000), /약 20만 토큰/);
  assert.match(contextNudge(store, 'other', 152_000), /약 15만 토큰/);
  // 없으면 놓치는 실수: 압축 뒤에도 앞서 안내한 단계를 기억해, 다시 15만 토큰이 넘어도 안내가 안 나온다(2026-11-12 결정: 압축하면 다시 센다).
  sessionStartContext(store, 's', 'resume');
  assert.equal(contextNudge(store, 's', 160_000), '', 'a resume keeps the step');
  sessionStartContext(store, 's', 'compact');
  assert.equal(contextNudge(store, 's', 60_000), '');
  assert.match(contextNudge(store, 's', 151_000), /약 15만 토큰/);
  assert.equal(contextNudge(store, 'other', 190_000), '', 'another session keeps its own step');
});

