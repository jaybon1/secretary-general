// The usage reader (feature usage-poll, src/usage/usage-poller.ts) and the choice of providers it reads and the dashboard
// shows (src/usage/usage-settings.ts, this-secretary.local.json usage-poll).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write } from './helpers.ts';
import { BUSY_MS, claimLock, lockFile, POLL_MS, pollOn, refreshMark, releaseLock, runUsagePoll, runUsageScript, UsagePoller } from '../src/usage/usage-poller.ts';
import { readUsageChoice, saveUsageChoice, usageSettingsView } from '../src/usage/usage-settings.ts';
import type { ProviderInfo } from '../src/usage/provider-usage.ts';
import { failFile, failureWaitMs, readFailure, recordFailure } from '../src/usage/usage-files.ts';
import { limitsFor } from '../src/dashboard/collect.ts';

const PROVIDERS: ProviderInfo[] = [
  { name: 'subscription', type: 'claude-subscription', label: '계정 a', usage: 'claude-usage' },
  { name: 'subscription-b', type: 'claude-subscription', label: '계정 b', usage: 'claude-usage' },
  { name: 'cli', type: 'some-cli', label: '다른 CLI', usage: 'agy' },
  { name: 'key', type: 'claude-api-key', label: 'key', usage: 'none' },
];

test('usage settings: without the file what is readable and set up here; saved names only known ones, no BOM; bad input refused', () => {
  const dir = tempDir();
  const file = path.join(dir, 'this-secretary.local.json');
  const deps = { keysDir: path.join(dir, 'keys'), home: path.join(dir, 'home'), localAppData: path.join(dir, 'local') };
  write(path.join(dir, 'home', '.claude', 'x'), '');
  write(path.join(dir, 'keys', 'subscription-b.env'), 'X=1\n');
  write(path.join(dir, 'keys', 'key.env'), 'X=1\n');
  let c = readUsageChoice(PROVIDERS, dir, deps);
  assert.deepEqual(c, { checked: ['subscription', 'subscription-b'], saved: false, problem: null }, 'agy not installed, key not readable');
  assert.deepEqual(saveUsageChoice({ providers: ['key', 'nope', 'subscription'] }, PROVIDERS, dir), ['subscription', 'key']);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.startsWith('﻿'));
  assert.deepEqual(JSON.parse(raw), { 'usage-poll': { providers: ['subscription', 'key'] } });
  c = readUsageChoice(PROVIDERS, dir, deps);
  assert.deepEqual(c, { checked: ['subscription', 'key'], saved: true, problem: null });
  const view = usageSettingsView(PROVIDERS, c, deps);
  assert.deepEqual(view.providers.map((p) => [p.name, p.readable, p.configured, p.checked]), [
    ['subscription', true, true, true],
    ['subscription-b', true, true, false],
    ['cli', true, false, false],
    ['key', false, false, true],
  ]);
  assert.equal(view.providers[3].methodText, '조회 안 됨');
  for (const bad of [null, [], { providers: 'subscription' }, { providers: [1] }, { providers: Array(101).fill('x') }]) {
    assert.throws(() => saveUsageChoice(bad, PROVIDERS, dir), TypeError, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.deepEqual(saveUsageChoice({ providers: [] }, PROVIDERS, dir), [], 'none checked is a choice too');
  assert.deepEqual(readUsageChoice(PROVIDERS, dir, deps).checked, []);
  fs.writeFileSync(file, '{ nope');
  assert.match(readUsageChoice(PROVIDERS, dir, deps).problem!, /못 읽음/);
});

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
  await assert.rejects(runUsageScript('subscription'), /시험 중에는/, 'the real reading never runs in tests');
});

