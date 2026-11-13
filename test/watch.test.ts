import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';
import { claudeOwner, type ProcTable, unwatchedTasks, WATCH_TIMEOUT_MS, watcherAlive, watcherOurs } from '../src/workspace/watch-check.ts';

test('the watcher stops at 55 minutes, before the time limit the secretary gives its background command', () => {
  // 55 minutes: the secretary wakes while its 1-hour prompt cache is still warm.
  const script = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'worker', 'watch-worker.ps1'), 'utf8');
  // The default is the shared cache-wake minutes (lib/common.ps1), also wait-job.ps1's and the session reuse limit.
  assert.match(script, /if \(-not \$MaxMinutes\) \{ \$MaxMinutes = \$CacheWakeMinutes \}/);
  const env = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1'), 'utf8');
  const max = Number(/^\$CacheWakeMinutes = (\d+)/m.exec(env)?.[1]);
  assert.equal(max, 55);
  assert.ok(max * 60_000 < WATCH_TIMEOUT_MS, 'the watcher ends first');
  assert.equal(WATCH_TIMEOUT_MS, 3_600_000);
  // The time-up line says the task still runs and the watch is to be relaunched without a notification.
  assert.match(script, /시간 끝\(\$span\): .*아직 일하는 중.*알림 없이 모니터링을 다시 띄우세요/);
  // The delegate skill tells the secretary the same limit.
  const skill = fs.readFileSync(path.join(PROJECT_ROOT, '.agents', 'skills', 'delegate', 'SKILL.md'), 'utf8');
  assert.match(skill, new RegExp(`watch-worker\\.ps1 -Id <id>\`를 백그라운드 명령\\(run_in_background, timeout ${WATCH_TIMEOUT_MS}\\)`));
  assert.doesNotMatch(skill, /7200000/);
});

test('unwatchedTasks lists only bg tasks without a live watcher', () => {
  const tasks = [
    { id: 1, title: 'a', sessionRef: 'bg:aaaa1111' },
    { id: 2, title: 'b', sessionRef: 'bg:bbbb2222' },
    { id: 3, title: 'c', sessionRef: 'app:xyz' },
    { id: 4, title: 'd', sessionRef: null },
  ];
  const off = unwatchedTasks(tasks, (id) => id === 'aaaa1111');
  assert.deepEqual(off, [{ id: 2, title: 'b', bg: 'bbbb2222' }]);
});

test('watcherAlive reads the pid file and checks the process', () => {
  const dir = tempDir('watch-');
  fs.writeFileSync(path.join(dir, 'abcd1234.pid'), `${process.pid}\r\n`);
  assert.equal(watcherAlive('abcd1234', dir), true);
  assert.equal(watcherAlive('abcd1234', dir, () => false), false);
  assert.equal(watcherAlive('missing0', dir), false);
  fs.writeFileSync(path.join(dir, 'bad00000.pid'), 'x');
  assert.equal(watcherAlive('bad00000', dir), false);
});

test('a watcher counts as ours only when it hangs under the same claude.exe as the hook', () => {
  // 1 remote-control server > 10 session A > 11 bash > 12 watcher; 10 > 13 hook; 20 session B > 21 watcher
  const table: ProcTable = new Map([
    [1, { ppid: 0, name: 'claude.exe' }],
    [10, { ppid: 1, name: 'claude.exe' }],
    [11, { ppid: 10, name: 'bash.exe' }],
    [12, { ppid: 11, name: 'powershell.exe' }],
    [13, { ppid: 10, name: 'node.exe' }],
    [20, { ppid: 1, name: 'claude.exe' }],
    [21, { ppid: 20, name: 'powershell.exe' }],
  ]);
  assert.equal(claudeOwner(12, table), 10);
  assert.equal(claudeOwner(13, table), 10);
  assert.equal(claudeOwner(99, table), undefined);
  const dir = tempDir('watch-own-');
  fs.writeFileSync(path.join(dir, 'aaaa.pid'), '12');
  fs.writeFileSync(path.join(dir, 'bbbb.pid'), '21');
  fs.writeFileSync(path.join(dir, 'cccc.pid'), '77');
  assert.equal(watcherOurs('aaaa', table, 13, dir), true);
  assert.equal(watcherOurs('bbbb', table, 13, dir), false); // another session's watcher wakes that session
  assert.equal(watcherOurs('cccc', table, 13, dir), false); // dead pid
  assert.equal(watcherOurs('dddd', table, 13, dir), false); // no pid file
  assert.equal(watcherOurs('aaaa', null, 13, dir), false); // table unreadable: relaunch rather than miss
});

