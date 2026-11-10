// Local settings (src/core/this-secretary.ts): this secretary's this-secretary.local.json and the PC's shared all-secretaries.local.json
// (SECRETARY_SHARED_DIR in tests), sections per feature, the off feature's section not read, and the merge of the separate
// scripts/*.local.json files they replaced (2026-11-10), the old main PC file named by Tailscale (output handed in).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { ALL_SECRETARIES_EXAMPLE, allSecretariesFile, hasThisSecretary, leftoverThisSecretaryFiles, mergeThisSecretaryFiles, MERGE_BACKUP_DIR, PATHS_SECTION, planThisSecretaryMerge, readThisSecretary, THIS_SECRETARY_EXAMPLE, THIS_SECRETARY_FILE, writeThisSecretary } from '../src/core/this-secretary.ts';
import { readFeatures } from '../src/setup/features.ts';
import { SECRETARY_ID_ALPHABET, SECRETARY_ID_LENGTH } from '../src/setup/secretary-id.ts';
import { tempDir, write } from './helpers.ts';

const features = readFeatures(PROJECT_ROOT)!;
const columns = features.filter((f) => f.thisSecretary);
const sourceFiles = columns.flatMap((f) => (f.thisSecretary!.from ?? []).map((s) => (typeof s === 'string' ? s : s.file)));

/** A temp secretary folder with this features.json (some features turned off). */
function rootWith(...off: string[]): string {
  const root = tempDir();
  write(path.join(root, 'features.json'), JSON.stringify({ features: features.map((f) => (off.includes(f.id) ? { ...f, enabled: false } : f)) }));
  return root;
}
const readAllOf = (root: string) => JSON.parse(fs.readFileSync(path.join(root, THIS_SECRETARY_FILE), 'utf8'));

// 없으면 놓치는 실수: 기능 칸 이름이 기능 id와 어긋나 기능을 꺼도 그 칸이 계속 읽히거나, 옛 파일이 .gitignore에서 빠져 이 PC 값이 커밋되거나, 예시에 칸이 빠진다.
test('features.json thisSecretary: a section per feature named by its id (paths for the core), old files git-ignored, every section in the example', () => {
  assert.ok(columns.length >= 5 && columns.some((f) => f.core), 'the features that keep this PC settings say so');
  const sections = columns.map((f) => f.thisSecretary!.section);
  assert.equal(new Set(sections).size, sections.length, 'one feature per section');
  for (const f of columns) assert.equal(f.thisSecretary!.section, f.core ? PATHS_SECTION : f.id, `${f.id}: section`);
  const ignore = fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes(`/${THIS_SECRETARY_FILE}`), `.gitignore: /${THIS_SECRETARY_FILE}`);
  for (const f of new Set(sourceFiles)) assert.ok(ignore.includes(f), `.gitignore keeps ignoring the old file until it is moved: ${f}`);
  // Each example has the sections of its file (the shared one: the columns with shared true), nothing else.
  for (const [name, shared] of [[THIS_SECRETARY_EXAMPLE, false], [ALL_SECRETARIES_EXAMPLE, true]] as const) {
    const example = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, name), 'utf8'));
    const want = columns.filter((f) => !!f.thisSecretary!.shared === shared).map((f) => f.thisSecretary!.section);
    assert.deepEqual(Object.keys(example).filter((k) => k !== 'about').sort(), [...want].sort(), `${name}: a section for each, nothing else`);
  }
});

// 없으면 놓치는 실수: 기능을 꺼도 그 칸 값이 읽혀 꺼진 기능이 돌거나, 칸 하나를 쓰다 다른 칸을 지운다.
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
  assert.deepEqual(readThisSecretary(PATHS_SECTION, { root: rootWith(...features.map((f) => f.id)) }), { ok: false, missing: true, error: `${THIS_SECRETARY_FILE}에 'paths' 칸 없음` });
  // A file that does not parse is said, and never written over.
  fs.writeFileSync(path.join(root, THIS_SECRETARY_FILE), '{ nope');
  assert.equal(readThisSecretary(PATHS_SECTION, { root }).ok, false);
  assert.throws(() => writeThisSecretary('usage-poll', {}, root), /못 읽어 쓰지 않음/);
  assert.equal(fs.readFileSync(path.join(root, THIS_SECRETARY_FILE), 'utf8'), '{ nope');
});