// 없으면 놓치는 실수: API 키로 로그인해 /usage가 사용량을 주지 않는(또는 claude가 없는) PC에서 조회기가 5분마다 영원히 실패를 되풀이하거나,
// 조회 스크립트가 이미 적은 실패를 한 번 더 세거나, 대시보드 계정 칸이 왜 비었는지 말하지 않는다.
test('usage reader: readings that keep failing wait 5, 10, 20 … minutes (at most 6 hours); the dashboard card says why', async () => {
  const dir = tempDir();
  const t0 = Date.parse('2026-11-07T10:00:00Z');
  let now = t0;
  const runs: string[] = [];
  const poller = new UsagePoller({
    names: () => ['subscription', 'scripted'],
    run: async (name) => {
      runs.push(name);
      // usage-query.ps1 got as far as writing its own failure (one more in a row).
      if (name === 'scripted') recordFailure(name, 'Current session 없음', dir, now);
      throw new Error('사용량을 읽지 못했어요');
    },
    usageDir: dir,
    now: () => now,
  });
  const at = async (min: number) => {
    now = t0 + min * 60_000;
    runs.length = 0;
    await poller.tick();
    return [...runs];
  };
  assert.deepEqual(await at(0), ['subscription', 'scripted']);
  assert.equal(readFailure('scripted', dir)?.count, 1, 'not counted twice');
  assert.equal(readFailure('subscription', dir)?.count, 1, 'a script that failed before writing it: the reader writes it');
  assert.deepEqual(await at(4), []);
  assert.deepEqual(await at(5), ['subscription', 'scripted']);
  assert.deepEqual(await at(10), [], 'two in a row: 10 minutes');
  assert.deepEqual(await at(15), ['subscription', 'scripted']);
  assert.equal(failureWaitMs(1), 5 * 60_000);
  assert.equal(failureWaitMs(4), 40 * 60_000);
  assert.equal(failureWaitMs(50), 6 * 3600_000);
  // The card of a provider never read says it failed, how often, why, and when it tries next.
  const [card] = limitsFor([PROVIDERS[0]], ['subscription'], dir, now);
  assert.ok('error' in card);
  assert.match(card.error, /조회 실패 3번/);
  assert.match(card.error, /다음 시도/);
  fs.rmSync(failFile('subscription', dir));
  const [fresh] = limitsFor([PROVIDERS[0]], ['subscription'], dir, now);
  assert.ok('error' in fresh && fresh.error === '아직 조회 기록 없음');
});

// 없으면 놓치는 실수: 비서 서버가 다시 켜질 때마다 조회기가 하나 더 떠 같은 공급자를 겹쳐 조회하거나, 기능을 꺼도 조회가 돈다.
test('usage-poll: one reader per PC (a dead holder\'s lock is taken over), none while another runs, none when the feature is off', () => {
  const dir = tempDir();
  const lock = lockFile(dir);
  assert.equal(claimLock(lock, 111, () => true), true);
  assert.equal(claimLock(lock, 222, () => true), false, 'a live reader holds it');
  assert.equal(claimLock(lock, 222, () => false), true, 'its holder died');
  releaseLock(lock, 111);
  assert.equal(fs.readFileSync(lock, 'utf8'), '222', 'only the holder lets it go');
  releaseLock(lock, 222);
  assert.ok(!fs.existsSync(lock));
  // Another reader runs (a live process holds the lock): this one starts nothing.
  fs.writeFileSync(lock, String(process.ppid));
  assert.equal(runUsagePoll(undefined, { root: tempDir(), usageDir: dir }), 'running');
  // The feature off in features.json: it ends at once, the lock untouched.
  const root = tempDir();
  write(path.join(root, 'features.json'), JSON.stringify({ features: [{ id: 'usage-poll', enabled: false }] }));
  assert.equal(pollOn(root), false);
  assert.equal(pollOn(tempDir()), true, 'on without features.json');
  fs.rmSync(lock);
  assert.equal(runUsagePoll(undefined, { root, usageDir: dir }), 'off');
  assert.ok(!fs.existsSync(lock));
});
