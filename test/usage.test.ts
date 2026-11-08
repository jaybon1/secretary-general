import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { usageFile } from '../src/usage/files.ts';
import { applyGuardOverride } from '../src/usage/guard-override.ts';
import { handoffAccount, handoffNote, pauseLimit, usageContext } from '../src/usage/handoff-level.ts';
import { providerLabel, readProviders } from '../src/usage/providers.ts';
import { tempDir } from './helpers.ts';

test('account b goes first while it has used less than twice account a, else a sets the level', () => {
  assert.equal(handoffNote(30, 50), 'b 우선(작은 일도 넘김)');
  assert.equal(handoffNote(10, 0), 'b 우선(작은 일도 넘김)');
  assert.equal(handoffNote(30, 60), '넘기기 2단계');
  assert.equal(handoffNote(47, 95), '넘기기 3단계');
  assert.equal(handoffNote(0, 0), '넘기기 1단계');
  assert.equal(handoffNote(30, 50, 'c'), 'c 우선(작은 일도 넘김)');
});

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
  const account = { root, keysDir: keys, env: { SECRETARY_LOGIN_HOME: home } };
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
    line: (chat = 'subscription') => usageContext(NOW, chat, deps),
    pick: (chat = 'subscription') => handoffAccount(NOW, chat, deps),
  };
}

// Without it: going from "a and b" to "any number of subscriptions" changed the line or the account picked for those who
// have just a and b (this secretary's own setup), so the rules written against that line stop matching.
test('two subscriptions (a and b): the usage line and the account handed to are as before there could be more', () => {
  const f = fixture(['subscription-b']);
  const line = (body: string) => `<secretary-usage>${body}</secretary-usage>`;
  f.set('subscription', 30);
  f.set('subscription-b', 50);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30% · 계정 b 50% → b 우선(작은 일도 넘김)'));
  f.set('subscription-b', 60);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30% · 계정 b 60% → 넘기기 2단계'));
  // b at the guard's limit is still the one (no other to pick), and the note is worked out as before.
  f.set('subscription', 50);
  f.set('subscription-b', 95);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 50% · 계정 b 95% → b 우선(작은 일도 넘김)'));
  assert.equal(f.pick(), 'subscription-b');
  f.set('subscription', 30, { updated_at: iso(25 * 60_000) });
  f.set('subscription-b', null);
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30%(25분 전 기록) · 계정 b 기록 없음 → b 우선(작은 일도 넘김)'));
  assert.equal(f.pick(), 'subscription-b');
  f.set('subscription-b', 80, { resets_at: iso(60_000) });
  assert.equal(f.line(), line('5시간 사용량: 계정 a 30%(25분 전 기록) · 계정 b 초기화됨 → b 우선(작은 일도 넘김)'));
  // Chatting on b: work stays on b and b's % sets the level.
  f.set('subscription', 30);
  f.set('subscription-b', 70);
  assert.equal(f.line('subscription-b'), line('이 세션은 계정 b. 5시간 사용량: 계정 b 70% · 계정 a 30% → 넘기기 4단계(b 기준, 넘기는 일도 b)'));
  assert.equal(f.pick('subscription-b'), 'subscription-b');
  // No reading for the chat's own account: no line.
  f.set('subscription-b', null);
  assert.equal(f.line('subscription-b'), '');
  f.set('subscription', null);
  assert.equal(f.line(), '');
  // A chat on a provider that is not a subscription handed to (the gateway) reads like account a's.
  f.set('subscription', 30);
  f.set('subscription-b', 50);
  assert.equal(f.line('gw'), line('5시간 사용량: 계정 a 30% · 계정 b 50% → b 우선(작은 일도 넘김)'));
  // Only account a listed: auto stays on a.
  const solo = fixture([]);
  assert.equal(solo.pick(), 'subscription');
  assert.equal(pauseLimit({}), 90);
  assert.equal(pauseLimit({ USAGE_PAUSE_PCT: '80' }), 80);
});

