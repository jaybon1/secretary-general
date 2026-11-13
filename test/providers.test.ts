import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { scriptPath } from '../src/core/paths.ts';
import { accountConfigDirs } from '../src/core/provider-accounts.ts';
import { tempDir } from './helpers.ts';

test('account config dirs: ~/.claude plus each subscription key file\'s CLAUDE_CONFIG_DIR, other providers ignored', () => {
  const root = tempDir();
  const keys = tempDir();
  fs.mkdirSync(path.dirname(scriptPath('providers', root)), { recursive: true });
  fs.writeFileSync(
    scriptPath('providers', root),
    JSON.stringify({ providers: { subscription: { type: 'claude-subscription' }, 'subscription-b': { type: 'claude-subscription' }, gateway: { type: 'claude-gateway' } } }),
  );
  fs.writeFileSync(path.join(keys, 'subscription-b.env'), 'X=1\nCLAUDE_CONFIG_DIR="%SECRETARY_TEST_HOME%\\.claude-b"\n');
  fs.writeFileSync(path.join(keys, 'gateway.env'), 'CLAUDE_CONFIG_DIR=C:\\should-not-count\n');
  process.env.SECRETARY_TEST_HOME = 'C:\\home';
  const dirs = accountConfigDirs(root, { SECRETARY_KEYS_DIR: keys });
  assert.deepEqual(dirs, [path.join(os.homedir(), '.claude'), 'C:\\home\\.claude-b']);
  assert.deepEqual(accountConfigDirs(root, { SECRETARY_KEYS_DIR: keys, CLAUDE_CONFIG_DIR: 'C:\\cur' })[0], 'C:\\cur');
});

// Without it: a provider with no personalDataAllowed (a gateway, a free plan, a new entry) is taken as allowed and gets the memory
// tools or runs in the secretary folder, or a paid one (anthropic-api) is still blocked as "not a subscription" (2026-11-13 decision).
test('personalDataAllowed: only true lets a provider have the memory read tools (Claude Code only) and run in the secretary folder', { skip: process.platform !== 'win32' }, () => {
  const root = tempDir();
  const keys = tempDir();
  const other = tempDir();
  const lib = path.join(root, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['common.ps1', 'this-secretary.ps1', 'providers.ps1', 'memory-mcp.ps1']) fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'lib', f), path.join(lib, f));
  fs.writeFileSync(
    path.join(lib, 'providers.json'),
    JSON.stringify({
      providers: {
        subscription: { type: 'claude-subscription', personalDataAllowed: true },
        api: { type: 'claude-api-key', personalDataAllowed: true, keyFile: 'api-key-*.env' },
        gw: { type: 'claude-gateway', personalDataAllowed: false, base_url: 'https://gw.example/v1' },
        unset: { type: 'claude-api-key' },
        text: { type: 'claude-api-key', personalDataAllowed: 'true' },
        agy: { type: 'antigravity-cli', personalDataAllowed: true },
      },
    }),
  );
  for (const f of ['api-key-x.env', 'gw.env', 'unset.env', 'text.env']) fs.writeFileSync(path.join(keys, f), 'K=1\n');
  const env: NodeJS.ProcessEnv = { ...process.env, SECRETARY_KEYS_DIR: keys };
  delete env.CLAUDE_CONFIG_DIR;
  const folder = (name: string, dir: string) => `try { Assert-SecretaryFolderProvider (Use-Provider ${name}) '${dir}'; '${name} ok' } catch { '${name} blocked' }`;
  const lines = [
    `. '${path.join(lib, 'common.ps1')}'`,
    `. '${path.join(lib, 'providers.ps1')}'`,
    `. '${path.join(lib, 'memory-mcp.ps1')}'`,
    `foreach ($n in 'subscription', 'api', 'gw', 'unset', 'text', 'agy') { $i = Use-Provider $n; "$n|$($i.PersonalDataAllowed)|$(Test-MemoryMcp $i)" }`,
    folder('gw', root),
    folder('unset', root),
    folder('api', root),
    folder('gw', other),
  ];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('; ')], { encoding: 'utf8', env }).trim().split(/\r?\n/);
  assert.deepEqual(out, [
    'subscription|True|True',
    'api|True|True',
    'gw|False|False',
    'unset|False|False',
    'text|False|False',
    // Another company's CLI: allowed, but it has no per-run MCP option, so no memory tools.
    'agy|True|False',
    'gw blocked',
    'unset blocked',
    'api ok',
    'gw ok',
  ]);
});
