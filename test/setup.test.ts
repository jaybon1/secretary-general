import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { ENTRY_POINTS, entryPath, entryText, LEGACY_SECRETARY_DIR_ENV, secretaryDirEnv, secretaryLogDir, scriptPath, type EntryName } from '../src/core/paths.ts';
import { LOG_FILE as NOTIFY_LOG_FILE } from '../src/notify/ntfy.ts';
import { baseTaskNames, offFeatureChecks, scheduledTaskNames } from '../src/setup/features.ts';
import { usageHookState } from '../src/setup/check-items.ts';
import { hookKind, ownerOf, scriptInCommand } from '../src/setup/other-copy.ts';
import { ensureInstallId, INSTALL_ID_ALPHABET, INSTALL_ID_FILE, newInstallId, readInstallId, taskNameWith } from '../src/setup/install-id.ts';
import { MODEL_FILES } from '../src/semantic/client.ts';
import { cutLink, fixSkillLinks } from '../src/setup/skill-links.ts';
import {
  CHECKS,
  checkSetup,
  taskNamesFor,
  formatReport,
  confirmKnown,
  parseProcs,
  readCache,
  saveReport,
  serverWindow,
  sessionSetup,
  setSkip,
  setupNotice,
  setupReminder,
  taskAnswer,
  tasklistImage,
  taskTargetFile,
  regValue,
  usageHookProblems,
  type Probe,
  type ProbeQuery,
  type Proc,
  type SetupOptions,
} from '../src/setup/install-check.ts';

const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** The fixture copy's install id, and its task names (features.json name + id) and old names (before the id). */
const FIXTURE_ID = 'AB12';
const OLD = baseTaskNames(PROJECT_ROOT);
const SERVER_TASK = taskNameWith(OLD.server, FIXTURE_ID);
const BACKUP_TASK = taskNameWith(OLD.backup, FIXTURE_ID);
const IDLE_TASK = taskNameWith(OLD['idle-jobs'], FIXTURE_ID);
/** The fixture copy's folder variable: SECRETARY_<id>_DIR. */
const SECRETARY_DIR_ENV = secretaryDirEnv(FIXTURE_ID);

function serverProc(root: string, extra = '', pid = 100, script = scriptPath('remoteServer', root)): Proc {
  return { pid, name: 'powershell.exe', exe: PS, cmd: `"${PS}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.win32.normalize(script)}"${extra}` };
}

/** A complete install in a temp folder, with a fake probe that finds both tasks and the server window. */
function fixture(probe?: Partial<Probe>) {
  const root = tempDir();
  fs.copyFileSync(path.join(PROJECT_ROOT, 'features.json'), path.join(root, 'features.json'));
  write(path.join(root, INSTALL_ID_FILE), `${FIXTURE_ID}\n`);
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { alpha: '1', '@scope/beta': '1' } }));
  write(path.join(root, 'node_modules', 'alpha', 'package.json'), '{}');
  write(path.join(root, 'node_modules', '@scope', 'beta', 'package.json'), '{}');
  // A skill in .agents/skills and its one link .claude/skills (a junction).
  write(path.join(root, '.agents', 'skills', 'delegate', 'SKILL.md'), '#');
  fixSkillLinks(root);
  write(scriptPath('providers', root), JSON.stringify({ default: 'subscription' }));
  // The bin entries and the scripts they run; a config folder whose settings call them.
  for (const name of Object.keys(ENTRY_POINTS) as EntryName[]) {
    write(entryPath(name, root), entryText(name));
    write(scriptPath(ENTRY_POINTS[name], root));
  }
  const configDir = path.join(root, 'claude-config');
  write(path.join(configDir, 'settings.json'), JSON.stringify(usageSettings(root)));
  const modelPath = path.join(root, 'models', 'm');
  for (const f of MODEL_FILES) write(path.join(modelPath, f), 'x');
  const dbPath = path.join(root, 'test.db');
  write(dbPath);
  const queries: ProbeQuery[] = [];
  const opts: Partial<SetupOptions> = {
    root,
    dbPath,
    modelPath,
    keysDir: path.join(root, 'keys'),
    platform: 'win32',
    cacheFile: `${dbPath}.setup.json`,
    configDirs: [configDir],
    probe: async (q) => {
      queries.push(q);
      const env = Object.fromEntries((q.env ?? []).map((n) => [n, n === SECRETARY_DIR_ENV ? root : '']));
      return { tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [serverProc(root)], env, ...probe };
    },
  };
  return { root, opts, queries, configDir };
}

/** User settings as scripts/usage/install-usage-guard.mjs writes them for this root (forward slashes). */
function usageSettings(root: string, entry = (n: EntryName) => entryPath(n, root).replace(/\\/g, '/')) {
  return {
    statusLine: { type: 'command', command: `node "${entry('usage-statusline.mjs')}"` },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${entry('usage-guard.mjs')}"`, timeout: 5 }] }] },
  };
}

const status = (r: { results: Array<{ id: string; status: string }> }) => Object.fromEntries(r.results.map((x) => [x.id, x.status]));

test('a complete install passes every item and injects nothing', async () => {
  const { opts, queries } = fixture();
  const report = await checkSetup(opts);
  assert.ok(report.results.every((r) => r.status === 'ok'), JSON.stringify(report.results));
  assert.equal(setupNotice(report.results), '');
  // Tasks and processes come from one probe call: each task by its name with the install id, and by its old name.
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].tasks.sort(), [BACKUP_TASK, IDLE_TASK, SERVER_TASK, OLD.backup, OLD['idle-jobs'], OLD.server].sort());
  assert.equal(SERVER_TASK, 'Secretary Remote Control (AB12)');
  saveReport(report, opts.cacheFile!);
  assert.equal(setupReminder(opts), '');
});

test('missing tasks raise the notice: items, fixes, the opening line and what the secretary does', async () => {
  const { opts } = fixture({ tasks: { [SERVER_TASK]: false, [BACKUP_TASK]: false, [IDLE_TASK]: false } });
  const report = await checkSetup(opts);
  assert.equal(status(report)['server-task'], 'missing');
  assert.equal(status(report)['backup-task'], 'missing');
  assert.equal(status(report)['idle-jobs-task'], 'missing');
  const notice = setupNotice(report.results);
  assert.match(notice, /^<secretary-setup>/);
  assert.match(notice, /<\/secretary-setup>$/);
  assert.match(notice, /\[server-task\] 비서 서버 자동 시작 예약 작업 → .*install-tasks\.ps1 -Task server/);
  assert.match(notice, /\[backup-task\] 매일 DB 백업 예약 작업 → .*install-tasks\.ps1 -Task backup/);
  assert.match(notice, /\[idle-jobs-task\] 쉬는 시간 작업 예약 작업[^\n]*→ .*install-tasks\.ps1 -Task idle-jobs/);
  assert.match(notice, /비서 할 일: 매 답 맨 위에 한 줄로 '아직 설치가 덜 됐어요: 비서 서버 자동 시작 예약 작업, 매일 DB 백업 예약 작업, 쉬는 시간 작업 예약 작업\(상황판 미리 갱신, 기억 정리\)\. "설치 이어서 해 줘"라고 하시면 도와드릴게요'/);
  assert.match(notice, /setup-check/);
  // The prompt hook's reminder reuses the kept check: one short line.
  saveReport(report, opts.cacheFile!);
  const reminder = setupReminder(opts);
  assert.match(reminder, /^<secretary-setup>이 답 맨 위 한 줄로 '아직 설치가 덜 됐어요: 비서 서버 자동 시작 예약 작업, 매일 DB 백업 예약 작업, 쉬는 시간 작업 예약 작업\(상황판 미리 갱신, 기억 정리\)\./);
  assert.equal(reminder.split('\n').length, 1);
});

test('only the main account server window counts as the server', () => {
  const root = 'C:\\secretary';
  assert.ok(serverWindow([serverProc(root)], root));
  assert.equal(serverWindow([serverProc(root, ' -Provider subscription-b')], root), undefined);
  assert.equal(serverWindow([serverProc('C:\\other-copy')], root), undefined);
  // Case and quoting as Windows reports them.
  assert.ok(serverWindow([{ ...serverProc(root), cmd: serverProc(root).cmd!.toUpperCase() }], root));
  // A window started before the script moved to scripts\server\ still counts; one deeper or in another copy does not.
  assert.ok(serverWindow([serverProc(root, '', 100, path.win32.join(root, 'scripts', 'remote-server.ps1'))], root));
  assert.equal(serverWindow([serverProc(root, '', 100, path.win32.join(root, 'scripts', 'a', 'b', 'remote-server.ps1'))], root), undefined);
  assert.equal(serverWindow([serverProc(root, '', 100, path.win32.join(root, 'scripts', 'server', 'remote-server.ps1.bak'))], root), undefined);
});

test('a server window for the second account only leaves the server missing', async () => {
  const { root, opts } = fixture();
  const report = await checkSetup({ ...opts, probe: async (q) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [serverProc(root, ' -Provider subscription-b')] }) });
  assert.equal(status(report)['server-running'], 'missing');
  assert.match(setupNotice(report.results), /비서 서버 실행 \(remote-server\.ps1 창이 없음\) → .*Start-ScheduledTask/);
});

