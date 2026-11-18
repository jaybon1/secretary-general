import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { changedReleaseFiles, readReleaseFiles } from '../src/setup/release-files.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { scriptPath } from '../src/core/paths.ts';
import { featureOn, readFeatures, type Feature } from '../src/core/features.ts';
import { checkSetup, saveReport, setupReminder, type SetupOptions } from '../src/setup/setup-check.ts';
import { DOC_TESTS, patchedNames, pickTests } from './run-changed.ts';
import { testReach } from './import-graph.ts';
import { appendFailures, envRevision, failureLine, FAILURES_ENV, FAILURES_FILE, failuresFile, gitRevision, releaseRunEnv, runRecord } from './test-failures.ts';
import { ENV_DIR } from './env.ts';

const features = readFeatures(PROJECT_ROOT)!;
// Whether this folder's features.json is the one its release shipped (the hash in release-files.json; no list counts as
// shipped). The user turns features on and off (feature-toggle skill): only then the shipped on/off states are held to.
const shippedList = readReleaseFiles(PROJECT_ROOT);
const featuresAsShipped = !shippedList || !changedReleaseFiles(PROJECT_ROOT, shippedList).includes('features.json');
const installScheduledTasks = scriptPath('installScheduledTasks');

/** A features.json in a fresh folder: this release's list with the given features turned off (the rest as shipped). */
function rootWithOff(...off: string[]): string {
  const root = tempDir();
  const list = features.map((f) => (off.includes(f.id) ? { ...f, enabled: false } : f));
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: list }));
  return root;
}

// [늘 남김] 없으면 놓치는 실수: 기능 칸(enabled, core)이 틀린 features.json이 원본이나 배포판에 실린다.
// 다시 깨진 곳: 기능을 더하거나 고친 작업에서 배포판의 켬·끔 값이 features.json과 어긋나 배포판 시험에서 두 번 실패했다.
test('features.json: one entry per id, core ones always on, the optional ones on or off as this release ships them', () => {
  assert.ok(features?.length, 'features.json missing or unreadable');
  const ids = features.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const f of features) {
    assert.ok(f.description, f.id);
    for (const k of ['files', 'checks', 'notices', 'scheduledTasks', 'rules'] as const) assert.ok(Array.isArray(f[k]), `${f.id}.${k}`);
    if (f.core) assert.equal(f.enabled, undefined, `${f.id}: a core feature has no enabled`);
    else assert.equal(typeof f.enabled, 'boolean', `${f.id}: an optional feature says enabled`);
    if (f.originalOnly !== undefined) assert.ok(f.originalOnly === true && !f.core, `${f.id}: originalOnly is true on an optional feature, or absent`);
    assert.equal(f.originalOnly, undefined, `${f.id}: nothing is original-only in this release`);
  }
  assert.deepEqual(
    features.filter((f) => f.core).map((f) => f.id),
    ['memory-core', 'setup-check', 'secretary-update', 'session-continuity', 'memory-consolidation', 'delegate', 'remote-server', 'db-backup', 'usage-guard'],
  );
  // Shipped on: the usage reader, the idle jobs, the to-do summary, the browser, the common skills and the mistake guards. Put in but off until the user turns them on (feature-toggle skill).
  const ON = ['usage-poll', 'idle-jobs', 'todo-summary', 'browser', 'common-skills', 'mistake-guards'];
  const OFF = ['multi-subscription', 'external-providers', 'calendar', 'notes', 'inbox', 'network-share', 'dashboard', 'phone-push'];
  assert.deepEqual(features.filter((f) => !f.core).map((f) => f.id).sort(), [...ON, ...OFF].sort());
  // 없으면 놓치는 실수: 사용자가 기능을 켜거나 끈 폴더(올린 뒤의 npm test)에서 배포판이 낸 켜짐·꺼짐을 기대해 실패한다.
  if (featuresAsShipped) {
    assert.deepEqual(features.filter((f) => !f.core && featureOn(f)).map((f) => f.id), ON);
    assert.deepEqual(features.filter((f) => !featureOn(f)).map((f) => f.id), OFF);
  }
});

