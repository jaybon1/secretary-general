import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { secretaryStateDir } from '../src/core/paths.ts';
import { allStateDirs, copyOwnRecords, ensureStateDir, legacyRunJobCleanup, planLegacyRunJobCleanup, STATE_MOVED_MARK } from '../src/core/state-dir-migrate.ts';
import { tempDir, write } from './helpers.ts';

const lib = path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-lib.ps1');

/** Dot-sources worker-lib.ps1 in Windows PowerShell and returns the script's output lines. */
function ps(script: string): string[] {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${lib}'; ${script}`], {
    encoding: 'utf8',
  });
  return out.trim().split(/\r?\n/);
}

test('worker state: a space without a model is stored as null and still counts as the same settings', { skip: process.platform !== 'win32' }, () => {
  const lines = ps(
    [
      "$m = ConvertTo-WorkerModel $(if ($null) { 'x' })",
      "[pscustomobject]@{ model = $m } | ConvertTo-Json -Compress",
      "$old = '{\"model\":{},\"effort\":\"low\",\"chrome\":false,\"lock_tests\":false}' | ConvertFrom-Json",
      "$none = '{\"model\":null,\"effort\":\"low\",\"chrome\":false,\"lock_tests\":false}' | ConvertFrom-Json",
      "$son = '{\"model\":\"sonnet\",\"effort\":\"low\",\"chrome\":false,\"lock_tests\":false}' | ConvertFrom-Json",
      '[switch]$off = $false',
      "@((Test-WorkerSettingsDiffer $old $m 'low' $off $off), (Test-WorkerSettingsDiffer $none $m 'low' $off $off), (Test-WorkerSettingsDiffer $son $m 'low' $off $off), (Test-WorkerSettingsDiffer $son 'sonnet' 'low' $off $off), (Test-WorkerSettingsDiffer $son 'sonnet' 'high' $off $off)) -join ','",
    ].join('; '),
  );
  assert.equal(lines[0], '{"model":null}');
  // {} saved by the old code, null, model set vs not, same model, different effort.
  assert.equal(lines[1], 'False,False,True,False,True');
});

test('worker rest: a session that ended its turn with a background command left is resting though the list says busy', { skip: process.platform !== 'win32' }, () => {
  // Seen once: the worker said done, but a backgrounded shell that never ended kept
  // `claude agents` at status=busy for 50 minutes and the watcher never reported the rest.
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'jobs', 'bbbf63cd'), { recursive: true });
  const job = {
    state: 'done', tempo: 'idle', inFlight: { tasks: 1, kinds: ['local_bash'] },
    fan: [{ id: 'bpja81125', kind: 'shell', label: 'cd /c/x && cat > make_zip.ps1 <<EOF\n$ErrorActionPreference = "Stop"' }],
  };
  fs.writeFileSync(path.join(dir, 'jobs', 'bbbf63cd', 'state.json'), JSON.stringify(job));
  const rest = (alive: string, jobJson: string) =>
    ps(`$r = Get-WorkerRest ('${alive}' | ConvertFrom-Json) $(${jobJson}); if ($r) { "$($r.status)|$($r.state)|$($r.leftover -join ';')" } else { 'working' }`)[0];
  const busy = '{"status":"busy","state":"done"}';
  const jobOf = (j: object) => `('${JSON.stringify(j)}' | ConvertFrom-Json)`;
  // Read from <config dir>\jobs\<id>\state.json; a missing file is $null.
  assert.equal(rest(busy, `Read-WorkerJob '${dir}' 'bbbf63cd'`), 'busy|done|shell bpja81125: cd /c/x && cat > make_zip.ps1 <<EOF $ErrorActionPreference = "Stop"');
  assert.equal(rest(busy, `Read-WorkerJob '${dir}' 'missing0'`), 'working');
  assert.equal(rest('{"status":"idle","state":"blocked"}', '$null'), 'idle|blocked|');
  assert.equal(rest(busy, jobOf({ state: 'blocked', tempo: 'blocked', fan: [] })), 'busy|blocked|');
  // Waiting for its own background command (state working) or the model still running (tempo active) is work.
  assert.equal(rest(busy, jobOf({ state: 'working', tempo: 'idle', fan: [{ id: 'b1', kind: 'shell', label: 'sleep 900' }] })), 'working');
  assert.equal(rest(busy, jobOf({ state: 'done', tempo: 'active' })), 'working');
});

