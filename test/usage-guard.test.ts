import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { tempDir } from './helpers.ts';
import { isGuardOverride } from '../src/usage/usage-guard-override.ts';
import { scriptPath } from '../src/core/paths.ts';

/** A login folder's .claude.json as Claude Code keeps it (other keys around oauthAccount, a nested object inside it). */
function login(folder: string, email: string): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.claude.json'),
    JSON.stringify({ numStartups: 3, projects: { 'C:/x': { allowedTools: [] } }, oauthAccount: { accountUuid: 'u', ccOnboardingFlags: { a: true }, emailAddress: email, displayName: 'n' } }),
  );
}

// Without it: one "keep going past 90%" lifted the guard for every account and every secretary on the PC.
test('the guard reads only its own account’s lift', () => {
  const home = tempDir();
  login(home, 'hong@gmail.com');
  const usage = path.join(home, '.secretary', 'usage');
  fs.mkdirSync(usage, { recursive: true });
  const soon = new Date(Date.now() + 3600_000).toISOString();
  fs.writeFileSync(path.join(usage, 'subscription-hong.json'), JSON.stringify({ five_hour_pct: 95, resets_at: soon, updated_at: new Date().toISOString() }));
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home, SECRETARY_TEST_LOGIN_HOME: home, SECRETARY_PROVIDER: 'subscription' };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SECRETARY_USAGE_GUARD_PCT']) delete env[k];
  const guard = () => execFileSync(process.execPath, [scriptPath('usageGuard')], { encoding: 'utf8', env, input: JSON.stringify({ tool_name: 'Bash' }) });
  assert.match(guard(), /"permissionDecision":"deny"/, 'over 90%: stopped');
  // Another account's lift does not count.
  fs.writeFileSync(path.join(usage, 'usage-guard-override-subscription-kim2.json'), JSON.stringify({ until: soon }));
  assert.match(guard(), /"permissionDecision":"deny"/);
  fs.writeFileSync(path.join(usage, 'usage-guard-override-subscription-hong.json'), JSON.stringify({ until: soon }));
  assert.equal(guard(), '', "this account's lift: not stopped");
});

// [늘 남김] Without it: someone who signs in with an API key (no claude.ai account in .claude.json, /usage gives no usage) is
// stopped for want of a record, or every tool call starts a heavy /usage reading again every 5 minutes for ever.
test('the guard without a usage record (an API key login): never stops; a reading that keeps failing waits longer each time', () => {
  const home = tempDir();
  const usage = path.join(home, '.secretary', 'usage');
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home, SECRETARY_TEST_LOGIN_HOME: home, SECRETARY_PROVIDER: 'subscription' };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SECRETARY_USAGE_GUARD_PCT']) delete env[k];
  assert.ok(env.SECRETARY_NO_MODEL_CALLS, 'the guard leaves its mark but starts no reading in tests');
  const guard = (more: NodeJS.ProcessEnv = {}) => execFileSync(process.execPath, [scriptPath('usageGuard')], { encoding: 'utf8', env: { ...env, ...more }, input: JSON.stringify({ tool_name: 'Bash' }) });
  // No login account to name the file: the provider's plain name.
  const mark = path.join(usage, 'subscription.refresh');
  // A key in the environment: not a subscription, nothing read or stopped.
  assert.equal(guard({ ANTHROPIC_API_KEY: 'x' }), '');
  assert.ok(!fs.existsSync(mark));
  // The last reading failed just now: no new one yet, and not stopped.
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(path.join(usage, 'subscription.fail'), JSON.stringify({ at: new Date().toISOString(), count: 3, reason: 'API usage' }));
  assert.equal(guard(), '');
  assert.ok(!fs.existsSync(mark), 'waits after failures');
  // The wait is over (3 failures: 20 minutes): it tries again, still without stopping.
  fs.writeFileSync(path.join(usage, 'subscription.fail'), JSON.stringify({ at: new Date(Date.now() - 21 * 60_000).toISOString(), count: 3 }));
  assert.equal(guard(), '');
  assert.ok(fs.existsSync(mark), 'tried again');
});

// [늘 남김] 없으면 놓치는 실수: 90% 이야기만 해도 정지 장치가 풀리거나, 넘어도 진행하라는 말을 못 알아들어 턴을 계속 막는다(훅이 턴을 잘못 막음).
test('the guard override takes close wordings of "go past 90%", not other talk about 90%', () => {
  for (const p of ['90퍼센트를 초과하더라도 진행', 'd3 - 90퍼 초과하더라도 진행 깃헙에 올려줘', '90% 넘어도 계속해', '90프로 넘더라도 진행해줘', '90 초과해도 진행']) {
    assert.ok(isGuardOverride(p), p);
  }
  for (const p of ['90%가 넘으면 멈춰', '90퍼 초과했어?', '진행해줘', '90% 넘으면 진행하지 마']) {
    assert.ok(!isGuardOverride(p), p);
  }
});