test('failed queries leave items unknown: quiet alone, listed next to a missing item', async () => {
  const { opts } = fixture({ tasks: { [SERVER_TASK]: null, [BACKUP_TASK]: null }, procs: null });
  const report = await checkSetup(opts);
  assert.equal(status(report)['server-task'], 'unknown');
  assert.equal(status(report)['server-running'], 'unknown');
  assert.equal(setupNotice(report.results), '');
  const thrown = await checkSetup({ ...opts, probe: async () => Promise.reject(new Error('boom')) });
  assert.equal(status(thrown)['backup-task'], 'unknown');
  fs.rmSync(path.join(opts.root!, 'node_modules', 'alpha'), { recursive: true });
  const withMissing = setupNotice((await checkSetup({ ...opts })).results);
  assert.match(withMissing, /\[packages\] 패키지\(npm install\) \(alpha\)/);
  assert.match(withMissing, /확인 못 함: 비서 서버 자동 시작 예약 작업\(예약 작업 조회 실패\)/);
});

test('the reminder looks at files again, so a mid-session fix stops it at once', async () => {
  const { opts, root } = fixture();
  fs.rmSync(path.join(root, 'node_modules', '@scope'), { recursive: true });
  saveReport(await checkSetup(opts), opts.cacheFile!);
  assert.match(setupReminder(opts), /패키지\(npm install\)/);
  write(path.join(root, 'node_modules', '@scope', 'beta', 'package.json'), '{}');
  assert.equal(setupReminder(opts), '');
});

test('a file item that no longer applies drops out of the reminder', async () => {
  const { opts } = fixture();
  fs.rmSync(path.join(opts.modelPath!, 'config.json'));
  const embed = process.env.SECRETARY_EMBED;
  delete process.env.SECRETARY_EMBED;
  try {
    saveReport(await checkSetup(opts), opts.cacheFile!);
    assert.match(setupReminder(opts), /의미 검색 모델 파일/);
  } finally {
    process.env.SECRETARY_EMBED = embed;
  }
  assert.equal(setupReminder(opts), '');
});

test('no check kept yet means no reminder; a turned-off check says nothing', async () => {
  const { opts } = fixture({ tasks: { [SERVER_TASK]: false, [BACKUP_TASK]: true } });
  assert.equal(setupReminder(opts), '');
  process.env.SECRETARY_SETUP_CHECK = 'off';
  try {
    assert.deepEqual(await sessionSetup(opts), { notice: '', report: null });
  } finally {
    delete process.env.SECRETARY_SETUP_CHECK;
  }
  const { notice } = await sessionSetup(opts);
  assert.match(notice, /server-task/);
  // Every item but the model (semantic search is off in tests) and the provider key (feature 'providers' ships off).
  assert.deepEqual(
    readCache(opts.cacheFile!)?.results.map((r) => r.id),
    ['features', 'db', 'packages', 'skills', 'entry-points', 'secretary-dir', 'workspace-links', 'server-task', 'server-running', 'backup-task', 'idle-jobs-task', 'usage-hooks'],
  );
});

test('items the user goes without are left out and stay out across checks', async () => {
  const { opts } = fixture({ tasks: { [SERVER_TASK]: true, [BACKUP_TASK]: false } });
  saveReport(await checkSetup(opts), opts.cacheFile!);
  assert.deepEqual(setSkip(opts.cacheFile!, ['backup-task']), ['backup-task']);
  const { notice } = await sessionSetup(opts);
  assert.equal(notice, '');
  assert.equal(setupReminder(opts), '');
  assert.deepEqual(readCache(opts.cacheFile!)?.skip, ['backup-task']);
  assert.deepEqual(setSkip(opts.cacheFile!, ['all'], true), []);
  assert.match((await sessionSetup(opts)).notice, /backup-task/);
});

test('off Windows the task and process items do not apply and nothing is probed', async () => {
  const { opts, queries } = fixture();
  const report = await checkSetup({ ...opts, platform: 'linux' });
  assert.equal(queries.length, 0);
  const ids = report.results.map((r) => r.id);
  for (const id of ['server-task', 'server-running', 'backup-task', 'idle-jobs-task']) assert.ok(!ids.includes(id));
  assert.ok(ids.includes('packages'));
});

test('a database the hook had to create is told once; the next prompt sees it there', async () => {
  const { opts } = fixture();
  const report = await checkSetup({ ...opts, dbExisted: false });
  assert.equal(status(report).db, 'missing');
  assert.match(setupNotice(report.results), /처음 설치라면 정상/);
  saveReport(report, opts.cacheFile!);
  assert.equal(setupReminder(opts), '');
});

