// Local settings (src/core/this-secretary.ts): this secretary's this-secretary.local.json and the PC's shared all-secretaries.local.json
// (SECRETARY_SHARED_DIR in tests), sections per feature, the off feature's section not read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { hasThisSecretary, PATHS_SECTION, readThisSecretary, THIS_SECRETARY_FILE, writeThisSecretary } from '../src/core/this-secretary.ts';
import { readFeatures } from '../src/core/features.ts';
import { tempDir, write } from './helpers.ts';

const features = readFeatures(PROJECT_ROOT)!;

/** A temp secretary folder with this features.json (some features turned off). */
function rootWith(...off: string[]): string {
  const root = tempDir();
  write(path.join(root, 'features.json'), JSON.stringify({ features: features.map((f) => (off.includes(f.id) ? { ...f, enabled: false } : f)) }));
  return root;
}
const readAllOf = (root: string) => JSON.parse(fs.readFileSync(path.join(root, THIS_SECRETARY_FILE), 'utf8'));

// 없으면 놓치는 실수: 기능을 꺼도 그 키 값이 읽혀 꺼진 기능이 돌거나, 키 하나를 쓰다 다른 키를 지운다.
test('read and write: a feature off reads as missing, paths always; writing one section keeps the others', () => {
  const root = rootWith('dashboard');
  assert.deepEqual(readThisSecretary('dashboard', { root }), { ok: false, missing: true, error: "기능 'dashboard'이 꺼져 있음" });
  writeThisSecretary(PATHS_SECTION, { otherPcRoot: 'X:\\r' }, root);
  writeThisSecretary('dashboard', { port: 1 }, root);
  writeThisSecretary('usage-poll', { providers: [] }, root);
  assert.deepEqual(readAllOf(root), { paths: { otherPcRoot: 'X:\\r' }, dashboard: { port: 1 }, 'usage-poll': { providers: [] } });
  assert.equal(readThisSecretary('dashboard', { root }).ok, false, 'off: not read');
  assert.ok(hasThisSecretary('dashboard', root), 'but it is there');
  // Several readers: either on is enough (the usage choice is read by the reader and the dashboard).
  assert.equal(readThisSecretary('usage-poll', { root, features: ['usage-poll', 'dashboard'] }).ok, true);
  assert.equal(readThisSecretary('usage-poll', { root: rootWith('usage-poll', 'dashboard'), features: ['usage-poll', 'dashboard'] }).ok, false);
  assert.deepEqual(readThisSecretary(PATHS_SECTION, { root: rootWith(...features.map((f) => f.id)) }), { ok: false, missing: true, error: `${THIS_SECRETARY_FILE}에 'paths' 키 없음` });
  // A file that does not parse is said, and never written over.
  fs.writeFileSync(path.join(root, THIS_SECRETARY_FILE), '{ nope');
  assert.equal(readThisSecretary(PATHS_SECTION, { root }).ok, false);
  assert.throws(() => writeThisSecretary('usage-poll', {}, root), /못 읽어 쓰지 않음/);
  assert.equal(fs.readFileSync(path.join(root, THIS_SECRETARY_FILE), 'utf8'), '{ nope');
});

// [늘 남김] 없으면 놓치는 실수: 시험이 이 PC의 this-secretary.local.json을 읽거나 고쳐 쓴다.
test('this copy\'s own file is never read or written under the test mark', () => {
  assert.equal(readThisSecretary(PATHS_SECTION, { root: PROJECT_ROOT }).ok, false);
  assert.throws(() => writeThisSecretary('paths', {}, PROJECT_ROOT), /쓰지 않음/);
});
