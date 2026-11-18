// The usage reader (feature usage-poll, src/usage/usage-poller.ts) and the choice of providers it reads and the dashboard
// shows (src/usage/usage-settings.ts, this-secretary.local.json usage-poll).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write } from './helpers.ts';
import { BUSY_MS, POLL_MS, refreshMark, runUsageScript, UsagePoller } from '../src/usage/usage-poller.ts';

test('usage reader: one provider at a time, a reading under 150 s old (the guard\'s) skipped, its mark left for the guard, a failure logged', async () => {
  const dir = tempDir();
  let now = Date.parse('2026-11-07T10:00:00Z');
  const order: string[] = [];
  const logs: string[] = [];
  let inFlight = 0;
  let release: () => void = () => {};
  let gate: Promise<void> | null = null;
  const poller = new UsagePoller({
    names: () => ['subscription', 'subscription-b', 'bad'],
    run: async (name) => {
      inFlight++;
      assert.equal(inFlight, 1, 'never two at once');
      order.push(name);
      if (gate) await gate;
      inFlight--;
      if (name === 'bad') throw new Error('boom\nmore');
    },
    usageDir: dir,
    now: () => now,
    log: (l) => logs.push(l),
  });
  // The usage guard started subscription-b a minute ago: skipped this round.
  write(refreshMark('subscription-b', dir), String(now - 60_000));
  assert.deepEqual(await poller.tick(), ['subscription']);
  assert.deepEqual(order, ['subscription', 'bad']);
  assert.deepEqual(logs, ['사용량 조회 실패(bad): boom']);
  assert.equal(fs.readFileSync(refreshMark('subscription', dir), 'utf8'), String(now), 'the guard sees it and starts nothing for 5 minutes');
  // Five minutes later every mark is old: all are read again. A round still going makes the next do nothing.
  now += POLL_MS;
  order.length = 0;
  gate = new Promise((r) => (release = r));
  const first = poller.tick();
  assert.deepEqual(await poller.tick(), []);
  release();
  gate = null;
  assert.deepEqual(await first, ['subscription', 'subscription-b']);
  assert.deepEqual(order, ['subscription', 'subscription-b', 'bad']);
  assert.ok(BUSY_MS < POLL_MS);
  await assert.rejects(runUsageScript('subscription'), /테스트 중에는/, 'the real reading never runs in tests');
});