test('a missing or broken features.json is an item of its own, and everything stays on meanwhile', async () => {
  const { opts, root } = fixture();
  const file = path.join(root, 'features.json');
  for (const [text, detail] of [
    [null, /^features\.json 없음$/],
    ['{ not json', /^features\.json을 못 읽음\(/],
    ['{"about": "x"}', /^features\.json에 features 목록이 없음$/],
  ] as const) {
    if (text === null) fs.rmSync(file);
    else fs.writeFileSync(file, text);
    const report = await checkSetup(opts);
    const item = report.results.find((r) => r.id === 'features')!;
    assert.equal(item.status, 'missing');
    assert.match(item.detail!, detail);
    // The rest of the check still runs with every item on.
    assert.equal(status(report)['idle-jobs-task'], 'ok');
    assert.match(setupNotice(report.results), /\[features\] 기능 목록\(features\.json\) \(.*\) →.*git checkout -- features\.json/);
    saveReport(report, opts.cacheFile!);
    assert.match(setupReminder(opts), /기능 목록\(features\.json\)/);
  }
  fs.copyFileSync(path.join(PROJECT_ROOT, 'features.json'), file);
  assert.equal(setupReminder(opts), '', 'a fixed file stops the reminder at once');
});

test('skills: real folders in .agents/skills, .claude/skills one link to it, the old skills/ moved over, by one command', async () => {
  const { opts, root } = fixture();
  const item = async () => (await checkSetup(opts)).results.find((r) => r.id === 'skills')!;
  assert.equal((await item()).status, 'ok');
  cutLink(path.join(root, '.claude', 'skills'));
  write(path.join(root, 'skills', 'handoff', 'SKILL.md'), '#');
  let r = await item();
  assert.equal(r.status, 'missing');
  assert.equal(r.detail, '연결 없음: .claude/skills / 옛 자리에서 옮길 것: skills/handoff');
  assert.match(r.fix!, /^비서 폴더에서 `node src\/cli\.ts skill-links` \(먼저 보기만: `--dry-run`\)/);
  fixSkillLinks(root);
  assert.equal((await item()).status, 'ok');
  assert.equal(fs.readFileSync(path.join(root, '.claude', 'skills', 'handoff', 'SKILL.md'), 'utf8'), '#');
  // A real folder whose name is taken (the user's edit of an old copy): the command leaves it, the fix asks the user first.
  write(path.join(root, 'skills', 'delegate', 'SKILL.md'), '# mine');
  fixSkillLinks(root);
  r = await item();
  assert.equal(r.detail, '같은 이름이 이미 있어 옮기지 않음(지우지 않음): skills/delegate');
  assert.match(r.fix!, /^같은 이름이 이미 있어 옮기지 못한 실제 폴더는[^\n]*지우거나 합치지 않는다/);
  assert.equal(fs.readFileSync(path.join(root, 'skills', 'delegate', 'SKILL.md'), 'utf8'), '# mine');
});

test('model files are checked by name; the first automatic download is enough', async () => {
  const { opts } = fixture();
  fs.rmSync(path.join(opts.modelPath!, 'onnx'), { recursive: true });
  const embed = process.env.SECRETARY_EMBED;
  delete process.env.SECRETARY_EMBED;
  try {
    const report = await checkSetup(opts);
    const model = report.results.find((r) => r.id === 'model')!;
    assert.equal(model.status, 'missing');
    assert.equal(model.detail, 'onnx/model_quantized.onnx');
    // The first automatic download leaves out special_tokens_map.json; loading works without it.
    write(path.join(opts.modelPath!, 'onnx', 'model_quantized.onnx'), 'x');
    fs.rmSync(path.join(opts.modelPath!, 'special_tokens_map.json'));
    assert.equal((await checkSetup(opts)).results.find((r) => r.id === 'model')!.status, 'ok');
  } finally {
    process.env.SECRETARY_EMBED = embed;
  }
  // Semantic search turned off: the model is not needed.
  assert.ok(!(await checkSetup(opts)).results.some((r) => r.id === 'model'));
});

test('a PowerShell window whose command line could not be read leaves the server unknown, not missing', async () => {
  const { opts } = fixture();
  const hidden: Proc = { pid: 400, name: 'powershell.exe', exe: null, cmd: null };
  const report = await checkSetup({ ...opts, probe: async (q) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [hidden] }) });
  assert.equal(status(report)['server-running'], 'unknown');
  assert.equal(report.results.find((r) => r.id === 'server-running')!.detail, '명령줄을 못 읽은 PowerShell 창 1개(권한)');
  assert.equal(setupNotice(report.results), '');
});

test('feature providers turned on: the default provider needs its key file', async () => {
  const { opts, root } = fixture();
  const file = path.join(root, 'features.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of list.features) if (f.id === 'providers') f.enabled = true;
  fs.writeFileSync(file, JSON.stringify(list));
  assert.equal(status(await checkSetup(opts))['provider-key'], 'ok', 'the subscription needs no key');
  write(scriptPath('providers', root), JSON.stringify({ default: 'subscription-b' }));
  assert.equal(status(await checkSetup(opts))['provider-key'], 'missing');
  write(path.join(opts.keysDir!, 'subscription-b.env'), 'CLAUDE_CONFIG_DIR=x');
  assert.equal(status(await checkSetup(opts))['provider-key'], 'ok');
});
test('processes found last time are offered to the probe, and a reused list that falls short is checked afresh', async () => {
  const { opts, root } = fixture();
  const first = await checkSetup(opts);
  assert.deepEqual(first.procs?.map((p) => p.pid), [100]);
  saveReport(first, opts.cacheFile!);

  const queries: ProbeQuery[] = [];
  const probe = async (q: ProbeQuery): Promise<Probe> => {
    queries.push(q);
    const tasks = Object.fromEntries(q.tasks.map((t) => [t, true]));
    // The known window is "still alive" but the server now runs as another window: only a fresh list shows it.
    return q.known ? { tasks, procs: [], reused: true } : { tasks, procs: [serverProc(root, '', 300)] };
  };
  const second = await checkSetup({ ...opts, probe });
  assert.deepEqual(queries[0].known?.map((p) => p.pid), [100]);
  assert.equal(queries[1].known, undefined);
  assert.equal(status(second)['server-running'], 'ok');
  assert.deepEqual(second.procs?.map((p) => p.pid), [300]);

  // Nothing kept when a process item is not ok.
  const none = await checkSetup({ ...opts, probe: async (q) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [] }) });
  assert.equal(none.procs, undefined);
});

test('known processes stand only if each pid still runs under the same image name', async () => {
  const known: Proc[] = [serverProc('C:\\s'), { pid: 200, name: 'python.exe', exe: null, cmd: null }];
  const images: Record<number, string | null> = { 100: 'powershell.exe', 200: 'python.exe' };
  assert.equal(await confirmKnown(known, async (pid) => images[pid]), known);
  assert.equal(await confirmKnown(known, async (pid) => (pid === 200 ? 'notepad.exe' : images[pid])), null);
  assert.equal(await confirmKnown(known, async (pid) => (pid === 200 ? '' : images[pid])), null);
  assert.equal(await confirmKnown(known, async () => null), null);
});

test('tool output parsing: tasklist CSV and PowerShell JSON', () => {
  assert.equal(tasklistImage('"powershell.exe","7060","Console","1","19,416 K"\r\n', 7060), 'powershell.exe');
  assert.equal(tasklistImage('정보: 지정된 조건에 맞는 작업이 실행되고 있지 않습니다.\r\n', 7060), '');
  assert.equal(tasklistImage('"powershell.exe","17060","Console","1","19,416 K"', 7060), '');
  assert.deepEqual(parseProcs('{"pid":1,"name":"node.exe","exe":"C:\\\\n.exe","cmd":null}'), [{ pid: 1, name: 'node.exe', exe: 'C:\\n.exe', cmd: null }]);
  assert.equal(parseProcs('\uFEFF[]')?.length, 0);
  assert.equal(parseProcs('not json'), null);
});