test('the memory MCP config in %TEMP% is named per secretary (secretary id, else a hash of its folder), so copies do not overwrite each other', { skip: process.platform !== 'win32' }, () => {
  const temp = tempDir();
  const withId = tempDir();
  fs.writeFileSync(path.join(withId, '.secretary-id'), 'a3f9\n');
  const noId = tempDir();
  const [a, b, c, file] = ps(`$env:TEMP = '${temp}'; Get-SecretaryFileTag '${withId}'; Get-SecretaryFileTag '${noId}'; Get-SecretaryFileTag '${noId}\\'; New-MemoryMcpConfig`);
  assert.equal(a, 'A3F9');
  assert.match(b, /^[0-9a-f]{8}$/);
  assert.equal(c, b, 'the same folder written another way');
  assert.equal(path.dirname(file), temp);
  // SECRETARY_DB is set in tests (test/env.ts): the server gets it too, and the file has its own name (a DB copy's run
  // never shares the config of the real one).
  assert.match(path.basename(file), /^secretary-memory-readonly-(?:[A-Z0-9]{4,12}|[0-9a-f]{8})-db-[0-9a-f]{8}\.mcp\.json$/);
  const server = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.secretary;
  assert.deepEqual(server.args, [path.join(PROJECT_ROOT, 'src', 'mcp', 'server.ts'), '--readonly']);
  assert.equal(server.env.SECRETARY_DB, process.env.SECRETARY_DB);
});
test('run-job stats leave out the calls tests made (Haiku in a %TEMP% folder) unless asked, and only read the file', { skip: process.platform !== 'win32' }, () => {
  const home = tempDir();
  // This copy's records folder under that home (its id's folder, or the shared one in a copy without an id).
  const records = secretaryStateDir(PROJECT_ROOT, path.join(home, '.secretary'), path.join(home, '.secretary', 'usage'));
  fs.mkdirSync(records, { recursive: true });
  const call = (folder: string, model: string) =>
    JSON.stringify({ at: '2026-11-06T00:00:00Z', provider: 'subscription', model, folder, resumed: false, new_reason: '-New', total_sec: 1, cost_usd: 0.01, context: 1 });
  const text = [
    call('C:\\Users\\x\\AppData\\Local\\Temp', 'haiku'),
    call('C:\\Users\\X~1\\AppData\\Local\\Temp\\rj-test-1', 'claude-haiku-4-5'),
    call('C:\\ai\\workspaces\\_run-job-home', 'haiku'),
    call('C:\\Users\\x\\AppData\\Local\\Temp', 'sonnet'),
  ].join('\n') + '\n';
  const file = path.join(records, 'run-job-calls.jsonl');
  fs.writeFileSync(file, text);
  const stats = (...args: string[]) =>
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT_ROOT, 'scripts', 'run-job', 'run-job-stats.ps1'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home },
    });
  assert.match(stats(), /^최근 호출 2개 · 시험 호출 2개 뺌/);
  assert.match(stats('-WithTests'), /^최근 호출 4개\r?\n/);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the record is left as it is');
});

