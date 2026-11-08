import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { scriptPath } from '../src/core/paths.ts';
import { disabledItems, featureOn, itemNames, readFeatures, type Feature, type FeatureItem } from '../src/setup/features.ts';
import { activeNotices, PROMPT_NOTICES } from '../src/hooks/prompt-notices.ts';
import { activeChecks, CHECKS, checkSetup, saveReport, setupReminder, type SetupOptions } from '../src/setup/install-check.ts';

const features = readFeatures(PROJECT_ROOT)!;
const installTasks = scriptPath('installTasks');

/** The -Task names install-tasks.ps1 accepts (its ValidateSet). */
function taskNames(): string[] {
  const set = /ValidateSet\(([^)]*)\)\]\s*\[string\[\]\]\$Task/.exec(fs.readFileSync(installTasks, 'utf8'))?.[1] ?? '';
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
    for (const k of ['files', 'checks', 'notices', 'tasks', 'rules'] as const) assert.ok(Array.isArray(f[k]), `${f.id}.${k}`);
    if (f.core) assert.equal(f.enabled, undefined, `${f.id}: a core feature has no enabled`);
    else assert.equal(typeof f.enabled, 'boolean', `${f.id}: an optional feature says enabled`);
    if (f.originalOnly !== undefined) assert.ok(f.originalOnly === true && !f.core, `${f.id}: originalOnly is true on an optional feature, or absent`);
    assert.equal(f.originalOnly, undefined, `${f.id}: nothing is original-only in this release`);
  }
  assert.deepEqual(
    features.filter((f) => f.core).map((f) => f.id),
    ['memory', 'setup-check', 'update', 'board', 'consolidate', 'delegate', 'remote-server', 'backup', 'usage-guard'],
  );
  // Shipped on: the usage reader, the idle jobs, the browser and the mistake guards. Put in but off until the user turns them on (features skill).
  assert.deepEqual(features.filter((f) => !f.core && featureOn(f)).map((f) => f.id), ['usage-poll', 'idle-jobs', 'browser', 'guards']);
  assert.deepEqual(
    features.filter((f) => !featureOn(f)).map((f) => f.id),
    ['account-handoff', 'providers', 'calendar', 'notes', 'inbox', 'network-share', 'dashboard', 'notify'],
  );
});

