import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { changedReleaseFiles, readReleaseFiles } from '../src/setup/release-files.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { scriptPath } from '../src/core/paths.ts';
import { featureSkillPath, featureSkills, OFF_SKILLS_DIR, planFeatureSkills, fixFeatureSkills } from '../src/setup/feature-skills.ts';
import { disabledItems, featureOn, itemNames, readFeatures, type Feature, type FeatureItem } from '../src/core/features.ts';
import { activeNotices, PROMPT_NOTICES } from '../src/hooks/prompt-notices.ts';
import { activeChecks, CHECKS, checkSetup, saveReport, setupReminder, type SetupOptions } from '../src/setup/setup-check.ts';
import { DOC_TESTS, pickTests, testImports } from './run-changed.ts';
import { appendFailures, failureLine, FAILURES_ENV, FAILURES_FILE, failuresFile, gitRevision } from './test-failures.ts';
import { ENV_DIR } from './env.ts';

const features = readFeatures(PROJECT_ROOT)!;
// Whether this folder's features.json is the one its release shipped (the hash in release-files.json; no list counts as
// shipped). The user turns features on and off (feature-toggle skill): only then the shipped on/off states are held to.
const shippedList = readReleaseFiles(PROJECT_ROOT);
const featuresAsShipped = !shippedList || !changedReleaseFiles(PROJECT_ROOT, shippedList).includes('features.json');
const installScheduledTasks = scriptPath('installScheduledTasks');

/** The -Task names install-scheduled-tasks.ps1 accepts (its ValidateSet). */
function taskNames(): string[] {
  const set = /ValidateSet\(([^)]*)\)\]\s*\[string\[\]\]\$Task/.exec(fs.readFileSync(installScheduledTasks, 'utf8'))?.[1] ?? '';
  return [...set.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** A features.json in a fresh folder: this release's list with the given features turned off (the rest as shipped). */
function rootWithOff(...off: string[]): string {
  const root = tempDir();
  const list = features.map((f) => (off.includes(f.id) ? { ...f, enabled: false } : f));
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: list }));
  return root;
}

const owners = (kind: FeatureItem, name: string) => features.filter((f) => itemNames(f, kind).includes(name)).map((f) => f.id);

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
  // Shipped on: the usage reader, the idle jobs, the browser and the mistake guards. Put in but off until the user turns them on (feature-toggle skill).
  const ON = ['usage-poll', 'idle-jobs', 'browser', 'mistake-guards'];
  const OFF = ['multi-subscription', 'external-providers', 'calendar', 'notes', 'inbox', 'network-share', 'dashboard', 'phone-push'];
  assert.deepEqual(features.filter((f) => !f.core).map((f) => f.id).sort(), [...ON, ...OFF].sort());
  // 없으면 놓치는 실수: 사용자가 기능을 켜거나 끈 폴더(올린 뒤의 npm test)에서 배포판이 낸 켜짐·꺼짐을 기대해 실패한다.
  if (featuresAsShipped) {
    assert.deepEqual(features.filter((f) => !f.core && featureOn(f)).map((f) => f.id), ON);
    assert.deepEqual(features.filter((f) => !featureOn(f)).map((f) => f.id), OFF);
  }
});

