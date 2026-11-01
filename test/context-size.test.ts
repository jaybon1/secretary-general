import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { contextNudge, lastContextTokens } from '../src/context-size.ts';
import { tempDir, tempStore } from './helpers.ts';

test('the context size is what the last model call read', () => {
  const file = path.join(tempDir(), 't.jsonl');
  const call = (cr: number) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: cr, cache_creation_input_tokens: 1000 } } });
  fs.writeFileSync(file, [call(50_000), call(120_000), JSON.stringify({ type: 'user', message: { content: 'hi' } }), ''].join('\n'));
  assert.equal(lastContextTokens(file), 121_005);
});

test('the /clear nudge comes once at 150k and again every 50k', () => {
  const store = tempStore();
  assert.equal(contextNudge(store, 's', 149_000), '');
  assert.match(contextNudge(store, 's', 151_000), /약 15만 토큰/);
  assert.equal(contextNudge(store, 's', 190_000), '');
  assert.match(contextNudge(store, 's', 202_000), /약 20만 토큰/);
  assert.match(contextNudge(store, 'other', 152_000), /약 15만 토큰/);
});