test('features.json: every file under bin, src, scripts, .agents/skills and test belongs to exactly one feature', (t) => {
  let tracked: string[];
  try {
    tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'bin', 'src', 'scripts', '.agents/skills', 'test'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).split(/\r?\n/).filter((f) => f && fs.existsSync(path.join(PROJECT_ROOT, f)));
  } catch {
    return t.skip('not a git checkout');
  }
  const owns = (f: Feature, file: string) => f.files.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
  for (const file of tracked) {
    const ids = features.filter((f) => owns(f, file)).map((f) => f.id);
    assert.equal(ids.length, 1, `${file}: ${ids.length ? ids.join(', ') : 'no feature'}`);
  }
});

// 없으면 놓치는 실수: npm run test:changed가 바뀐 기능의 테스트를 빠뜨리거나, 어느 기능에도 안 속한 파일이 바뀌었는데 전체를 돌리지 않는다.
test('test:changed picks the tests by kind of file changed and by what the tests import, and everything for shared code or a file no feature owns', () => {
  const list = [{ id: 'a', files: ['src/a/', 'scripts/a.ps1', 'test/a.test.ts', '.agents/skills/a/'] }, { id: 'b', files: ['src/b.ts'] }];
  const tests = (...changed: string[]) => pickTests(changed, list).tests.map((x) => x.replace(/^test\/|\.test\.ts$/g, ''));
  assert.deepEqual(tests('.agents/skills/a/SKILL.md', 'README.md'), DOC_TESTS.map((x) => x.replace(/^test\/|\.test\.ts$/g, '')));
  assert.deepEqual(tests('src/a/x.ts'), ['a', 'memory', 'ingest', 'mcp']);
  assert.deepEqual(tests('scripts/a.ps1'), ['a', 'memory', 'ingest', 'mcp', 'ps1-syntax']);
  assert.deepEqual(tests('src/b.ts'), ['memory', 'ingest', 'mcp'], 'a feature with no tests: the core ones');
  assert.ok(tests('AGENTS.md').includes('release-build/*'), 'AGENTS.md: the release copy too');
  assert.deepEqual(tests('release-src/x.py'), ['release-build', 'release-build/*']);
  assert.deepEqual(tests('test/a.test.ts'), ['a', 'release-build', 'release-build/*']);
  assert.ok(tests('features.json').includes('names'));
  assert.equal(pickTests(['src/a/x.ts'], list).all, null);
  for (const f of ['package.json', 'test/helpers.ts', 'src/nobody.ts']) assert.match(pickTests(['src/a/x.ts', f], list).all ?? '', new RegExp(f.replace('.', '\\.')), f);
  // 없으면 놓치는 실수: 공용 코드(src/core/, src/store/)를 고쳤는데 핵심 테스트 셋만 돌아, 그 코드에 기대는 다른 기능이 깨진 것을 놓친다.
  // memory-core의 나머지 파일(훅 입구, MCP 도구 등)은 전체가 아니라 그 기능의 테스트와 import하는 테스트로 고른다(2026-11-12 결정).
  const shared = [...list, { id: 'memory-core', files: ['src/core/', 'src/store/', 'src/cli.ts', 'test/m.test.ts'] }];
  for (const f of ['src/core/paths.ts', 'src/store/store.ts']) assert.match(pickTests(['src/a/x.ts', f], shared).all ?? '', /공용 코드/, f);
  assert.equal(pickTests(['src/a/x.ts', 'src/cli.ts'], shared).all, null);
  assert.deepEqual(pickTests(['src/cli.ts'], shared).tests.map((x) => x.replace(/^test\/|\.test\.ts$/g, '')), ['m', 'memory', 'ingest', 'mcp']);
  // 없으면 놓치는 실수: 다른 기능에 속한 테스트가 import하는 파일을 고쳤는데, 그 테스트가 빠진다(.ps1처럼 import에 안 보이는 것은 기능으로만).
  const imports = { 'test/c.test.ts': ['src/b.ts'], 'test/a.test.ts': ['src/a/x.ts'], 'test/gone.test.ts': ['src/b.ts'] };
  const withImports = (...changed: string[]) => pickTests(changed, list, (f) => f !== 'test/gone.test.ts', imports).tests.map((x) => x.replace(/^test\/|\.test\.ts$/g, ''));
  assert.deepEqual(withImports('src/b.ts'), ['c', 'memory', 'ingest', 'mcp'], 'a test of another feature that imports the file; a deleted one is left out');
  assert.deepEqual(withImports('src/a/x.ts'), ['a', 'memory', 'ingest', 'mcp'], 'its own test once');
  assert.deepEqual(withImports('scripts/a.ps1'), ['a', 'memory', 'ingest', 'mcp', 'ps1-syntax']);
  // 없으면 놓치는 실수: 배포판 패치가 고치는 원본 파일을 바꿨는데 배포판 시험이 빠져, 패치가 "맞는 곳 0개"로 깨진 것을 합치기 전에야 안다.
  const patched = (...changed: string[]) => pickTests(changed, list, () => true, {}, ['src/b.ts', 'who-and-brief.md']).tests.map((x) => x.replace(/^test\/|\.test\.ts$/g, ''));
  assert.deepEqual(patched('src/b.ts'), ['release-build', 'release-build/*', 'memory', 'ingest', 'mcp']);
  assert.ok(patched('.agents/skills/a/references/who-and-brief.md').includes('release-build/*'), 'a name the patch joins to its folder');
  assert.ok(!patched('src/a/x.ts').includes('release-build/*'));
  const realPatched = patchedNames();
  // The original's patches (a release has none: nothing to pick).
  if (realPatched.length) assert.ok(realPatched.includes('who-and-brief.md') && realPatched.some((n) => n.startsWith('src/')), 'read from the real patches');
  // The real test files: paths from the root, the test's own helpers left out, and what the imported files import in turn.
  const real = testReach();
  assert.ok(real['test/features.test.ts'].includes('src/core/features.ts'));
  assert.ok(real['test/memory.test.ts'].includes('src/hooks/session-start.ts'), 'a test of one feature importing a file of another');
  assert.ok(real['test/memory.test.ts'].includes('src/store/schema.ts'), 'reached through another file');
  assert.ok(Object.values(real).every((xs) => xs.every((x) => !x.startsWith('test/') && !x.startsWith('.'))));
});

