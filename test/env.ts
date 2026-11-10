/**
 * Keeps a test process apart from this PC's secretary. It runs before anything else (`node --import ./test/env.ts
 * --test`, test/run-tests.mjs) because core/config.ts reads its paths once, when it loads; helpers.ts imports it too,
 * for a test file run on its own. Every path a test, or what it starts (cli, MCP server, PowerShell), would otherwise
 * take from the real install points into this process's own temp folder, removed when it ends, and the no-model mark
 * is set: starting claude or a run-job fails instead of calling a model (src/core/no-model-calls.ts). This PC's own settings
 * files (this-secretary.local.json and scripts/*.local.json) are not read (src/core/local-settings.ts).
 * A test that needs one of these elsewhere still sets it itself (semantic-search-outage.test.ts, mcp.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_LOCAL_ENV } from '../src/core/local-settings.ts';
import { NO_MODEL_ENV } from '../src/core/no-model-calls.ts';

/** This process's folder for them (the long path: %TEMP% can be an 8.3 short one). */
export const ENV_DIR = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-test-env-')));

Object.assign(process.env, {
  SECRETARY_DB: path.join(ENV_DIR, 'secretary.db'),
  SECRETARY_WORKSPACE_ROOT: path.join(ENV_DIR, 'workspaces'),
  SECRETARY_KEYS_DIR: path.join(ENV_DIR, 'keys'),
  // The PC's shared settings folder (all-secretaries.local.json, src/core/this-secretary.ts), otherwise ~/.secretary.
  SECRETARY_SHARED_DIR: path.join(ENV_DIR, 'shared'),
  // The default login (~/.claude.json) that names the usage files by account (src/core/provider-accounts.ts loginHome).
  SECRETARY_TEST_LOGIN_HOME: path.join(ENV_DIR, 'home'),
  SECRETARY_SEMANTIC_SEARCH_MODEL_DIR: path.join(ENV_DIR, 'models'),
  // The repeat reminder's per-session counts (src/mistake-guards/repeat-hook.ts), otherwise under the system temp folder.
  SECRETARY_TEST_REPEAT_HOOK_STATE_DIR: path.join(ENV_DIR, 'repeat'),
  // Tests never start the semantic-search server or download its model; semantic tests inject a fake.
  SECRETARY_SEMANTIC_SEARCH: 'off',
  [NO_MODEL_ENV]: '1',
  // This copy's own scripts/*.local.json (this PC's settings) read as missing; a test that needs one writes it in a temp copy.
  [NO_LOCAL_ENV]: '1',
});

process.on('exit', () => {
  try {
    fs.rmSync(ENV_DIR, { recursive: true, force: true, maxRetries: 2 });
  } catch {}
});