test('an item is original-only when its feature says so in features.json; ids are unique', async () => {
  const ids = CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const { opts, root } = fixture();
  const scopes = async () => Object.fromEntries((await checkSetup(opts)).results.map((r) => [r.id, r.scope]));
  // Nothing is original-only in this release.
  for (const [id, scope] of Object.entries(await scopes())) assert.equal(scope, 'common', id);
  assert.match(formatReport(await checkSetup(opts), []), /✓ \[db\] 기억 DB\n/);
  // The mark still follows the file: a feature marked original-only gets it.
  const file = path.join(root, 'features.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of list.features) if (f.id === 'idle-jobs') f.originalOnly = true;
  fs.writeFileSync(file, JSON.stringify(list));
  assert.equal((await scopes())['idle-jobs-task'], 'original');
  assert.match(formatReport(await checkSetup(opts), []), /\[idle-jobs-task\] [^\n]*  · 원본 전용/);
});

test('a direct setup-check names the features turned off whose items it left out; the session notice does not', async () => {
  const { opts, root } = fixture({ tasks: { [SERVER_TASK]: false } });
  // As shipped, of the features turned off only 'providers' and 'notify' have an install check item.
  assert.deepEqual(offFeatureChecks(root), [{ id: 'providers', checks: ['provider-key'] }, { id: 'notify', checks: ['notify'] }]);
  const file = path.join(root, 'features.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of list.features) if (['providers', 'notify'].includes(f.id)) f.enabled = true;
  fs.writeFileSync(file, JSON.stringify(list));
  assert.doesNotMatch(formatReport(await checkSetup(opts), [], offFeatureChecks(root)), /꺼진 기능/);
  // Two features with an item each (idle-jobs, providers) and one without any (notes, not named).
  for (const f of list.features) if (['idle-jobs', 'providers', 'notes'].includes(f.id)) f.enabled = false;
  fs.writeFileSync(file, JSON.stringify(list));
  const off = offFeatureChecks(root);
  assert.deepEqual(off, [{ id: 'idle-jobs', checks: ['idle-jobs-task'] }, { id: 'providers', checks: ['provider-key'] }]);
  const report = await checkSetup(opts);
  const out = formatReport(report, [], off).split('\n');
  assert.equal(out.at(-1), '꺼진 기능: idle-jobs(점검 안 한 항목: idle-jobs-task), providers(점검 안 한 항목: provider-key) (켜려면 features.json에서 enabled를 true로)');
  assert.ok(!report.results.some((r) => r.id === 'idle-jobs-task' || r.id === 'provider-key'), 'their items were not checked');
  // The session-start notice (server task missing) says nothing about it.
  const { notice } = await sessionSetup(opts);
  assert.match(notice, /server-task/);
  assert.doesNotMatch(notice, /꺼진 기능|enabled/);
});

test('SECRETARY_<id>_DIR: registered for this folder is ok; unset or another folder is missing; a failed query stays quiet', async () => {
  const { opts, root } = fixture();
  assert.equal(SECRETARY_DIR_ENV, 'SECRETARY_AB12_DIR');
  const withEnv = (value: string | null | undefined, legacy = '') => ({
    ...opts,
    probe: async (q: ProbeQuery) => ({
      tasks: Object.fromEntries(q.tasks.map((t) => [t, true])),
      procs: [serverProc(root)],
      ...(value === undefined ? {} : { env: { [SECRETARY_DIR_ENV]: value, [LEGACY_SECRETARY_DIR_ENV]: legacy } }),
    }),
  });
  const item = async (value: string | null | undefined, legacy?: string) => (await checkSetup(withEnv(value, legacy))).results.find((r) => r.id === 'secretary-dir')!;
  assert.deepEqual([(await item(root)).status, (await item(root)).detail], ['ok', undefined]);
  // Same folder written another way (case, a trailing backslash) still counts.
  assert.equal((await item(root.toUpperCase() + '\\')).status, 'ok');
  assert.deepEqual([(await item('')).status, (await item('')).detail], ['missing', 'SECRETARY_AB12_DIR 등록 안 됨']);
  assert.match((await item('C:\\old-secretary')).detail!, /^SECRETARY_AB12_DIR이 다른 폴더를 가리킴: C:\\old-secretary$/);
  assert.equal((await item(null)).status, 'unknown');
  assert.equal((await item(undefined)).status, 'unknown');
  const notice = setupNotice((await checkSetup(withEnv(''))).results);
  assert.match(notice, /\[secretary-dir\] 비서 폴더 환경변수\(SECRETARY_<번호>_DIR\) \(SECRETARY_AB12_DIR 등록 안 됨\) → .*SetEnvironmentVariable\('SECRETARY_AB12_DIR', \(Get-Location\)\.Path, 'User'\)/);
  // The old name (before install ids) pointing here: the new one is still to register; once it is, the old one is a note.
  const onlyOld = await item('', root);
  assert.deepEqual([onlyOld.status, onlyOld.detail], ['missing', 'SECRETARY_AB12_DIR 등록 안 됨, 옛 이름 SECRETARY_DIR만 이 비서를 가리킴']);
  assert.match(onlyOld.fix!, /옛 이름 `SECRETARY_DIR`도 이 비서를 가리킨다: 그 이름을 읽는 바깥 도구를 새 이름으로 옮긴 뒤/);
  const both = await item(root, root);
  assert.deepEqual([both.status, both.detail], ['ok', '옛 이름 SECRETARY_DIR도 이 비서를 가리킴(그 이름을 읽는 바깥 도구를 SECRETARY_AB12_DIR으로 옮긴 뒤 지운다)']);
  // The old name holding another secretary: none of this copy's business.
  assert.deepEqual([(await item(root, 'C:\\other')).status, (await item(root, 'C:\\other')).detail], ['ok', undefined]);
  // The probe is asked for both names (once, alongside the tasks).
  const asked: ProbeQuery[] = [];
  await checkSetup({ ...opts, probe: async (q) => (asked.push(q), { tasks: {}, procs: [] }) });
  assert.deepEqual(asked[0].env, [SECRETARY_DIR_ENV, LEGACY_SECRETARY_DIR_ENV]);
  // Off Windows it is not asked for.
  assert.ok(!(await checkSetup({ ...opts, platform: 'linux' })).results.some((r) => r.id === 'secretary-dir'));
});

test('reg query output: the value, %VARS% expanded for REG_EXPAND_SZ, empty when absent', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    SECRETARY_DIR    REG_SZ    C:\\Users\\홍길동\\비서\r\n\r\n';
  assert.equal(regValue(out, 'SECRETARY_DIR'), 'C:\\Users\\홍길동\\비서');
  assert.equal(regValue(out, 'secretary_dir'), 'C:\\Users\\홍길동\\비서');
  assert.equal(regValue('\r\n    SECRETARY_DIR    REG_EXPAND_SZ    %HOME_X%\\s\r\n', 'SECRETARY_DIR', { HOME_X: 'D:\\h' }), 'D:\\h\\s');
  assert.equal(regValue('\r\n\r\n', 'SECRETARY_DIR'), '');
  assert.equal(regValue(out, 'SECRETARY_DIRX'), '');
});

test('bin entries: a missing entry or one whose script moved away is missing', async () => {
  const { opts, root } = fixture();
  fs.rmSync(entryPath('ego-grab.mjs', root));
  fs.rmSync(scriptPath('runJob', root));
  const item = (await checkSetup(opts)).results.find((r) => r.id === 'entry-points')!;
  assert.equal(item.status, 'missing');
  assert.equal(item.detail, 'bin/run-job.ps1의 scripts/run-job/run-job.ps1 없음, bin/ego-grab.mjs 없음');
  // A file item: the reminder sees a fix at once.
  saveReport(await checkSetup(opts), opts.cacheFile!);
  assert.match(setupReminder(opts), /바깥용 입구\(bin\/\)/);
  write(entryPath('ego-grab.mjs', root), entryText('ego-grab.mjs'));
  write(scriptPath('runJob', root));
  assert.equal(setupReminder(opts), '');
  // A copy without a feature (no script, no entry) is fine.
  fs.rmSync(entryPath('ego-grab.mjs', root));
  fs.rmSync(scriptPath('egoGrab', root));
  assert.equal((await checkSetup(opts)).results.find((r) => r.id === 'entry-points')!.status, 'ok');
});

test('usage hook and status line: each config folder must call this copy’s bin entries', async () => {
  const { opts, root, configDir } = fixture();
  const item = async () => (await checkSetup(opts)).results.find((r) => r.id === 'usage-hooks')!;
  assert.equal((await item()).status, 'ok');
  // Written with backslashes, in another case: still this copy's entries.
  const back = usageSettings(root, (n) => entryPath(n, root).toUpperCase());
  write(path.join(configDir, 'settings.json'), JSON.stringify(back));
  assert.equal((await item()).status, 'ok');
  // The old paths (the scripts folder before bin/).
  write(path.join(configDir, 'settings.json'), JSON.stringify(usageSettings(root, (n) => path.join(root, 'scripts', n).replace(/\\/g, '/'))));
  assert.deepEqual(usageHookProblems(configDir, root), ['상태줄이 옛 경로', '정지 훅이 옛 경로']);
  assert.equal((await item()).detail, `${configDir}: 상태줄이 옛 경로, 정지 훅이 옛 경로`);
  assert.match(setupNotice((await checkSetup(opts)).results), /\[usage-hooks\].*node scripts\/usage\/install-usage-guard\.mjs/);
  // Another program's status line, no guard; an empty folder; a folder that is not there is skipped.
  write(path.join(configDir, 'settings.json'), JSON.stringify({ statusLine: { command: 'other.exe' } }));
  assert.deepEqual(usageHookProblems(configDir, root), ['다른 상태줄', '정지 훅 없음']);
  assert.deepEqual(usageHookProblems(tempDir(), root), ['상태줄 없음', '정지 훅 없음']);
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(usageSettings(root)));
  assert.equal((await checkSetup({ ...opts, configDirs: [configDir, path.join(root, 'no-such-folder')] })).results.find((r) => r.id === 'usage-hooks')!.status, 'ok');
});