// Without it: a feature lists a file that is not there (moved, renamed). Files a command makes per PC and git ignores are
// not listed: a fresh clone has none of them.
test('features.json: every listed file is there', () => {
  for (const f of features) {
    for (const p of f.files) {
      // An optional feature's skill sits in .agents/skills-off while the feature is off (setup/feature-skills.ts).
      const at = featureSkillPath(p, featureSkills(PROJECT_ROOT));
      const full = path.join(PROJECT_ROOT, at && p.endsWith('/') ? at.target : p);
      assert.ok(fs.existsSync(full), `${f.id}: ${p} missing`);
      assert.equal(fs.statSync(full).isDirectory(), p.endsWith('/'), `${f.id}: ${p} (folders end with /)`);
    }
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
  // The real test files: paths from the root, the test's own helpers left out.
  const real = testImports();
  assert.ok(real['test/features.test.ts'].includes('src/core/features.ts'));
  assert.ok(real['test/memory.test.ts'].includes('src/hooks/session-start.ts'), 'a test of one feature importing a file of another');
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
});

test('features.json: check, notice and task names are the code’s own, each in exactly one feature', () => {
  const code: Record<FeatureItem, string[]> = {
    checks: CHECKS.map((c) => c.id),
    notices: PROMPT_NOTICES.map((n) => n.name),
    scheduledTasks: taskNames(),
  };
  for (const kind of ['checks', 'notices', 'scheduledTasks'] as const) {
    for (const f of features) for (const name of itemNames(f, kind)) assert.ok(code[kind].includes(name), `${f.id}.${kind}: ${name} is not in the code`);
    for (const name of code[kind]) assert.deepEqual(owners(kind, name).length, 1, `${kind} ${name}: ${owners(kind, name).join(', ') || 'no feature'}`);
  }
});

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

test('with everything on (or no file, or a broken one) nothing is skipped', () => {
  const allOn = tempDir();
  fs.writeFileSync(path.join(allOn, 'features.json'), JSON.stringify({ features: features.map((f) => (f.core ? f : { ...f, enabled: true })) }));
  assert.deepEqual(activeChecks(allOn), CHECKS);
  assert.deepEqual(activeNotices(allOn), PROMPT_NOTICES);
  // As shipped: the off features' items (the end notice server, other providers' key check, the account handoff line) are left out; the answer-check notices ship on.
  if (featuresAsShipped) {
    assert.deepEqual(CHECKS.filter((c) => !activeChecks(PROJECT_ROOT).includes(c)).map((c) => c.id), ['phone-push', 'provider-key']);
    assert.deepEqual(PROMPT_NOTICES.filter((n) => !activeNotices(PROJECT_ROOT).includes(n)).map((n) => n.name), ['subscription-routing']);
  }
  const none = tempDir();
  assert.equal(readFeatures(none), null);
  assert.deepEqual(activeChecks(none), CHECKS);
  assert.deepEqual(activeNotices(none), PROMPT_NOTICES);
  const broken = tempDir();
  fs.writeFileSync(path.join(broken, 'features.json'), '{ not json');
  assert.deepEqual(activeChecks(broken), CHECKS);
  assert.equal(disabledItems('scheduledTasks', broken).size, 0);
});

test('turning a feature off drops its checks and notices, and only those', () => {
  // Each optional feature, one at a time with every other one on: exactly its own items go.
  const onBut = (id: string) => {
    const r = tempDir();
    fs.writeFileSync(path.join(r, 'features.json'), JSON.stringify({ features: features.map((f) => (f.core ? f : { ...f, enabled: f.id !== id })) }));
    return r;
  };
  for (const f of features.filter((x) => !x.core)) {
    const r = onBut(f.id);
    assert.deepEqual(CHECKS.filter((c) => !activeChecks(r).includes(c)).map((c) => c.id), f.checks, f.id);
    assert.deepEqual(PROMPT_NOTICES.filter((n) => !activeNotices(r).includes(n)).map((n) => n.name), f.notices, f.id);
    assert.deepEqual([...disabledItems('scheduledTasks', r)], itemNames(f, 'scheduledTasks'), f.id);
  }
});

test('a core feature stays on even if the file says enabled: false', () => {
  const root = tempDir();
  const list = features.map((f) => (f.core ? { ...f, enabled: false } : { ...f, enabled: true }));
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: list }));
  assert.ok(activeChecks(root).some((c) => c.id === 'db'));
  assert.ok(activeNotices(root).some((n) => n.name === 'memory-core'));
  assert.deepEqual(activeChecks(root), CHECKS);
  assert.deepEqual(activeNotices(root), PROMPT_NOTICES);
  assert.equal(disabledItems('scheduledTasks', root).size, 0);
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

