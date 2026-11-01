import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { MODEL_FILES } from '../src/semantic.ts';
import {
  BACKUP_TASK,
  CHECKS,
  SERVER_TASK,
  checkSetup,
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
  type Probe,
  type ProbeQuery,
  type Proc,
  type SetupOptions,
} from '../src/setup.ts';

const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function serverProc(root: string, extra = '', pid = 100): Proc {
  return { pid, name: 'powershell.exe', exe: PS, cmd: `"${PS}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.win32.join(root, 'scripts', 'remote-server.ps1')}"${extra}` };
}

/** A complete install in a temp folder, with a fake probe that finds both tasks and the server window. */
function fixture(probe?: Partial<Probe>) {
  const root = tempDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { alpha: '1', '@scope/beta': '1' } }));
  write(path.join(root, 'node_modules', 'alpha', 'package.json'), '{}');
  write(path.join(root, 'node_modules', '@scope', 'beta', 'package.json'), '{}');
  const modelPath = path.join(root, 'models', 'm');
  for (const f of MODEL_FILES) write(path.join(modelPath, f), 'x');
  const dbPath = path.join(root, 'test.db');
  write(dbPath);
  const queries: ProbeQuery[] = [];
  const opts: Partial<SetupOptions> = {
    root,
    dbPath,
    modelPath,
    platform: 'win32',
    cacheFile: `${dbPath}.setup.json`,
    probe: async (q) => {
      queries.push(q);
      return { tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [serverProc(root)], ...probe };
    },
  };
  return { root, opts, queries };
}

const status = (r: { results: Array<{ id: string; status: string }> }) => Object.fromEntries(r.results.map((x) => [x.id, x.status]));

test('a complete install passes every item and injects nothing', async () => {
  const { opts, queries } = fixture();
  const report = await checkSetup(opts);
  assert.ok(report.results.every((r) => r.status === 'ok'), JSON.stringify(report.results));
  assert.equal(setupNotice(report.results), '');
  // Tasks and processes come from one probe call.
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].tasks.sort(), [BACKUP_TASK, SERVER_TASK].sort());
  saveReport(report, opts.cacheFile!);
  assert.equal(setupReminder(opts), '');
});

test('missing tasks raise the notice: items, fixes, the opening line and what the secretary does', async () => {
  const { opts } = fixture({ tasks: { [SERVER_TASK]: false, [BACKUP_TASK]: false } });
  const report = await checkSetup(opts);
  assert.equal(status(report)['server-task'], 'missing');
  assert.equal(status(report)['backup-task'], 'missing');
  const notice = setupNotice(report.results);
  assert.match(notice, /^<secretary-setup>/);
  assert.match(notice, /<\/secretary-setup>$/);
  assert.match(notice, /\[server-task\] 비서 서버 자동 시작 예약 작업 → .*install-autostart\.ps1/);
  assert.match(notice, /\[backup-task\] 매일 DB 백업 예약 작업 → .*backup-db\.ps1 -Install/);
  assert.match(notice, /비서 할 일: 매 답 맨 위에 한 줄로 '아직 설치가 덜 됐어요: 비서 서버 자동 시작 예약 작업, 매일 DB 백업 예약 작업\. "설치 이어서 해 줘"라고 하시면 도와드릴게요'/);
  assert.match(notice, /setup-check/);
  // The prompt hook's reminder reuses the kept check: one short line.
  saveReport(report, opts.cacheFile!);
  const reminder = setupReminder(opts);
  assert.match(reminder, /^<secretary-setup>이 답 맨 위 한 줄로 '아직 설치가 덜 됐어요: 비서 서버 자동 시작 예약 작업, 매일 DB 백업 예약 작업\./);
  assert.equal(reminder.split('\n').length, 1);
});

test("only this copy's server window counts as the server", () => {
  const root = 'C:\\secretary';
  assert.ok(serverWindow([serverProc(root)], root));
  assert.equal(serverWindow([serverProc('C:\\other-copy')], root), undefined);
  // Case and quoting as Windows reports them.
  assert.ok(serverWindow([{ ...serverProc(root), cmd: serverProc(root).cmd!.toUpperCase() }], root));
});

test("another copy's server window only leaves the server missing", async () => {
  const { opts } = fixture();
  const report = await checkSetup({ ...opts, probe: async (q) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [serverProc('C:\\other-copy')] }) });
  assert.equal(status(report)['server-running'], 'missing');
  assert.match(setupNotice(report.results), /비서 서버 실행 \(remote-server\.ps1 창이 없음\) → .*Start-ScheduledTask/);
});

test('a PowerShell window whose command line could not be read leaves the server unknown, not missing', async () => {
  const { opts } = fixture();
  const hidden: Proc = { pid: 400, name: 'powershell.exe', exe: null, cmd: null };
  const report = await checkSetup({ ...opts, probe: async (q) => ({ tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [hidden] }) });
  assert.equal(status(report)['server-running'], 'unknown');
  assert.equal(report.results.find((r) => r.id === 'server-running')!.detail, '명령줄을 못 읽은 PowerShell 창 1개(권한)');
  assert.equal(setupNotice(report.results), '');
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
  // Every item but the model (semantic search is off in tests).
  assert.equal(readCache(opts.cacheFile!)?.results.length, CHECKS.length - 1);
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
  for (const id of ['server-task', 'server-running', 'backup-task']) assert.ok(!ids.includes(id));
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

test('model files are checked by name', async () => {
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

test('check ids are unique', () => {
  const ids = CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