// 없으면 놓치는 실수: 실패한 테스트가 기록(test-failures.jsonl)에 안 남아 임시 테스트를 줄일 근거가 없거나, 기록을 못 써서 테스트 실행이 깨진다.
test('test failures: a failed test is one record line (file, name, time, branch, commit), a suite or a passing one is none, and a record that cannot be written is passed over; from a worktree it is the original one', async () => {
  const root = tempDir();
  const fail = (data: object) => ({ type: 'test:fail', data: { name: 'the title', file: path.join(root, 'test', 'x.test.ts'), ...data } });
  const now = new Date('2026-11-12T01:02:03Z');
  const rev = { branch: 'fix-x', commit: 'abc1234' };
  assert.deepEqual(JSON.parse(failureLine(fail({}), root, now, rev)!), { at: '2026-11-12T01:02:03.000Z', branch: 'fix-x', commit: 'abc1234', file: 'test/x.test.ts', name: 'the title' });
  assert.equal(failureLine({ ...fail({}), type: 'test:pass' }, root), null);
  assert.equal(failureLine(fail({ details: { type: 'suite' } }), root), null);
  assert.equal(failureLine(fail({ details: { error: { failureType: 'subtestsFailed' } } }), root), null);
  const run = path.join(root, 'run.jsonl');
  const record = path.join(root, 'logs', FAILURES_FILE);
  fs.writeFileSync(run, '');
  assert.equal(appendFailures(run, record), 0);
  assert.equal(fs.existsSync(record), false, 'nothing failed: no record');
  fs.writeFileSync(run, '{"name":"a"}\n{"name":"b"}\n');
  assert.equal(appendFailures(run, record), 2);
  assert.equal(appendFailures(run, record), 2);
  assert.equal(fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).length, 4, 'added to, never written over');
  assert.equal(appendFailures(run, path.join(run, 'no', FAILURES_FILE)), 0, 'a record under a file: passed over');
  assert.equal(appendFailures(path.join(root, 'none.jsonl'), record), 0);
  // A run-tests.mjs started from a test writes into the test's own folder, not this PC's record.
  assert.equal(process.env[FAILURES_ENV]?.startsWith(ENV_DIR), true);
  // 없으면 놓치는 실수: 작업 사본(git worktree)에서 돌린 테스트의 실패가 번호 없는 ~/.secretary/logs에 쌓여, 줄일 때 보는 원본 기록에 없다(2026-11-12).
  const repo = path.join(root, 'original');
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'a');
  fs.writeFileSync(path.join(repo, '.secretary-id'), 'QKZB');
  const wt = path.join(root, 'wt');
  assert.equal(git(repo, 'worktree', 'add', '-q', wt).status, 0);
  const home = path.join(root, 'home');
  const want = path.join(home, 'QKZB', 'logs', FAILURES_FILE);
  assert.equal(await failuresFile({}, wt, home), want, "from a worktree: the original's id");
  assert.equal(await failuresFile({}, repo, home), want);
  assert.equal(await failuresFile({}, path.join(root, 'logs'), home), path.join(home, 'logs', FAILURES_FILE), 'no git, no id: as before');
  // 없으면 놓치는 실수: 실패 줄에 브랜치·커밋이 없어 작업 사본에서 고치는 도중의 실패와 main의 실패를 가르지 못한다(2026-11-12 결정).
  assert.deepEqual(gitRevision(wt), { branch: 'wt', commit: git(repo, 'rev-parse', '--short', 'HEAD').stdout.trim() });
  assert.deepEqual(gitRevision(path.join(root, 'logs')), { branch: '', commit: '' }, 'outside git: empty');
  // 없으면 놓치는 실수: 배포판 테스트(git 밖, 번호 없는 임시 폴더)의 실패가 번호 없는 ~/.secretary/logs에 브랜치·커밋 없이 쌓인다.
  const handed = await releaseRunEnv(wt, home);
  assert.equal(handed[FAILURES_ENV], want);
  const got = envRevision(handed)!;
  assert.deepEqual(got, { ...gitRevision(wt), from: 'release-build' });
  assert.equal(JSON.parse(failureLine(fail({}), root, now, got)!).from, 'release-build');
  assert.equal(envRevision({}), null);
  // 없으면 놓치는 실수: 오래 도는 시험(배포판 시험) 중에 작업 사본이 지워지거나 git이 답하지 않으면, 끝에서야 기록 자리와 브랜치를 정하는
  // run-tests.mjs가 그 실행의 실패를 번호 없는 ~/.secretary/logs에 브랜치·커밋 없이 적는다. 자리와 브랜치는 시험 전에 정한다(runRecord).
  const settled = await runRecord(wt, {}, home);
  assert.equal(settled.record, want);
  assert.deepEqual(envRevision(settled.env), gitRevision(wt));
  fs.rmSync(wt, { recursive: true, force: true });
  assert.equal(await failuresFile({}, wt, home), path.join(home, 'logs', FAILURES_FILE), 'read after the work copy went: the id-less folder');
  assert.deepEqual(gitRevision(wt), { branch: '', commit: '' });
  // The release test's handing (its record and its revision) is kept as it is.
  const inRelease = await runRecord(path.join(root, 'logs'), handed, home);
  assert.equal(inRelease.record, want);
  assert.deepEqual(envRevision(inRelease.env), got);
  const runner = fs.readFileSync(path.join(PROJECT_ROOT, 'test', 'run-tests.mjs'), 'utf8');
  assert.ok(runner.indexOf('runRecord(') > 0 && runner.indexOf('runRecord(') < runner.indexOf("'--test'"), 'run-tests.mjs settles the record before it starts the tests');
  assert.doesNotMatch(runner, /failuresFile\(/, 'and does not read it again at the end');
});

