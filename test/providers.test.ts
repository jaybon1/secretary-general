import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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