// Without it: a feature lists a file that is not there (moved, renamed). Files a command makes per PC and git ignores are
// not listed: a fresh clone has none of them.
test('features.json: every listed file is there', () => {
  for (const f of features) {
    for (const p of f.files) {
      const full = path.join(PROJECT_ROOT, p);
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

test('features.json: check, notice and task names are the code’s own, each in exactly one feature', () => {
  const code: Record<FeatureItem, string[]> = {
    checks: CHECKS.map((c) => c.id),
    notices: PROMPT_NOTICES.map((n) => n.name),
    tasks: taskNames(),
  };
  assert.deepEqual(code.tasks, ['server', 'backup', 'idle-jobs', 'ntfy']);
  for (const kind of ['checks', 'notices', 'tasks'] as const) {
    for (const f of features) for (const name of itemNames(f, kind)) assert.ok(code[kind].includes(name), `${f.id}.${kind}: ${name} is not in the code`);
    for (const name of code[kind]) assert.deepEqual(owners(kind, name).length, 1, `${kind} ${name}: ${owners(kind, name).join(', ') || 'no feature'}`);
  }
});

test('features.json: a feature that is on has its rules in AGENTS.md; one that is off keeps them out, in its features skill reference', () => {
  const agents = fs.readFileSync(path.join(PROJECT_ROOT, 'AGENTS.md'), 'utf8');
  const ref = (id: string) => path.join(PROJECT_ROOT, '.agents', 'skills', 'features', 'references', `${id}.md`);
  for (const f of features) {
    for (const r of f.rules) {
      if (featureOn(f)) assert.ok(agents.includes(r), `${f.id}: "${r}" not in AGENTS.md`);
      else assert.ok(!agents.includes(r), `${f.id} is off but "${r}" is in AGENTS.md`);
    }
    if (f.core) continue;
    // Every optional feature says in its reference how to turn it on and off, and holds the rules it adds.
    assert.ok(fs.existsSync(ref(f.id)), `${f.id}: no features skill reference`);
    const text = fs.readFileSync(ref(f.id), 'utf8');
    for (const r of f.rules) assert.ok(text.includes(r), `${f.id}: "${r}" not in its reference`);
    assert.match(text, /## 끄는 순서/, f.id);
  }
});

test('a skill of a feature that is off is not called by the model until the feature is turned on', () => {
  for (const f of features.filter((x) => !x.core)) {
    for (const p of f.files.filter((x) => x.startsWith('.agents/skills/'))) {
      const head = fs.readFileSync(path.join(PROJECT_ROOT, p, 'SKILL.md'), 'utf8').split(/^---$/m)[1] ?? '';
      assert.equal(/^disable-model-invocation: true$/m.test(head), !featureOn(f), `${p} (${f.id} ${featureOn(f) ? 'on' : 'off'})`);
    }
  }
});

test('with everything on (or no file, or a broken one) nothing is skipped', () => {
  const allOn = tempDir();
  fs.writeFileSync(path.join(allOn, 'features.json'), JSON.stringify({ features: features.map((f) => (f.core ? f : { ...f, enabled: true })) }));
  assert.deepEqual(activeChecks(allOn), CHECKS);
  assert.deepEqual(activeNotices(allOn), PROMPT_NOTICES);
  // As shipped: the off features' items (the end notice server, other providers' key check, the account handoff line) are left out; the answer-check notices ship on.
  assert.deepEqual(CHECKS.filter((c) => !activeChecks(PROJECT_ROOT).includes(c)).map((c) => c.id), ['notify', 'provider-key']);
  assert.deepEqual(PROMPT_NOTICES.filter((n) => !activeNotices(PROJECT_ROOT).includes(n)).map((n) => n.name), ['usage']);
  const none = tempDir();
  assert.equal(readFeatures(none), null);
  assert.deepEqual(activeChecks(none), CHECKS);
  assert.deepEqual(activeNotices(none), PROMPT_NOTICES);
  const broken = tempDir();
  fs.writeFileSync(path.join(broken, 'features.json'), '{ not json');
  assert.deepEqual(activeChecks(broken), CHECKS);
  assert.equal(disabledItems('tasks', broken).size, 0);
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
    assert.deepEqual([...disabledItems('tasks', r)], itemNames(f, 'tasks'), f.id);
  }
});

test('a core feature stays on even if the file says enabled: false', () => {
  const root = tempDir();
  const list = features.map((f) => (f.core ? { ...f, enabled: false } : { ...f, enabled: true }));
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: list }));
  assert.ok(activeChecks(root).some((c) => c.id === 'db'));
  assert.ok(activeNotices(root).some((n) => n.name === 'memory'));
  assert.deepEqual(activeChecks(root), CHECKS);
  assert.deepEqual(activeNotices(root), PROMPT_NOTICES);
  assert.equal(disabledItems('tasks', root).size, 0);
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
    cacheFile: `${dbPath}.setup.json`,
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

test('install-tasks.ps1 skips the tasks of a turned-off feature', { skip: process.platform !== 'win32' }, () => {
  // A test install id and no registered tasks (the PC's own task scheduler is not read): names end with ' (TST1)'.
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'id'), 'tst1\n');
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{}');
  const run = (...args: string[]) =>
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installTasks, '-DryRun', '-IdFile', path.join(dir, 'id'), '-FakeTasksFile', path.join(dir, 'tasks.json'), ...args], { encoding: 'utf8' });
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
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT_ROOT, 'scripts', 'notify', 'install-ntfy.ps1'), '-DryRun', '-IdFile', path.join(dir, 'id'), '-FakeTasksFile', path.join(dir, 'tasks.json'), '-NtfyExe', exe, '-ConfigFile', yml, ...(args.includes('-FeaturesFile') ? [] : ['-FeaturesFile', on]), ...args], { encoding: 'utf8' });
  const out = run('-BaseUrl', 'https://pc.example.ts.net:8443');
  assert.match(out, /ntfy\.exe: .*\(없음/);
  assert.match(out, /server\.yml: .*\(만들 예정/);
  assert.match(out, /listen-http: "127\.0\.0\.1:2586"/);
  assert.match(out, /base-url: "https:\/\/pc\.example\.ts\.net:8443"/);
  assert.ok(out.includes(`[Secretary ntfy (TST1)] conhost.exe --headless "${exe}" serve --config "${yml}"`), out);
  assert.match(out, /trigger=MSFT_TaskLogonTrigger[^]*limit=PT0S[^]*run=Limited/);
  assert.match(out, /ntfy\.exe 없음[^]*건너뜀/);
  // A name of one's own; nothing was written.
  assert.match(run('-TaskName', 'My ntfy'), /\[My ntfy\] conhost\.exe/);
  assert.ok(!fs.existsSync(yml));
  // A turned-off feature notify: the task is skipped.
  const off = path.join(rootWithOff('notify'), 'features.json');
  assert.match(run('-FeaturesFile', off), /건너뜀: Secretary ntfy \(TST1\) - 꺼진 기능 'notify'/);
  // 없으면 놓치는 실수: 웹 푸시 개인 키가 화면(곧 대화 기록)에 찍히거나, web-push-file 경로의 역슬래시가 하나로 들어가 ntfy가 못 읽거나, 이미 있는 server.yml을 덮어쓴다.
  assert.match(run('-BaseUrl', 'https://pc.example.ts.net:8443', '-WebPush', '-WebPushEmail', 'admin@example.com'), /web-push-private-key: "<ntfy webpush keys/);
  const fakeNtfy = path.join(dir, 'ntfy.cmd');
  fs.writeFileSync(fakeNtfy, ['@echo off', 'echo web-push-public-key: PUBLICFAKE', 'echo web-push-private-key: PRIVATEFAKE', ''].join('\r\n'));
  // Not a dry run, with the feature off so no task is registered.
  const real = (...args: string[]) =>
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT_ROOT, 'scripts', 'notify', 'install-ntfy.ps1'), '-IdFile', path.join(dir, 'id'), '-FakeTasksFile', path.join(dir, 'tasks.json'), '-NtfyExe', fakeNtfy, '-ConfigFile', yml, '-FeaturesFile', off, ...args], { encoding: 'utf8' });
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