// Without it: two secretaries on one PC read and write each other's work sessions and run-jobs (resuming the other's run-job
// session, stopping its idle work session), or the PowerShell side writes where the dashboard and hooks do not read.
test('records folder: ~/.secretary/<id>/state on both sides, the shared ~/.secretary/usage for a copy without an id; every writer uses it', { skip: process.platform !== 'win32' }, () => {
  const home = tempDir();
  const withId = tempDir();
  fs.writeFileSync(path.join(withId, '.secretary-id'), 'a3f9\n');
  const noId = tempDir();
  const common = path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1');
  const cmd = `$env:USERPROFILE = '${home}'; . '${common}'; Get-SecretaryStateDir '${withId}'; Get-SecretaryStateDir '${noId}'`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const ts = (root: string) => secretaryStateDir(root, path.join(home, '.secretary'), path.join(home, '.secretary', 'usage'));
  assert.deepEqual(out, [ts(withId), ts(noId)]);
  assert.equal(out[0], path.join(home, '.secretary', 'A3F9', 'state'));
  assert.equal(out[1], path.join(home, '.secretary', 'usage'));
  // The scripts that write or read the records name no other folder for them.
  for (const f of ['run-job/run-job.ps1', 'run-job/run-job-stats.ps1', 'worker/worker-lib.ps1', 'worker/watch-worker.ps1', 'lib/detached-job.ps1']) {
    const text = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', ...f.split('/')), 'utf8');
    assert.match(text, /Get-SecretaryStateDir/, f);
    assert.doesNotMatch(text.replace(/function Get-BgJobDir[\s\S]*?\n\}/, ''), /Join-Path \(?Get-UsageDir/, `${f} keeps no record in the shared folder`);
    assert.doesNotMatch(text, /secretary_id/, `${f}: the folder tells whose it is`);
  }
});

// Without it: after the move a secretary's dashboard and run-job stats lose its history, takes another secretary's
// records, loses what it wrote in the new folder before the move, or copies them again every session.
test('records move: this secretary\'s lines and entries (its id or none) are copied once in front of the new ones; the old files stay', () => {
  const home = tempDir();
  const usage = tempDir();
  const root = tempDir();
  fs.writeFileSync(path.join(root, '.secretary-id'), 'A3F9\n');
  const call = (model: string, id?: string) => JSON.stringify({ at: '2026-11-07T10:00:00Z', model, ...(id ? { secretary_id: id } : {}) });
  const oldCalls = [call('before-ids'), call('mine', 'A3F9'), call('lower', 'a3f9'), call('other', 'ZZZZ'), '{"cut'].join('\n') + '\n';
  write(path.join(usage, 'run-job-calls.jsonl'), oldCalls);
  write(path.join(usage, 'worker-reuse.jsonl'), JSON.stringify({ at: 'x', id: 'w1' }) + '\n');
  write(path.join(usage, 'worker-sessions.json'), JSON.stringify({ aaaa1111: { id: 'aaaa1111', folder: 'C:\\w' }, bbbb2222: { id: 'bbbb2222', done_at: 'x' } }));
  write(
    path.join(usage, 'run-job-sessions.json'),
    JSON.stringify({
      'subscription|C:\\w|sonnet': { session_id: 'old', at: '2026-11-07T09:00:00Z' },
      'A3F9|subscription|C:\\w|sonnet': { session_id: 'mine', at: '2026-11-07T10:00:00Z' },
      'ZZZZ|subscription|C:\\w|opus': { session_id: 'other', at: '2026-11-07T10:00:00Z' },
    }),
  );
  const shared = tempDir();
  const dir = secretaryStateDir(root, home, shared);
  assert.equal(dir, path.join(home, 'A3F9', 'state'));
  // A run-job wrote in the new folder before the first session moved anything.
  write(path.join(dir, 'run-job-calls.jsonl'), call('new') + '\n');
  write(path.join(dir, 'worker-sessions.json'), JSON.stringify({ cccc3333: { id: 'cccc3333' } }));
  assert.equal(ensureStateDir({ root, home, legacyUsageDir: usage, usageDir: shared }), dir);
  const lines = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l).model);
  assert.deepEqual(lines('run-job-calls.jsonl'), ['before-ids', 'mine', 'lower', 'new']);
  assert.equal(fs.readFileSync(path.join(dir, 'worker-reuse.jsonl'), 'utf8').trim(), JSON.stringify({ at: 'x', id: 'w1' }));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'worker-sessions.json'), 'utf8'))).sort(), ['aaaa1111', 'bbbb2222', 'cccc3333']);
  // The key loses the id (the folder tells whose it is); the newer of two for one key wins; another secretary's stays out.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run-job-sessions.json'), 'utf8')), { 'subscription|C:\\w|sonnet': { session_id: 'mine', at: '2026-11-07T10:00:00Z' } });
  assert.equal(fs.readFileSync(path.join(usage, 'run-job-calls.jsonl'), 'utf8'), oldCalls, 'the shared file is left as it was');
  assert.ok(fs.existsSync(path.join(dir, STATE_MOVED_MARK)));
  // Once: a second session copies nothing again.
  ensureStateDir({ root, home, legacyUsageDir: usage, usageDir: shared });
  assert.deepEqual(lines('run-job-calls.jsonl'), ['before-ids', 'mine', 'lower', 'new']);
  // A copy without an id keeps the shared folder and moves nothing.
  const noId = tempDir();
  assert.equal(ensureStateDir({ root: noId, home, legacyUsageDir: usage, usageDir: shared }), shared);
  assert.deepEqual(copyOwnRecords('A3F9', tempDir(), tempDir()), [], 'nothing old: nothing written');
});