test('schtasks exit 1 is missing only with the plain "no such task" message', () => {
  const notFound = '오류: 지정된 파일을 찾을 수 없습니다.';
  const run = (code: number | string | null, stderr = '') => ({ code, stdout: '', stderr });
  assert.equal(taskAnswer(run(0), null), true);
  assert.equal(taskAnswer(run(1, `${notFound}\r\n`), notFound), false);
  // Access denied (or any other message) also exits 1: not known.
  assert.equal(taskAnswer(run(1, '오류: 액세스가 거부되었습니다.'), notFound), null);
  assert.equal(taskAnswer(run(1, notFound), null), null);
  assert.equal(taskAnswer(run(null), notFound), null);
  assert.equal(taskAnswer(run('ENOENT'), notFound), null);
});

test('the file a scheduled task runs, read from its XML', () => {
  const xml = (command: string, args?: string, dir?: string) =>
    `<?xml version="1.0" encoding="UTF-16"?>\r\n<Task><Actions Context="Author"><Exec><Command>${command}</Command>` +
    `${args === undefined ? '' : `<Arguments>${args}</Arguments>`}${dir ? `<WorkingDirectory>${dir}</WorkingDirectory>` : ''}</Exec></Actions></Task>`;
  // As install-tasks.ps1 registers them: behind conhost --headless, or powershell itself; a Korean folder stays whole.
  assert.equal(
    taskTargetFile(xml('conhost.exe', '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\홍길동\\비서\\bin\\idle-jobs.ps1"')),
    'C:\\Users\\홍길동\\비서\\bin\\idle-jobs.ps1',
  );
  assert.equal(taskTargetFile(xml('powershell.exe', '-NoProfile -WindowStyle Hidden -File C:\\s\\bin\\backup-db.ps1 -KeepDays 14')), 'C:\\s\\bin\\backup-db.ps1');
  assert.equal(taskTargetFile(xml('powershell.exe', '-File &quot;C:\\a &amp; b\\x.ps1&quot;')), 'C:\\a & b\\x.ps1');
  // Relative to the working folder; a program given by full path; nothing to go on.
  assert.equal(taskTargetFile(xml('powershell.exe', '-File bin\\x.ps1', 'C:\\s')), 'C:\\s\\bin\\x.ps1');
  assert.equal(taskTargetFile(xml('powershell.exe', '-File bin\\x.ps1')), null);
  assert.equal(taskTargetFile(xml('"C:\\Tools\\app.exe"', '--run')), 'C:\\Tools\\app.exe');
  assert.equal(taskTargetFile(xml('notepad.exe')), null);
  assert.equal(taskTargetFile('<Task></Task>'), null);
});

test('a task registered but pointing at a file that is gone is missing, with the path', async () => {
  const { opts, root } = fixture();
  const there = entryPath('backup-db.ps1', root);
  const gone = path.join(root, 'scripts', 'backup-db.ps1');
  const withFiles = (files: Record<string, string | null>) => ({
    ...opts,
    probe: async (q: ProbeQuery) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), taskFiles: files, procs: [serverProc(root)], env: { [SECRETARY_DIR_ENV]: root } }),
  });
  let report = await checkSetup(withFiles({ [BACKUP_TASK]: there, [IDLE_TASK]: null }));
  assert.equal(status(report)['backup-task'], 'ok');
  assert.equal(status(report)['idle-jobs-task'], 'ok', 'no file known: registered is enough');
  report = await checkSetup(withFiles({ [BACKUP_TASK]: gone }));
  const item = report.results.find((r) => r.id === 'backup-task')!;
  assert.equal(item.status, 'missing');
  assert.equal(item.detail, `등록됐지만 가리키는 파일 없음: ${gone}`);
  assert.match(setupNotice(report.results), /\[backup-task\][^\n]*-Task backup/);
});
/** Another secretary on this PC: a folder whose package.json is named "secretary", with its bin entries (and an install id when given). */
function otherSecretary(id?: string): string {
  const other = tempDir();
  write(path.join(other, 'package.json'), JSON.stringify({ name: 'secretary' }));
  if (id) write(path.join(other, INSTALL_ID_FILE), `${id}\n`);
  for (const name of ['usage-guard.mjs', 'usage-statusline.mjs', 'backup-db.ps1'] as EntryName[]) write(entryPath(name, other), entryText(name));
  return other;
}

test('whose a path is: inside this copy, under another secretary folder, or no one now (an old path of this copy)', () => {
  const root = tempDir();
  const other = otherSecretary();
  assert.deepEqual(ownerOf(path.join(root, 'scripts', 'usage-guard.mjs'), root), { whose: 'this' });
  assert.deepEqual(ownerOf(entryPath('usage-guard.mjs', other), root), { whose: 'other', folder: other });
  // Its file gone (that copy moved its scripts): still that copy's.
  assert.deepEqual(ownerOf(path.join(other, 'scripts', 'old.mjs'), root), { whose: 'other', folder: other });
  assert.deepEqual(ownerOf(path.join(tempDir(), 'gone', 'bin', 'usage-guard.mjs'), root), { whose: 'old' });
  assert.deepEqual(ownerOf('bin/usage-guard.mjs', root), { whose: 'other', folder: null });
  // A command line, quoted or not, %VARS% and $env: filled in.
  assert.equal(scriptInCommand('node "C:/a b/bin/usage-guard.mjs"', 'usage-guard.mjs'), 'C:/a b/bin/usage-guard.mjs');
  assert.equal(scriptInCommand('node C:\\s\\bin\\usage-guard.mjs --x', 'usage-guard.mjs'), 'C:\\s\\bin\\usage-guard.mjs');
  process.env.SECRETARY_TEST_X = 'D:\\x';
  try {
    assert.equal(scriptInCommand('node "%SECRETARY_TEST_X%\\bin\\usage-guard.mjs"', 'usage-guard.mjs'), 'D:\\x\\bin\\usage-guard.mjs');
    assert.equal(scriptInCommand('node "$env:SECRETARY_TEST_X\\bin\\usage-guard.mjs"', 'usage-guard.mjs'), 'D:\\x\\bin\\usage-guard.mjs');
  } finally {
    delete process.env.SECRETARY_TEST_X;
  }
  assert.equal(scriptInCommand('node other.mjs', 'usage-guard.mjs'), null);
  assert.deepEqual(hookKind(`node "${entryPath('usage-guard.mjs', root)}"`, 'usage-guard.mjs', root), { kind: 'this' });
  assert.deepEqual(hookKind(`node "${entryPath('usage-guard.mjs', other)}"`, 'usage-guard.mjs', root), { kind: 'other', folder: other });
  assert.deepEqual(hookKind(`node "${path.join(other, 'scripts', 'usage-guard.mjs')}"`, 'usage-guard.mjs', root), { kind: 'other-gone', folder: other });
});