// [늘 남김] 없으면 놓치는 실수: 켠 기능의 규칙 글이 AGENTS.md에 없거나, 배포판에서 꺼 둔 기능의 규칙 글이 AGENTS.md에 남거나 feature-toggle 참고 파일에 빠진다.
// 다시 깨진 곳: 기능의 켬·끔을 바꾼 작업에서 배포판 시험(배포판 판 제목: a feature that is on has its rules in AGENTS.md)이 두 번 실패했다.
test('features.json: a feature that is on has its rules in AGENTS.md; one that is off keeps them out, in its features skill reference', () => {
  const agents = fs.readFileSync(path.join(PROJECT_ROOT, 'AGENTS.md'), 'utf8');
  const ref = (id: string) => path.join(PROJECT_ROOT, '.agents', 'skills', 'feature-toggle', 'references', `${id}.md`);
  for (const f of features) {
    for (const r of f.rules) {
      if (featureOn(f)) assert.ok(agents.includes(r), `${f.id}: "${r}" not in AGENTS.md`);
      else assert.ok(!agents.includes(r), `${f.id} is off but "${r}" is in AGENTS.md`);
    }
    if (f.core) continue;
    // Every optional feature says in its reference how to turn it on and off, and holds the rules it adds.
    assert.ok(fs.existsSync(ref(f.id)), `${f.id}: no feature-toggle skill reference`);
    const text = fs.readFileSync(ref(f.id), 'utf8');
    for (const r of f.rules) assert.ok(text.includes(r), `${f.id}: "${r}" not in its reference`);
    assert.match(text, /## 끄는 순서/, f.id);
  }
});

test('the install check skips a turned-off feature, and its kept result leaves the reminder', async () => {
  const root = rootWithOff('idle-jobs');
  const dbPath = path.join(root, 'test.db');
  fs.writeFileSync(dbPath, '');
  const queries: string[][] = [];
  const opts: Partial<SetupOptions> = {
    root,
    dbPath,
    modelPath: path.join(root, 'models'),
    keysDir: path.join(root, 'keys'),
    platform: 'win32',
    cacheFile: `${dbPath}.setup-check.json`,
    configDirs: [],
    probe: async (q) => (queries.push(q.tasks),{ tasks: Object.fromEntries(q.tasks.map((x) => [x, false])), procs: [] }),
  };
  const report = await checkSetup(opts);
  const ids = report.results.map((r) => r.id);
  assert.ok(!ids.includes('idle-jobs-task'));
  assert.ok(ids.includes('server-task'));
  assert.ok(!queries[0].some((t) => t.startsWith('Secretary Idle Jobs')), 'neither its new name nor its old one');
  // A result kept from before the feature was turned off no longer raises the reminder.
  saveReport({ checkedAt: '', ms: 0, results: [{ id: 'idle-jobs-task', scope: 'common', label: '쉬는 시간 작업 예약 작업', status: 'missing', fix: 'x' }] }, opts.cacheFile!);
  assert.equal(setupReminder(opts), '');
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features }));
  assert.match(setupReminder(opts), /쉬는 시간 작업 예약 작업/);
});