// 없으면 놓치는 실수: 2026-11-09 기록 폴더를 ~/.secretary/state/<번호>에서 ~/.secretary/<번호>/state로 옮길 때 그동안의 업무 세션·run-job 기록을
// 잃거나, 옛 폴더가 이미 가져온 ~/.claude/usage 기록을 한 번 더 붙이거나, 새 폴더에 먼저 쓰인 기록(서버·run-job이 먼저 돈 경우)을 덮는다.
test('records move from ~/.secretary/state/<id>: all of it in front of what the new folder holds; the shared folder only when the old one never took it', () => {
  const home = tempDir();
  const usage = tempDir();
  const shared = tempDir();
  const root = tempDir();
  fs.writeFileSync(path.join(root, '.secretary-id'), 'BCD2\n');
  const call = (model: string) => JSON.stringify({ at: '2026-11-08T10:00:00Z', model });
  const before = path.join(home, 'state', 'BCD2');
  write(path.join(usage, 'run-job-calls.jsonl'), call('shared') + '\n');
  write(path.join(before, 'run-job-calls.jsonl'), [call('old-1'), call('old-2')].join('\n') + '\n');
  write(path.join(before, 'run-job-sessions.json'), JSON.stringify({ 'subscription|C:\\w|opus': { session_id: 'old', at: '2026-11-08T09:00:00Z' } }));
  write(path.join(before, STATE_MOVED_MARK), 'done\n');
  const dir = path.join(home, 'BCD2', 'state');
  write(path.join(dir, 'run-job-calls.jsonl'), call('new') + '\n');
  write(path.join(dir, 'run-job-sessions.json'), JSON.stringify({ 'subscription|C:\\w|opus': { session_id: 'new', at: '2026-11-09T09:00:00Z' } }));
  assert.equal(ensureStateDir({ root, home, legacyUsageDir: usage, usageDir: shared }), dir);
  const models = () => fs.readFileSync(path.join(dir, 'run-job-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).model);
  assert.deepEqual(models(), ['old-1', 'old-2', 'new'], 'the old folder took the shared one already (its mark): not again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run-job-sessions.json'), 'utf8'))['subscription|C:\\w|opus'].session_id, 'new', 'the newer entry stays');
  assert.ok(fs.existsSync(path.join(before, 'run-job-calls.jsonl')), 'the old folder is left as it was');
  // An old folder that never took the shared one's records: both come along, the shared ones (older) first.
  const home2 = tempDir();
  write(path.join(home2, 'state', 'BCD2', 'run-job-calls.jsonl'), call('old-1') + '\n');
  ensureStateDir({ root, home: home2, legacyUsageDir: usage, usageDir: shared });
  assert.deepEqual(fs.readFileSync(path.join(home2, 'BCD2', 'state', 'run-job-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).model), ['shared', 'old-1']);
});

// 없으면 놓치는 실수: 옛 공용 폴더(~/.claude/usage)의 run-job 기록을 대조 없이 지워, 아직 옮기지 않은 비서의 기록이나 돌고 있는 run-job 표시를 잃는다.
test('old shared run-job records: removable only when every line and entry is in some secretary\'s records, active files only when their run ended', () => {
  const home = tempDir();
  const usage = tempDir();
  const a = JSON.stringify({ at: '2026-11-01T00:00:00Z', model: 'a' });
  const b = JSON.stringify({ at: '2026-11-01T00:00:00Z', model: 'b' });
  write(path.join(usage, 'run-job-calls.jsonl'), `${a}\n${b}\n{"cut\n`);
  write(path.join(usage, 'run-job-sessions.json'), JSON.stringify({ 'A3F9|subscription|C:\\w|opus': { session_id: 's', at: '2026-11-01T00:00:00Z' } }));
  write(path.join(usage, 'run-job-active', '111.json'), JSON.stringify({ pid: 111 }));
  write(path.join(usage, 'run-job-active', '222.json'), JSON.stringify({ pid: 222 }));
  write(path.join(home, 'A3F9', 'state', 'run-job-calls.jsonl'), `${a}\n`);
  write(path.join(home, 'state', 'ZZ22', 'run-job-sessions.json'), JSON.stringify({ 'subscription|C:\\w|opus': { session_id: 't', at: '2026-11-02T00:00:00Z' } }));
  const alive = (pid: number) => pid === 222;
  const dirs = allStateDirs(home);
  assert.deepEqual(dirs.sort(), [path.join(home, 'A3F9', 'state'), path.join(home, 'state', 'ZZ22')].sort());
  const plan = planLegacyRunJobCleanup(usage, dirs, alive);
  const by = (f: string) => plan.find((i) => i.file.endsWith(f))!;
  assert.equal(by('run-job-calls.jsonl').removable, false, 'line b is in nobody\'s records');
  assert.equal(by('run-job-sessions.json').removable, true, 'a later entry for the same key');
  assert.equal(by('111.json').removable, true);
  assert.equal(by('222.json').removable, false, 'still running');
  // A dry run removes nothing; the real one only what can go.
  legacyRunJobCleanup({ dryRun: true, legacyUsageDir: usage, stateDirs: dirs, alive });
  assert.ok(fs.existsSync(path.join(usage, 'run-job-sessions.json')));
  write(path.join(home, 'A3F9', 'state', 'run-job-calls.jsonl'), `${a}\n${b}\n`);
  const done = legacyRunJobCleanup({ legacyUsageDir: usage, stateDirs: dirs, alive });
  assert.deepEqual(done.filter((i) => i.removed).map((i) => path.basename(i.file)).sort(), ['111.json', 'run-job-calls.jsonl', 'run-job-sessions.json']);
  assert.ok(fs.existsSync(path.join(usage, 'run-job-active', '222.json')));
});

// Without it: a detached run-job started before the records moved cannot be waited for ("기록이 없어요") after the update.
test('detached jobs: wait-job finds a job in the old shared folder when the new one has none', { skip: process.platform !== 'win32' }, () => {
  const home = tempDir();
  const lib = path.join(PROJECT_ROOT, 'scripts', 'lib', 'detached-job.ps1');
  const cmd = `$env:USERPROFILE = '${home}'; . '${lib}'; $old = Join-Path (Get-LegacyUsageDir) 'bg-jobs\\j1'; New-Item -ItemType Directory -Force $old | Out-Null; Get-BgJobDir 'j1'; Get-BgJobDir 'j2'`;
  const [j1, j2] = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(j1, path.join(home, '.claude', 'usage', 'bg-jobs', 'j1'));
  const records = secretaryStateDir(PROJECT_ROOT, path.join(home, '.secretary'), path.join(home, '.secretary', 'usage'));
  assert.equal(j2, path.join(records, 'bg-jobs', 'j2'));
});