test('usage hooks of another secretary on this PC are shared, not an old path; its broken ones are fixed from there', async () => {
  const { opts, root, configDir } = fixture();
  const other = otherSecretary();
  const item = async () => (await checkSetup(opts)).results.find((r) => r.id === 'usage-hooks')!;
  // That copy's entries, its files there: they do the job for the whole PC (usage is kept per PC).
  write(path.join(configDir, 'settings.json'), JSON.stringify(usageSettings(other)));
  assert.deepEqual(usageHookState(configDir, root), {
    problems: [],
    shared: [`상태줄은 다른 비서(${other}) 것을 함께 씀`, `정지 훅은 다른 비서(${other}) 것을 함께 씀`],
    otherGone: false,
  });
  assert.deepEqual([(await item()).status, (await item()).detail], ['ok', `${configDir}: 상태줄은 다른 비서(${other}) 것을 함께 씀, 정지 훅은 다른 비서(${other}) 것을 함께 씀`]);
  // That copy's old layout (its files gone): a problem, but fixed from that copy's folder.
  write(path.join(configDir, 'settings.json'), JSON.stringify(usageSettings(other, (n) => path.join(other, 'scripts', n).replace(/\\/g, '/'))));
  const broken = await item();
  assert.equal(broken.status, 'missing');
  assert.equal(broken.detail, `${configDir}: 상태줄이 다른 비서(${path.resolve(other)})의 없는 파일을 부름, 정지 훅이 다른 비서(${path.resolve(other)})의 없는 파일을 부름`);
  assert.match(broken.fix!, /그 비서 폴더에서 `node scripts\/usage\/install-usage-guard\.mjs`를 다시 돌리게/);
  // A folder no secretary is in any more (this copy moved from there): this copy's old path, the usual fix.
  const gone = path.join(tempDir(), 'moved-away');
  write(path.join(configDir, 'settings.json'), JSON.stringify(usageSettings(gone, (n) => path.join(gone, 'bin', n))));
  assert.deepEqual(usageHookProblems(configDir, root), ['상태줄이 옛 경로', '정지 훅이 옛 경로']);
  assert.match((await item()).fix!, /옛 경로로 등록된 것도/);
});

test('each secretary has its own SECRETARY_<id>_DIR: another secretary\'s variable is not asked about; this copy\'s pointing at its left-behind copy is fixed', async () => {
  const { opts, root } = fixture();
  const other = otherSecretary('CD34');
  const withEnv = (env: Record<string, string>) => ({ ...opts, probe: async (q: ProbeQuery) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [serverProc(root)], env: { [LEGACY_SECRETARY_DIR_ENV]: '', ...Object.fromEntries((q.env ?? []).map((n) => [n, env[n] ?? ''])) } }) });
  // The other secretary's own variable (SECRETARY_CD34_DIR) and the old shared name pointing at it: this copy only looks at its own.
  const asked: ProbeQuery[] = [];
  const report = await checkSetup({ ...withEnv({}), probe: async (q) => (asked.push(q), withEnv({ [SECRETARY_DIR_ENV]: root, SECRETARY_CD34_DIR: other, [LEGACY_SECRETARY_DIR_ENV]: other }).probe!(q)) });
  assert.ok(!asked[0].env!.includes('SECRETARY_CD34_DIR'));
  const item = report.results.find((r) => r.id === 'secretary-dir')!;
  assert.deepEqual([item.status, item.detail], ['ok', undefined]);
  assert.equal(setupNotice(report.results), '', 'nothing to fix: no notice');
  // The same secretary's left-behind copy (same install id): an old path of this copy, to point here.
  const copy = otherSecretary(FIXTURE_ID);
  const old = (await checkSetup(withEnv({ [SECRETARY_DIR_ENV]: copy }))).results.find((r) => r.id === 'secretary-dir')!;
  assert.deepEqual([old.status, old.detail], ['missing', `SECRETARY_AB12_DIR이 이 비서의 옛 사본(같은 고유 번호)을 가리킴: ${copy}`]);
  assert.match(old.fix!, /SetEnvironmentVariable\('SECRETARY_AB12_DIR'/);
});

test('a task under this copy\'s name (with its id) that runs another secretary\'s files is not re-registered without asking', async () => {
  const { opts, root } = fixture();
  const other = otherSecretary();
  const withFile = (file: string) => ({
    ...opts,
    probe: async (q: ProbeQuery) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), taskFiles: { [BACKUP_TASK]: file }, procs: [serverProc(root)], env: { [SECRETARY_DIR_ENV]: root } }),
  });
  const there = entryPath('backup-db.ps1', other);
  let item = (await checkSetup(withFile(there))).results.find((r) => r.id === 'backup-task')!;
  assert.equal(item.status, 'missing');
  assert.equal(item.detail, `다른 비서의 파일을 부름: ${there}`);
  assert.match(item.fix!, /-TakeOver/);
  assert.match(item.fix!, /setup-check --skip backup-task/);
  const gone = path.join(other, 'scripts', 'backup-db.ps1');
  item = (await checkSetup(withFile(gone))).results.find((r) => r.id === 'backup-task')!;
  assert.equal(item.detail, `다른 비서의 파일을 부름(가리키는 파일 없음): ${gone}`);
  // This copy's left-behind copy (same id): re-register here.
  const copy = otherSecretary(FIXTURE_ID);
  item = (await checkSetup(withFile(entryPath('backup-db.ps1', copy)))).results.find((r) => r.id === 'backup-task')!;
  assert.deepEqual([item.status, item.detail], ['missing', `이 비서의 옛 사본(같은 고유 번호)을 부름: ${entryPath('backup-db.ps1', copy)}`]);
  assert.match(item.fix!, /-Task backup/);
  // A folder no secretary is in any more: this copy's old task, re-registered as before.
  const moved = path.join(tempDir(), 'moved-away', 'bin', 'backup-db.ps1');
  item = (await checkSetup(withFile(moved))).results.find((r) => r.id === 'backup-task')!;
  assert.equal(item.detail, `등록됐지만 가리키는 파일 없음: ${moved}`);
  assert.match(item.fix!, /-Task backup/);
});

test('install-tasks.ps1 judges a registered task the same way (common.ps1 Get-OtherSecretary, Get-TaskTargetFile), install ids included', { skip: process.platform !== 'win32' }, () => {
  const root = tempDir();
  const other = otherSecretary();
  const common = path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1');
  const action = (file: string) => `[pscustomobject]@{ Execute = 'conhost.exe'; Arguments = '--headless powershell.exe -NoProfile -File "${file}"'; WorkingDirectory = '${root}' }`;
  const judge = (file: string, r = root) => `(Get-OtherSecretary (Get-TaskTargetFile (${action(file)})) '${r}')`;
  // With install ids: the same id is this copy's left-behind copy, another id another secretary. A file in lower case
  // (an earlier build) is the same id.
  const idRoot = tempDir();
  write(path.join(idRoot, INSTALL_ID_FILE), 'zz99\n');
  const sameId = otherSecretary('ZZ99');
  const otherId = otherSecretary('YY88');
  const lines = [
    `. '${common}'`,
    `"1=" + ${judge(entryPath('backup-db.ps1', other))}`,
    `"2=" + ${judge(path.join(other, 'scripts', 'gone.ps1'))}`,
    `"3=" + ${judge(entryPath('backup-db.ps1', root))}`,
    `"4=" + ${judge(path.join(tempDir(), 'gone', 'x.ps1'))}`,
    `"5=" + (Get-TaskTargetFile ([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = '-File bin\\x.ps1'; WorkingDirectory = 'C:\\s' }))`,
    `"6=" + ${judge(entryPath('backup-db.ps1', sameId), idRoot)}`,
    `"7=" + ${judge(entryPath('backup-db.ps1', otherId), idRoot)}`,
    // An id on one side only: the package.json name decides (another secretary).
    `"8=" + ${judge(entryPath('backup-db.ps1', other), idRoot)}`,
    `"9=" + ${judge(entryPath('backup-db.ps1', sameId))}`,
  ];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('; ')], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(out, [`1=${other}`, `2=${other}`, '3=', '4=', '5=C:\\s\\bin\\x.ps1', '6=', `7=${otherId}`, `8=${other}`, `9=${sameId}`]);
});

