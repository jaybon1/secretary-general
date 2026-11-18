import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { usageFile } from '../src/usage/usage-files.ts';
import { subscriptionPick, pauseLimit, routingContext } from '../src/usage/subscription-routing.ts';
import { tempDir } from './helpers.ts';

const NOW = Date.parse('2026-11-08T05:00:00Z');
const iso = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

/**
 * A secretary folder of its own: providers.json with account a ('subscription'), the given other subscriptions (each
 * logged in from its own config folder named by its key file) and a gateway, usage files in a temp folder.
 * Accounts are made-up names (acct-a@example.com …).
 */
function fixture(others: string[], def: string = 'subscription-b') {
  const dir = tempDir();
  const root = path.join(dir, 'root');
  const lib = path.join(root, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  const providers: Record<string, unknown> = { subscription: { type: 'claude-subscription', usage: 'claude-usage' } };
  for (const n of others) providers[n] = { type: 'claude-subscription', usage: 'claude-usage' };
  providers.gw = { type: 'claude-gateway', usage: 'none' };
  fs.writeFileSync(path.join(lib, 'providers.json'), JSON.stringify({ default: def, providers }));
  const home = path.join(dir, 'home');
  const keys = path.join(dir, 'keys');
  const login = (folder: string, email: string) => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  };
  login(home, 'acct-a@example.com');
  fs.mkdirSync(keys);
  for (const n of others) {
    const id = n.replace('subscription-', '');
    login(path.join(dir, `cfg-${id}`), `acct-${id}@example.com`);
    fs.writeFileSync(path.join(keys, `${n}.env`), `CLAUDE_CONFIG_DIR=${path.join(dir, `cfg-${id}`)}\n`);
  }
  const usage = path.join(dir, 'usage');
  fs.mkdirSync(usage);
  const account = { root, keysDir: keys, env: { SECRETARY_TEST_LOGIN_HOME: home } };
  const set = (provider: string, five: number | null, more: Record<string, unknown> = {}) => {
    const file = usageFile(provider, usage, account);
    if (five === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify({ five_hour_pct: five, resets_at: iso(-3600_000), updated_at: iso(), ...more }));
  };
  const deps = { dir: usage, account, limit: 90 };
  return {
    dir,
    root,
    home,
    keys,
    usage,
    account,
    set,
    line: (chat = 'subscription') => routingContext(NOW, chat, deps),
    pick: (chat = 'subscription') => subscriptionPick(NOW, chat, deps),
  };
}

// Without it: with just a and b (this secretary's own setup) the line lost the numbers, kept a routing level (gone 2026-11-12),
// or b at the guard's limit went unsaid; or auto picked other than b.
test('two subscriptions (a and b): the usage line shows the numbers, and b is the account handed to', () => {
  const f = fixture(['subscription-b']);
  const line = (body: string) => `<secretary-usage>${body}</secretary-usage>`;
  f.set('subscription', 30);
  f.set('subscription-b', 50);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30% · 계정 b 50%'));
  f.set('subscription-b', 60);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30% · 계정 b 60%'));
  // b at the guard's limit is still the one (no other to pick), and the line says to ask before going elsewhere.
  f.set('subscription', 50);
  f.set('subscription-b', 95);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 50% · 계정 b 95% → 보낼 구독 모두 90% 이상, 다른 계정·공급자로 돌릴지 먼저 묻는다'));
  assert.equal(f.pick(), 'subscription-b');
  f.set('subscription', 30, { updated_at: iso(25 * 60_000) });
  f.set('subscription-b', null);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30%(25분 전 기록) · 계정 b 기록 없음'));
  assert.equal(f.pick(), 'subscription-b');
  f.set('subscription-b', 80, { resets_at: iso(60_000) });
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30%(25분 전 기록) · 계정 b 초기화됨'));
  // Chatting on b: work stays on b.
  f.set('subscription', 30);
  f.set('subscription-b', 70);
  assert.equal(f.line('subscription-b'), line('이 세션은 계정 b. 5시간 사용량: 계정 b 70% · 계정 a 30% → 보내는 일도 b'));
  assert.equal(f.pick('subscription-b'), 'subscription-b');
  // No reading for the chat's own account: no line.
  f.set('subscription-b', null);
  assert.equal(f.line('subscription-b'), '');
  f.set('subscription', null);
  assert.equal(f.line(), '');
  // A chat on a provider that is not a subscription handed to (the gateway) reads like account a's.
  f.set('subscription', 30);
  f.set('subscription-b', 50);
  assert.equal(f.line('gw'), line('5시간 사용량: 계정 a 30% · 계정 b 50%'));
  // Only account a listed: auto stays on a.
  const solo = fixture([]);
  assert.equal(solo.pick(), 'subscription');
  assert.equal(pauseLimit({}), 90);
  // 없으면 놓치는 실수: SECRETARY_USAGE_GUARD_PCT로 정한 기준을 계정 고르기가 읽지 않는다.
  assert.equal(pauseLimit({ SECRETARY_USAGE_GUARD_PCT: '85' }), 85);
});