test('install-scheduled-tasks.ps1 skips the tasks of a turned-off feature', { skip: process.platform !== 'win32' }, () => {
  // A test secretary id and no registered tasks (the PC's own task scheduler is not read): names end with ' (TST1)'.
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'id'), 'tst1\n');
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{}');
  const run = (...args: string[]) =>
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installScheduledTasks, '-DryRun', '-IdFile', path.join(dir, 'id'), '-FakeTasksFile', path.join(dir, 'tasks.json'), ...args], { encoding: 'utf8' });
  const all = run();
  for (const name of ['Secretary Remote Control', 'Secretary DB Backup', 'Secretary Idle Jobs']) assert.ok(all.includes(`[${name} (TST1)]`), name);
  assert.doesNotMatch(all, /건너뜀/);
  assert.doesNotMatch(all, /Secretary ntfy/, 'the ntfy server task only when asked for');
  const file = path.join(rootWithOff('idle-jobs'), 'features.json');
  const some = run('-FeaturesFile', file);
  assert.ok(some.includes('[Secretary Remote Control (TST1)]'));
  assert.ok(some.includes('[Secretary DB Backup (TST1)]'));
  assert.doesNotMatch(some, /\[Secretary Idle Jobs/);
  // Asked for by name, still skipped, and the one line says which feature is off and how to turn it on.
  const named = run('-Task', 'idle-jobs', '-FeaturesFile', file).trim();
  assert.equal(
    named,
    "건너뜀: Secretary Idle Jobs (TST1) - 꺼진 기능 'idle-jobs'의 작업이라 등록하지 않았어요. 켜려면 features.json에서 'idle-jobs'의 \"enabled\"를 true로 고친 뒤 이 명령을 다시 돌리세요.",
  );
});

test('install-ntfy.ps1: a server.yml in the user folder (web push keys written only there, an existing one left as it is), and a log-on task that runs ntfy serve without a window or admin', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'id'), 'tst1\n');
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{}');
  const exe = path.join(dir, 'bin', 'ntfy.exe');
  const yml = path.join(dir, 'cfg', 'server.yml');
  // The feature on (it may ship off): every optional feature on.
  const on = path.join(tempDir(), 'features.json');
  fs.writeFileSync(on, JSON.stringify({ features: features.map((f) => (f.core ? f : { ...f, enabled: true })) }));
  const run = (...args: string[]) =>
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT_ROOT, 'scripts', 'phone-push', 'install-ntfy.ps1'), '-DryRun', '-IdFile', path.join(dir, 'id'), '-FakeTasksFile', path.join(dir, 'tasks.json'), '-NtfyExe', exe, '-ConfigFile', yml, ...(args.includes('-FeaturesFile') ? [] : ['-FeaturesFile', on]), ...args], { encoding: 'utf8' });
  const out = run('-BaseUrl', 'https://pc.example.ts.net:8443');
  assert.match(out, /ntfy\.exe: .*\(없음/);
  assert.match(out, /server\.yml: .*\(만들 예정/);
  assert.match(out, /listen-http: "127\.0\.0\.1:2586"/);
  assert.match(out, /base-url: "https:\/\/pc\.example\.ts\.net:8443"/);
  assert.ok(out.includes(`[Secretary ntfy Server (TST1)] conhost.exe --headless "${exe}" serve --config "${yml}"`), out);
  assert.match(out, /trigger=MSFT_TaskLogonTrigger[^]*limit=PT0S[^]*run=Limited/);
  assert.match(out, /ntfy\.exe 없음[^]*건너뜀/);
  // A name of one's own; nothing was written.
  assert.match(run('-TaskName', 'My ntfy'), /\[My ntfy\] conhost\.exe/);
  assert.ok(!fs.existsSync(yml));
  // A turned-off feature notify: the task is skipped.
  const off = path.join(rootWithOff('phone-push'), 'features.json');
  assert.match(run('-FeaturesFile', off), /건너뜀: Secretary ntfy Server \(TST1\) - 꺼진 기능 'phone-push'/);
  // 없으면 놓치는 실수: 웹 푸시 개인 키가 화면(곧 대화 기록)에 찍히거나, web-push-file 경로의 역슬래시가 하나로 들어가 ntfy가 못 읽거나, 이미 있는 server.yml을 덮어쓴다.
  assert.match(run('-BaseUrl', 'https://pc.example.ts.net:8443', '-WebPush', '-WebPushEmail', 'admin@example.com'), /web-push-private-key: "<ntfy webpush keys/);
  const fakeNtfy = path.join(dir, 'ntfy.cmd');
  fs.writeFileSync(fakeNtfy, ['@echo off', 'echo web-push-public-key: PUBLICFAKE', 'echo web-push-private-key: PRIVATEFAKE', ''].join('\r\n'));
  // Not a dry run, with the feature off so no task is registered.
  const real = (...args: string[]) =>
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT_ROOT, 'scripts', 'phone-push', 'install-ntfy.ps1'), '-IdFile', path.join(dir, 'id'), '-FakeTasksFile', path.join(dir, 'tasks.json'), '-NtfyExe', fakeNtfy, '-ConfigFile', yml, '-FeaturesFile', off, ...args], { encoding: 'utf8' });
  const made = real('-BaseUrl', 'https://pc.example.ts.net:8443', '-WebPush', '-WebPushEmail', 'admin@example.com');
  assert.ok(!made.includes('PRIVATEFAKE'), made);
  const yaml = fs.readFileSync(yml, 'utf8');
  assert.match(yaml, /^web-push-public-key: "PUBLICFAKE"$/m);
  assert.match(yaml, /^web-push-private-key: "PRIVATEFAKE"$/m);
  assert.ok(yaml.includes(`web-push-file: "${path.join(path.dirname(yml), 'webpush.db').replace(/\\/g, '\\\\')}"`), yaml);
  assert.match(yaml, /^web-push-email-address: "admin@example\.com"$/m);
  fs.writeFileSync(yml, 'listen-http: "127.0.0.1:2586"\n');
  assert.match(real('-WebPush'), /web-push 줄이 없어요/);
  assert.equal(fs.readFileSync(yml, 'utf8'), 'listen-http: "127.0.0.1:2586"\n');
});