test('install id: made once (4 letters, no look-alikes), kept, read back; a broken file is replaced; task names carry it', () => {
  const root = tempDir();
  assert.equal(readInstallId(root), null);
  const first = ensureInstallId(root);
  assert.equal(first.created, true);
  assert.match(first.id!, /^[A-Z0-9]{4}$/);
  for (const ch of first.id!) assert.ok(INSTALL_ID_ALPHABET.includes(ch));
  assert.deepEqual(ensureInstallId(root), { id: first.id, created: false }, 'kept from then on');
  assert.equal(readInstallId(root), first.id);
  assert.equal(fs.readFileSync(path.join(root, INSTALL_ID_FILE), 'utf8'), `${first.id}\n`);
  // One shape everywhere: upper case. A hand-written or older one (lower case, BOM, CRLF) reads in upper case without
  // writing; making sure of the id writes it again as `<ID>\n`. One that is not an id is replaced.
  write(path.join(root, INSTALL_ID_FILE), '\uFEFFmy01\r\n');
  assert.equal(readInstallId(root), 'MY01');
  assert.equal(fs.readFileSync(path.join(root, INSTALL_ID_FILE), 'utf8'), '\uFEFFmy01\r\n', 'reading does not write');
  assert.deepEqual(ensureInstallId(root), { id: 'MY01', created: false });
  assert.equal(fs.readFileSync(path.join(root, INSTALL_ID_FILE), 'utf8'), 'MY01\n');
  write(path.join(root, INSTALL_ID_FILE), 'Not An Id!');
  assert.equal(readInstallId(root), null);
  assert.equal(ensureInstallId(root).created, true);
  // Ids differ from install to install (24 draws, all the same would be a broken generator).
  assert.ok(new Set(Array.from({ length: 24 }, newInstallId)).size > 1);
  // Task names: the features.json name and the id; the name alone without an id.
  assert.equal(taskNameWith('Secretary Idle Jobs', 'A3F9'), 'Secretary Idle Jobs (A3F9)');
  assert.equal(taskNameWith('Secretary Idle Jobs', 'a3f9'), 'Secretary Idle Jobs (A3F9)');
  assert.equal(taskNameWith('Secretary Idle Jobs', null), 'Secretary Idle Jobs');
  fs.copyFileSync(path.join(PROJECT_ROOT, 'features.json'), path.join(root, 'features.json'));
  // A lower-case file (an earlier build) gives the same upper-case names.
  write(path.join(root, INSTALL_ID_FILE), 'a3f9\n');
  const names = scheduledTaskNames(root);
  assert.equal(names.server, 'Secretary Remote Control (A3F9)');
  assert.equal(names.backup, 'Secretary DB Backup (A3F9)');
  assert.equal(names['idle-jobs'], 'Secretary Idle Jobs (A3F9)');
  assert.ok(Object.values(names).every((n) => n.endsWith(' (A3F9)')));
  assert.equal(taskNamesFor(root)['idle-jobs'], 'Secretary Idle Jobs (A3F9)');
});

// Without it: two secretaries on one PC append to one server, idle-job, end-notice and judge-call log and their lines mix.
test('each secretary logs under its own id (~/.secretary/logs/<id>, logs/ without one), the same on the PowerShell side', { skip: process.platform !== 'win32' }, () => {
  const root = tempDir();
  const home = tempDir();
  assert.equal(secretaryLogDir(root, home), path.join(home, 'logs'), 'no id yet: logs/ as before');
  write(path.join(root, INSTALL_ID_FILE), 'ab12\n');
  assert.equal(secretaryLogDir(root, home), path.join(home, 'logs', 'AB12'));
  assert.equal(NOTIFY_LOG_FILE, path.join(secretaryLogDir(), 'notify.log'));
  const profile = tempDir();
  const lib = (name: string) => path.join(PROJECT_ROOT, 'scripts', ...name.split('/'));
  const lines = [
    `. '${lib('lib/common.ps1')}'`,
    `. '${lib('server/server-lib.ps1')}'`,
    `"1=" + (Get-SecretaryLogDir '${root}')`,
    `"2=" + ((Get-ServerLogDir 'subscription-b') -eq (Join-Path (Get-SecretaryLogDir) 'server-b'))`,
    `"3=" + (Get-LegacyServerLogDir '')`,
  ];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('; ')], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: profile },
  });
  assert.deepEqual(out.trim().split(/\r?\n/), [
    `1=${path.join(profile, '.secretary', 'logs', 'AB12')}`,
    '2=True',
    `3=${path.join(profile, '.secretary', 'logs', 'server-a')}`,
  ]);
});

test('the install check makes the id on a first install and asks for the tasks by their new names', async () => {
  const { opts, root, queries } = fixture();
  fs.rmSync(path.join(root, INSTALL_ID_FILE));
  await checkSetup(opts);
  const id = readInstallId(root);
  assert.ok(id, 'made by the check');
  assert.ok(queries[0].tasks.includes(`Secretary DB Backup (${id})`));
  // The next check keeps it.
  await checkSetup(opts);
  assert.equal(readInstallId(root), id);
});

test('whose a path is with install ids: same id is this copy\'s left-behind copy; another id or none on one side is another secretary', () => {
  const root = tempDir();
  write(path.join(root, INSTALL_ID_FILE), 'AB12\n');
  const copy = otherSecretary('AB12');
  const other = otherSecretary('CD34');
  const noId = otherSecretary();
  assert.deepEqual(ownerOf(entryPath('usage-guard.mjs', copy), root), { whose: 'old', copy });
  assert.deepEqual(ownerOf(entryPath('usage-guard.mjs', other), root), { whose: 'other', folder: other });
  assert.deepEqual(ownerOf(entryPath('usage-guard.mjs', noId), root), { whose: 'other', folder: noId });
  // This copy without an id: the package.json name alone (as before ids).
  assert.deepEqual(ownerOf(entryPath('usage-guard.mjs', copy), tempDir()), { whose: 'other', folder: copy });
  // A folder known only by its id file is a secretary folder too (in lower case, from an earlier build: the same id).
  const idOnly = tempDir();
  write(path.join(idOnly, INSTALL_ID_FILE), 'ab12\n');
  assert.deepEqual(ownerOf(path.join(idOnly, 'bin', 'x.ps1'), root), { whose: 'old', copy: idOnly });
  // Usage hooks of the left-behind copy are this copy's old path (install-usage-guard.mjs points them here).
  assert.equal(hookKind(`node "${entryPath('usage-guard.mjs', copy)}"`, 'usage-guard.mjs', root).kind, 'old');
});