// 없으면 놓치는 실수: 옛 이 비서 설정 파일을 합치다 값을 덮어쓰거나 잃고(다른 PC 경로가 다른 칸으로 가지 않음), 다시 돌리면 또 옮기거나, 보기만 할 때 파일을 건드린다.
test('merge: each old file into its sections, the old file to the backup folder; nothing overwritten; dry run touches nothing; again does nothing', () => {
  const root = rootWith('phone-push');
  const old = (f: string, v: unknown, bom = false) => write(path.join(root, 'scripts', f), `${bom ? '\uFEFF' : ''}${JSON.stringify(v)}`);
  old('mistake-guards.local.json', { otherPcRoot: 'X:\\ai', levels: { english: 'warn' }, repeatLimit: 4 });
  old('usage.local.json', { providers: ['subscription'] }, true);
  // An off feature's file still moves (its values are kept for when it is turned on again).
  old('phone-push.local.json', { url: 'http://127.0.0.1:2586', topic: 't' });
  write(path.join(root, 'scripts', 'dashboard.local.json'), '{ not json');
  const before = fs.readdirSync(path.join(root, 'scripts')).sort();
  const dry = mergeThisSecretaryFiles(root, { dryRun: true });
  assert.ok(dry.lines.every((l) => l.startsWith('(보기만) ')), dry.lines.join('\n'));
  assert.ok(!fs.existsSync(path.join(root, THIS_SECRETARY_FILE)), 'dry run writes nothing');
  assert.deepEqual(fs.readdirSync(path.join(root, 'scripts')).sort(), before);
  assert.deepEqual(dry.left, ['scripts/dashboard.local.json']);

  const now = new Date('2026-11-10T03:04:05Z');
  const r = mergeThisSecretaryFiles(root, { now });
  assert.deepEqual(r.left, ['scripts/dashboard.local.json'], 'what is not JSON stays');
  assert.deepEqual(readAllOf(root), {
    paths: { otherPcRoot: 'X:\\ai' },
    'mistake-guards': { levels: { english: 'warn' }, repeatLimit: 4 },
    'usage-poll': { providers: ['subscription'] },
    'phone-push': { url: 'http://127.0.0.1:2586', topic: 't' },
  });
  const backup = path.join(root, ...MERGE_BACKUP_DIR.split('/'), '20261110-120405', 'scripts');
  assert.ok(fs.existsSync(path.join(backup, 'mistake-guards.local.json')), 'the old file kept whole in the backup folder (KST time)');
  assert.equal(fs.readFileSync(path.join(backup, 'usage.local.json'), 'utf8').charCodeAt(0), 0xfeff, 'moved as it was');
  assert.ok(!fs.existsSync(path.join(root, 'scripts', 'usage.local.json')));
  assert.deepEqual(leftoverThisSecretaryFiles(root), ['scripts/dashboard.local.json']);
  assert.ok(r.lines.some((l) => /그대로 둠: scripts\/dashboard\.local\.json \(JSON으로 못 읽음/.test(l)), r.lines.join('\n'));
  assert.ok(r.lines.every((l) => !l.includes('X:\\ai') && !l.includes('subscription')), 'no values in the lines');

  // Again: nothing more moves.
  const again = mergeThisSecretaryFiles(root, { now });
  assert.deepEqual(again.left, ['scripts/dashboard.local.json']);
  assert.equal(again.lines.length, 1);

  // A file whose value differs from what is there now: left whole (its other parts too), nothing overwritten. The same
  // value: the old file moves beside the first one, not over it.
  old('dashboard.local.json', { port: 8123 });
  old('mistake-guards.local.json', { otherPcRoot: 'Y:\\other', levels: { english: 'warn' }, repeatLimit: 4 });
  old('usage.local.json', { providers: ['subscription'] });
  const plan = planThisSecretaryMerge(root);
  const states = Object.fromEntries(plan.items.map((i) => [i.file, [i.done, ...i.parts.map((p) => `${p.section}:${p.state}`)]]));
  assert.deepEqual(states, {
    'scripts/mistake-guards.local.json': [false, 'paths:differs', 'mistake-guards:same'],
    'scripts/usage.local.json': [true, 'usage-poll:same'],
    'scripts/dashboard.local.json': [true, 'dashboard:add'],
  });
  const third = mergeThisSecretaryFiles(root, { now });
  assert.deepEqual(third.left, ['scripts/mistake-guards.local.json']);
  assert.equal(readAllOf(root).paths.otherPcRoot, 'X:\\ai', 'what was there stays');
  assert.deepEqual(readAllOf(root).dashboard, { port: 8123 });
  assert.ok(fs.existsSync(path.join(backup, 'usage.local-2.json')));
  // A part that would be new is held while another part of the same file differs.
  fs.writeFileSync(path.join(root, THIS_SECRETARY_FILE), JSON.stringify({ paths: { otherPcRoot: 'X:\\ai' } }));
  assert.deepEqual(planThisSecretaryMerge(root).items[0].parts.map((p) => p.state), ['differs', 'held']);
  assert.deepEqual(mergeThisSecretaryFiles(root, { now }).left, ['scripts/mistake-guards.local.json']);
  assert.deepEqual(readAllOf(root), { paths: { otherPcRoot: 'X:\\ai' } }, 'the held part is not written');
});

test('this copy\'s own file is never merged or read under the test mark', () => {
  assert.deepEqual(planThisSecretaryMerge(PROJECT_ROOT), { items: [], write: { secretary: {}, shared: {} }, error: null });
  assert.deepEqual(leftoverThisSecretaryFiles(PROJECT_ROOT), []);
  assert.throws(() => writeThisSecretary('paths', {}, PROJECT_ROOT), /쓰지 않음/);
});