// Without it: a feature turned off keeps its skill where the CLIs read it (the model calls it by itself), or turning it
// on leaves it out of their reach; or the move loses what the user changed in the skill.
test('an optional feature skill lives in .agents/skills while on and in .agents/skills-off while off; the folder moves whole', () => {
  for (const s of featureSkills(PROJECT_ROOT)) {
    const on = fs.existsSync(path.join(PROJECT_ROOT, '.agents', 'skills', s.name, 'SKILL.md'));
    const off = fs.existsSync(path.join(PROJECT_ROOT, ...OFF_SKILLS_DIR.split('/'), s.name, 'SKILL.md'));
    assert.deepEqual([on, off], [s.on, !s.on], `${s.name} (${s.feature} ${s.on ? 'on' : 'off'})`);
  }
  const root = tempDir();
  const list = (enabled: boolean) => fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: [{ id: 'cal', enabled, files: ['.agents/skills/cal/'] }, { id: 'core', core: true, files: ['.agents/skills/c/'] }] }));
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'cal', 'references'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'cal', 'SKILL.md'), '사용자가 고친 스킬\n');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'cal', 'references', 'mine.md'), '사용자가 더한 파일\n');
  list(true);
  assert.deepEqual(planFeatureSkills(root), { move: [], both: [] });
  list(false);
  assert.deepEqual(fixFeatureSkills(root, true).plan.move.map((m) => m.to), ['.agents/skills-off/cal'], 'dry run');
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills', 'cal')));
  fixFeatureSkills(root);
  assert.ok(!fs.existsSync(path.join(root, '.agents', 'skills', 'cal')));
  assert.equal(fs.readFileSync(path.join(root, '.agents', 'skills-off', 'cal', 'references', 'mine.md'), 'utf8'), '사용자가 더한 파일\n');
  list(true);
  fixFeatureSkills(root);
  assert.equal(fs.readFileSync(path.join(root, '.agents', 'skills', 'cal', 'SKILL.md'), 'utf8'), '사용자가 고친 스킬\n', 'back with the change');
  // Both places taken: nothing moves.
  fs.mkdirSync(path.join(root, '.agents', 'skills-off', 'cal'), { recursive: true });
  const both = fixFeatureSkills(root).plan;
  assert.deepEqual([both.move, both.both.map((b) => b.at)], [[], ['.agents/skills/cal']]);
  // The update's view of a release path: by the user's state, in either spelling.
  assert.deepEqual(featureSkillPath('.agents/skills-off/cal/SKILL.md', [{ name: 'cal', on: true }]), { logical: '.agents/skills/cal/SKILL.md', target: '.agents/skills/cal/SKILL.md', other: '.agents/skills-off/cal/SKILL.md' });
  assert.equal(featureSkillPath('.agents/skills/cal/SKILL.md', [{ name: 'cal', on: false }])?.target, '.agents/skills-off/cal/SKILL.md');
  assert.equal(featureSkillPath('.agents/skills/delegate/SKILL.md', [{ name: 'cal', on: false }]), null);
});