test('a task under its old name (before the id) that runs this copy is to move; another secretary\'s old-named task says nothing', async () => {
  const { opts, root } = fixture();
  const withTasks = (tasks: Record<string, boolean>, taskFiles: Record<string, string>) => ({
    ...opts,
    probe: async (q: ProbeQuery) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, tasks[t] ?? false])), taskFiles, procs: [serverProc(root)], env: { [SECRETARY_DIR_ENV]: root } }),
  });
  const item = async (o: Partial<SetupOptions>, id: string) => (await checkSetup(o)).results.find((r) => r.id === id)!;
  // Only the old name, running this copy's entry: missing, with the move.
  const mine = entryPath('backup-db.ps1', root);
  let backup = await item(withTasks({ [OLD.backup]: true }, { [OLD.backup]: mine }), 'backup-task');
  assert.equal(backup.status, 'missing');
  assert.equal(backup.detail, `옛 이름 'Secretary DB Backup'으로 등록됨: ${mine}`);
  assert.match(backup.fix!, /'Secretary DB Backup' → 'Secretary DB Backup \(AB12\)'/);
  assert.match(backup.fix!, /install-tasks\.ps1 -Task backup`가 새 이름으로 등록하고 이 비서의 옛 이름 작업을 지운다/);
  // The server's move needs an administrator PowerShell; an old folder of this copy (gone) counts as this copy's too.
  const moved = path.join(tempDir(), 'moved-away', 'bin', 'server-control.ps1');
  const server = await item(withTasks({ [OLD.server]: true }, { [OLD.server]: moved }), 'server-task');
  assert.equal(server.detail, `옛 이름 'Secretary Remote Control'으로 등록됨(가리키는 파일 없음): ${moved}`);
  assert.match(server.fix!, /-Task server`\(관리자 PowerShell에서\)/);
  // Both names: the old one still runs alongside.
  backup = await item(withTasks({ [OLD.backup]: true, [BACKUP_TASK]: true }, { [OLD.backup]: mine, [BACKUP_TASK]: mine }), 'backup-task');
  assert.deepEqual([backup.status, backup.detail], ['missing', `옛 이름 'Secretary DB Backup' 작업도 남아 있음: ${mine}`]);
  // Another secretary's old-named task: no alert of its own (names no longer clash), just this copy's own task.
  const other = otherSecretary('CD34');
  const theirs = entryPath('backup-db.ps1', other);
  backup = await item(withTasks({ [OLD.backup]: true, [BACKUP_TASK]: true }, { [OLD.backup]: theirs, [BACKUP_TASK]: mine }), 'backup-task');
  assert.equal(backup.status, 'ok');
  backup = await item(withTasks({ [OLD.backup]: true }, { [OLD.backup]: theirs }), 'backup-task');
  assert.deepEqual([backup.status, backup.detail], ['missing', undefined]);
  // An old-named task whose file can't be told is left alone too.
  backup = await item(withTasks({ [OLD.backup]: true, [BACKUP_TASK]: true }, {}), 'backup-task');
  assert.equal(backup.status, 'ok');
});

test('install-tasks.ps1 names tasks with the install id, makes the id when there is none, and moves this copy\'s old-named tasks (dry run)', { skip: process.platform !== 'win32' }, () => {
  const script = scriptPath('installTasks');
  const dir = tempDir();
  const idFile = path.join(dir, 'id.txt');
  const tasksFile = path.join(dir, 'tasks.json');
  const run = (tasks: object, ...args: string[]) => {
    fs.writeFileSync(tasksFile, JSON.stringify(tasks));
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-IdFile', idFile, '-FakeTasksFile', tasksFile, ...args], { encoding: 'utf8' });
  };
  // No id yet: made and said once; the names carry it.
  let out = run({}, '-Task', 'backup');
  const id = fs.readFileSync(idFile, 'utf8').trim();
  assert.match(id, /^[A-Z0-9]{4}$/);
  assert.match(out, new RegExp(`비서 고유 번호를 새로 만들었어요: ${id}`));
  assert.ok(out.includes(`[Secretary DB Backup (${id})]`));
  assert.doesNotMatch(out, /옮김/);
  out = run({}, '-Task', 'backup');
  assert.doesNotMatch(out, /새로 만들었어요/);
  assert.equal(fs.readFileSync(idFile, 'utf8').trim(), id, 'kept');
  // This copy's task under the old name: moved, keeping its time and its disabled state.
  const bin = path.join(PROJECT_ROOT, 'bin');
  const old = (file: string, extra: object = {}) => ({ execute: 'powershell.exe', arguments: `-NoProfile -File "${path.join(bin, file)}"`, workingDirectory: PROJECT_ROOT, ...extra });
  out = run({ 'Secretary DB Backup': old('backup-db.ps1', { startBoundary: '2026-01-01T03:00:00', state: 'Disabled' }), 'Secretary Idle Jobs': old('idle-jobs.ps1', { interval: 'PT10M' }) }, '-Task', 'backup');
  assert.ok(out.includes(`옮김(예정): 'Secretary DB Backup' → 'Secretary DB Backup (${id})' (옛 작업은 지움, 사용 안 함 상태 이어받음)`));
  const start = /start=(\S+)/.exec(out)?.[1];
  assert.equal(new Date(start!).getHours(), 3, `the old daily time (03:00 here), got ${start}`);
  // Several at once (-Command for a list): the idle jobs keep their interval.
  fs.writeFileSync(tasksFile, JSON.stringify({ 'Secretary Idle Jobs': old('idle-jobs.ps1', { interval: 'PT10M' }) }));
  out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script}' -Task idle-jobs,backup -DryRun -IdFile '${idFile}' -FakeTasksFile '${tasksFile}'`], { encoding: 'utf8' });
  assert.ok(out.includes(`옮김(예정): 'Secretary Idle Jobs' → 'Secretary Idle Jobs (${id})' (옛 작업은 지움)`));
  assert.match(out, /rep=PT10M/);
  // Another secretary's old-named task: left alone, nothing said; this copy's task is made as usual.
  const other = otherSecretary('CD34');
  out = run({ 'Secretary DB Backup': { execute: 'powershell.exe', arguments: `-File "${entryPath('backup-db.ps1', other)}"`, workingDirectory: other } }, '-Task', 'backup');
  assert.ok(out.includes(`[Secretary DB Backup (${id})]`));
  assert.doesNotMatch(out, /옮김|건너뜀/);
  // A task under this copy's new name that runs another secretary's files: skipped unless -TakeOver.
  out = run({ [`Secretary DB Backup (${id})`]: { execute: 'powershell.exe', arguments: `-File "${entryPath('backup-db.ps1', other)}"`, workingDirectory: other } }, '-Task', 'backup');
  assert.match(out, /건너뜀: Secretary DB Backup \([A-Z0-9]{4}\) - 이 비서 이름\(번호 포함\)의 작업이 이 PC의 다른 비서/);
  // An id file in lower case (an earlier build): names in upper case, the file written again so; a task registered
  // under the lower-case name is the same task (the task scheduler compares names in any case).
  fs.writeFileSync(idFile, 'ab12\r\n');
  out = run({ 'Secretary DB Backup (ab12)': { execute: 'powershell.exe', arguments: `-File "${entryPath('backup-db.ps1', other)}"`, workingDirectory: other } }, '-Task', 'backup');
  assert.equal(fs.readFileSync(idFile, 'utf8'), 'AB12\n');
  assert.match(out, /건너뜀: Secretary DB Backup \(AB12\) - 이 비서 이름\(번호 포함\)의 작업이 이 PC의 다른 비서/);
  assert.doesNotMatch(out, /새로 만들었어요/);
});

test('a release lists its files (release-files.json): one that is gone is missing; without the list the item does not apply', async () => {
  const { opts, root } = fixture();
  const ids = async () => (await checkSetup(opts)).results.map((r) => r.id);
  assert.ok(!(await ids()).includes('release-files'), 'the original has no list');
  write(path.join(root, 'release-files.json'), JSON.stringify({ version: 'v8', files: { 'features.json': 'x', 'AGENTS.md': 'y', 'src/gone.ts': 'z' } }));
  write(path.join(root, 'AGENTS.md'), '#');
  const item = (await checkSetup(opts)).results.find((r) => r.id === 'release-files')!;
  assert.equal(item.status, 'missing');
  assert.equal(item.detail, '빠진 비서 파일 1개: src/gone.ts');
  // A file item: a fix shows at once in the reminder; a changed file is not a problem here.
  saveReport(await checkSetup(opts), opts.cacheFile!);
  assert.match(setupReminder(opts), /배포판 파일\(release-files\.json\)/);
  write(path.join(root, 'src', 'gone.ts'), 'mine');
  assert.equal(setupReminder(opts), '');
  write(path.join(root, 'release-files.json'), '{');
  assert.equal((await checkSetup(opts)).results.find((r) => r.id === 'release-files')!.status, 'unknown');
});
