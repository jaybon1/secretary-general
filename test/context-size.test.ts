import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { contextNudge, lastContextTokens } from '../src/hooks/context-size-nudge.ts';
import { sessionStartContext } from '../src/hooks/session-start.ts';
import { tempDir, tempStore } from './helpers.ts';

test('the context size is what the last model call read', () => {
  const file = path.join(tempDir(), 't.jsonl');
  const call = (cr: number) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: cr, cache_creation_input_tokens: 1000 } } });
  fs.writeFileSync(file, [call(50_000), call(120_000), JSON.stringify({ type: 'user', message: { content: 'hi' } }), ''].join('\n'));
  assert.equal(lastContextTokens(file), 121_005);
  // 없으면 놓치는 실수: 압축 직후 첫 질문에서 압축 전 마지막 호출(31만)을 지금 크기로 읽어 "31만 토큰" 안내가 다시 나간다.
  const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
  fs.appendFileSync(file, [boundary, JSON.stringify({ type: 'user', message: { content: 'next' } }), ''].join('\n'));
  assert.equal(lastContextTokens(file), 0);
  fs.appendFileSync(file, [call(80_000), ''].join('\n'));
  assert.equal(lastContextTokens(file), 81_005);
});

test('the /clear nudge comes once at 150k and again every 50k', () => {
  const store = tempStore();
  assert.equal(contextNudge(store, 's', 149_000), '');
  assert.match(contextNudge(store, 's', 151_000), /약 15만 토큰/);
  // 없으면 놓치는 실수: 같은 이야기를 이어 가는데도 /clear만 권해, 사용자가 앞 대화를 비우고 처음부터 다시 설명한다(2026-11-12 결정: 이어 가면 /compact).
  assert.match(contextNudge(store, 'compact', 151_000), /이어 가려면 \/compact[^]*넘어가려면 \/clear[^]*DB에 남아요/);
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