// 없으면 놓치는 실수: 업무 세션이 테스트를 백그라운드 셸로 돌려 자식 명령으로 안 잡히면, 결과 파일이 몇 분마다 쓰여도 10분 뒤 '멈춤 의심'이 떠
// 비서(모델)가 헛되이 깬다(업무 159에서 두 번). 반대로 외부 기기에서 사용자 크롬을 세면 정말 멈춘 업무를 놓친다.
// 없으면 놓치는 실수: 이 PC의 시험 프로그램 CPU는 업무와 상관없는 프로그램으로도 늘어 멈춘 업무를 놓치므로 보지 않기로 했는데(2026-11-11 보류), 모니터링이 다시 이 PC에서 잰다.
test('the watcher counts result/sandbox file changes as movement, not this PC\'s test-program CPU (external devices skip the user\'s Chrome)', () => {
  const watch = path.join(PROJECT_ROOT, 'scripts', 'worker', 'watch-worker.ps1');
  const text = fs.readFileSync(watch, 'utf8');
  // The file check feeds the evidence lines of the stall and time-up messages; nothing samples this PC's test programs.
  assert.match(text, /\$evidence = @\(\$child\.text, \$files\.text/);
  const loop = text.slice(text.indexOf('# ---- 모니터링'));
  assert.ok(loop.length < text.length && !/Get-TestProcSample|Select-TestProcesses/.test(loop), 'the monitoring loop does not sample this PC');
  const devices = text.includes('function Get-DeviceLines');
  if (devices) assert.match(text, /\$remote = \$TestProcCode \+ @'/);
  const root = tempDir('watch-move-');
  const cwd = path.join(root, 'space-a');
  const task = path.join(cwd, 'output', 'records', 'prod', '20261111-run');
  const older = path.join(cwd, 'output', 'research', '20261101-old');
  const sandbox = path.join(root, '_sandbox', 'space-a-159');
  const other = path.join(root, '_sandbox', 'space-b-1');
  for (const d of [task, older, sandbox, other, path.join(task, 'node_modules')]) fs.mkdirSync(d, { recursive: true });
  for (const f of [path.join(task, 'TASK.md'), path.join(older, 'a.txt'), path.join(sandbox, 'out.png'), path.join(other, 'x.png'), path.join(task, 'node_modules', 'm.js')]) fs.writeFileSync(f, 'x');
  const ps1 = path.join(tempDir(), 'probe.ps1');
  fs.writeFileSync(ps1, '\uFEFF' + [
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
    `$ast = [Management.Automation.Language.Parser]::ParseFile('${watch}', [ref]$null, [ref]$null)`,
    "foreach ($a in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and \"$($n.Left)\" -eq '$TestProcCode' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }",
    "foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'Get-WatchFolders', 'Find-RecentFile' }, $true)) { . ([scriptblock]::Create($f.Extent.Text)) }",
    `$cwd = '${cwd}'`,
    "$old = (Get-Date).AddHours(-1)",
    `Get-ChildItem -LiteralPath '${root}' -Recurse -File | ForEach-Object { $_.LastWriteTime = $old }`,
    `(Get-Item -LiteralPath '${older}').CreationTime = (Get-Date).AddDays(-3)`,
    `(Get-Item -LiteralPath '${task}').CreationTime = (Get-Date).AddDays(-1)`,
    "$byIntent = @(Get-WatchFolders $cwd 'output/records/prod/20261111-run/TASK.md의 업무를 이 폴더의 AGENTS.md 규칙대로 수행하고')",
    "$byNewest = @(Get-WatchFolders $cwd '')",
    "$since = (Get-Date).AddMinutes(-5)",
    "$quiet = Find-RecentFile $byIntent $since",
    `(Get-Item -LiteralPath '${path.join(task, 'node_modules', 'm.js')}').LastWriteTime = Get-Date`,
    "$quietDeps = Find-RecentFile $byIntent $since",
    `(Get-Item -LiteralPath '${path.join(sandbox, 'out.png')}').LastWriteTime = Get-Date`,
    "$wrote = Find-RecentFile $byIntent $since",
    "$none = Find-RecentFile @() $since",
    // Fake processes for the external-device filter: the user's Chrome and its renderer, a headless Chrome's renderer, a test node, claude.
    "function P($id, $parent, $name, $cl, $sec) { [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent; Name = $name; CommandLine = $cl; KernelModeTime = 0; UserModeTime = $sec * 1e7 } }",
    "$procs = @((P 10 1 'chrome.exe' '\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"' 50), (P 11 10 'chrome.exe' 'chrome.exe --type=renderer' 40),",
    "  (P 20 1 'chrome.exe' 'chrome.exe --headless=new --user-data-dir=C:\\t\\p' 5), (P 21 20 'chrome.exe' 'chrome.exe --type=renderer' 9),",
    "  (P 40 1 'node.exe' 'node --test test/a.test.ts' 12), (P 50 1 'claude.exe' 'claude' 99))",
    "$picked = if ($TestProcCode) { . ([scriptblock]::Create($TestProcCode)); @((Select-TestProcesses $procs).Keys | Sort-Object) } else { $null }",
    '@{ byIntent = $byIntent; byNewest = $byNewest; quiet = $quiet; quietDeps = $quietDeps; wrote = $wrote; none = $none; picked = $picked } | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n'));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  // The task folder named in the session's instruction, else the newest task folder; this workspace's sandbox folders only.
  assert.deepEqual(got.byIntent, [task, sandbox]);
  assert.deepEqual(got.byNewest, [task, sandbox]);
  assert.equal(got.quiet.moved, false);
  assert.match(got.quiet.text, /바뀐 파일 없음/);
  assert.equal(got.quietDeps.moved, false, 'node_modules is not looked in');
  assert.equal(got.wrote.moved, true);
  assert.match(got.wrote.text, /out\.png/);
  assert.match(got.none.text, /모름/);
  // On an external device only the headless Chrome (and its renderer) and the test node: not the user's Chrome or claude.
  if (devices) assert.deepEqual(got.picked, [20, 21, 40]);
});