// Without it: with three or more subscriptions work kept going to b while c sat idle, an account the guard would stop at
// once (90% in 5 hours or the week) was picked, or one never read (maybe not logged in) won over one with room.
test('three or more subscriptions: the one with the most room is picked, accounts at the guard\'s limit are passed over', () => {
  const f = fixture(['subscription-b', 'subscription-c', 'subscription-d']);
  const hint = (p: string) => ` (run-job·업무 세션은 기본 공급자 subscription-b로 도니 -Provider ${p}를 준다)`;
  f.set('subscription', 30);
  f.set('subscription-b', 70);
  f.set('subscription-c', 20);
  f.set('subscription-d', 45);
  assert.equal(f.pick(), 'subscription-c');
  assert.equal(
    f.line(),
    `<secretary-usage>5시간 사용량: 계정 a 30% · 계정 b 70% · 계정 c 20% · 계정 d 45% → 계정 c에 넘김, c 우선(작은 일도 넘김)${hint('subscription-c')}</secretary-usage>`,
  );
  // At the limit in its week, or in its 5 hours: passed over, even when its 5-hour % is the lowest.
  f.set('subscription-c', 10, { week_pct: 95, week_resets_at: iso(-86400_000) });
  assert.equal(f.pick(), 'subscription-d');
  f.set('subscription-c', 10, { week_pct: 95, week_resets_at: iso(60_000) });
  assert.equal(f.pick(), 'subscription-c', 'its week has reset');
  f.set('subscription-c', 92);
  assert.equal(f.pick(), 'subscription-d');
  assert.match(f.line(), /→ 계정 d에 넘김, d 우선\(작은 일도 넘김\) \(.*-Provider subscription-d/);
  // Every one at the limit: the lowest anyway, and the line says so.
  f.set('subscription-b', 95);
  f.set('subscription-d', 91);
  assert.equal(f.pick(), 'subscription-d');
  assert.match(f.line(), /→ 계정 d에 넘김\(넘길 구독 모두 90% 이상\), /);
  // An account with no reading yet loses to one that has a reading, unless none has.
  f.set('subscription-b', 70);
  f.set('subscription-c', null);
  f.set('subscription-d', null);
  assert.equal(f.pick(), 'subscription-b');
  f.set('subscription-b', null);
  assert.equal(f.pick(), 'subscription-b', 'none has a reading: the default');
  // A tie goes to the default provider, then the order in providers.json.
  f.set('subscription-b', 40);
  f.set('subscription-c', 20);
  f.set('subscription-d', 20);
  assert.equal(f.pick(), 'subscription-c');
  const g = fixture(['subscription-b', 'subscription-c', 'subscription-d'], 'subscription-d');
  for (const [p, pct] of [['subscription', 30], ['subscription-b', 40], ['subscription-c', 20], ['subscription-d', 20]] as const) g.set(p, pct);
  assert.equal(g.pick(), 'subscription-d');
  // Chatting on c: work stays on c, c's % sets the level, every other account is shown.
  assert.equal(f.pick('subscription-c'), 'subscription-c');
  assert.equal(
    f.line('subscription-c'),
    '<secretary-usage>이 세션은 계정 c. 5시간 사용량: 계정 c 20% · 계정 a 30% · 계정 b 40% · 계정 d 20% → 넘기기 2단계(c 기준, 넘기는 일도 c)</secretary-usage>',
  );
});

// Without it: with default "auto" the line still told the secretary to pass -Provider (or never told it when the default
// was a fixed account other than the one picked).
test('default "auto": the line names the account picked and no -Provider is needed', () => {
  const f = fixture(['subscription-b', 'subscription-c'], 'auto');
  f.set('subscription', 30);
  f.set('subscription-b', 70);
  f.set('subscription-c', 20);
  assert.equal(f.line(), '<secretary-usage>5시간 사용량: 계정 a 30% · 계정 b 70% · 계정 c 20% → 계정 c에 넘김, c 우선(작은 일도 넘김)</secretary-usage>');
  assert.equal(f.pick(), 'subscription-c');
  f.set('subscription-c', 75);
  assert.match(f.line(), /→ 계정 b에 넘김, 넘기기 2단계<\/secretary-usage>$/);
});

// Without it: a third subscription had no 계정 c name, so "계정 c 90퍼 넘어도 진행" lifted nothing (unknown account).
test('subscription-<id> is shown as 계정 <id>, and the 90% lift finds it by that name', () => {
  assert.equal(providerLabel('subscription-c'), '계정 c');
  assert.equal(providerLabel('subscription-b2'), '계정 b2');
  assert.equal(providerLabel('subscription-work'), 'subscription-work', 'a longer word stays the name');
  const f = fixture(['subscription-b', 'subscription-c']);
  f.set('subscription-c', 95);
  const out = applyGuardOverride('계정 c 90퍼 넘어도 진행', NOW, 'subscription', { dir: f.usage, account: f.account, providers: readProviders(f.root), env: {} });
  assert.match(out, /계정 c 초기화\(.*\)까지 풀었어요/);
  assert.ok(fs.existsSync(path.join(f.usage, 'guard-override-subscription-acct-c.json')));
});

// Without it: Use-Provider took "auto" for a provider's name and threw, or picked by a rule of its own that differs from the
// line the secretary reads; and when node could not run, run-job and work sessions stopped instead of going to b.
test('Use-Provider auto runs on the account the line picks; without the picker, the first subscription after a', { skip: process.platform !== 'win32' }, () => {
  const f = fixture(['subscription-b', 'subscription-c'], 'auto');
  // The usage files where the PowerShell side's node finds them (~/.claude/usage of USERPROFILE).
  const usage = path.join(f.home, '.claude', 'usage');
  fs.mkdirSync(usage, { recursive: true });
  const write = (provider: string, five: number) =>
    fs.writeFileSync(usageFile(provider, usage, f.account), JSON.stringify({ five_hour_pct: five, resets_at: new Date(Date.now() + 3600_000).toISOString(), updated_at: new Date().toISOString() }));
  write('subscription', 30);
  write('subscription-b', 70);
  write('subscription-c', 20);
  const lib = path.join(f.root, 'scripts', 'lib');
  for (const name of ['common.ps1', 'providers.ps1']) fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'lib', name), path.join(lib, name));
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: f.home, SECRETARY_LOGIN_HOME: f.home, SECRETARY_KEYS_DIR: f.keys };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.SECRETARY_PROVIDER;
  const run = (lines: string[]) =>
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', [`. '${path.join(lib, 'common.ps1')}'`, `. '${path.join(lib, 'providers.ps1')}'`, ...lines].join('; ')], { encoding: 'utf8', env })
      .trim()
      .split(/\r?\n/);
  // No src beside the copied scripts: the picker can't run, so the first subscription after a.
  assert.deepEqual(run([`$i = Use-Provider; "$($i.Name)|$env:SECRETARY_PROVIDER"`]), ['subscription-b|subscription-b']);
  // The real picker (src as a link to this copy's), reading this folder's providers.json.
  const link = path.join(f.root, 'src');
  fs.symlinkSync(path.join(PROJECT_ROOT, 'src'), link, 'junction');
  try {
    assert.deepEqual(run([`$i = Use-Provider; "$($i.Name)|$env:SECRETARY_PROVIDER"`, `"$((Use-Provider subscription-b).Name)"`]), ['subscription-c|subscription-c', 'subscription-b']);
    // A fixed name is never re-picked; -Provider auto picks like the default does.
    write('subscription-c', 80);
    assert.deepEqual(run([`"$((Use-Provider auto).Name)"`]), ['subscription-b']);
  } finally {
    // Only the link goes, never this copy's src behind it.
    fs.unlinkSync(link);
  }
});
