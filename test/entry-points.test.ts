import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tempDir, write } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { ENTRY_DIR, ENTRY_POINTS, entryPath, entryText, secretaryDirEnv, scriptPath, SCRIPTS, type EntryName } from '../src/core/paths.ts';
import { readSecretaryId } from '../src/setup/secretary-id.ts';
import { usageHookProblems } from '../src/setup/setup-check.ts';
import { renderCharter, renderFindSecretary } from '../src/workspace/rules-text.ts';

const names = Object.keys(ENTRY_POINTS) as EntryName[];
const BOM = '\uFEFF';
const read = (file: string) => fs.readFileSync(file, 'utf8');
const win = process.platform === 'win32';
const ps = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', env });

test('bin/ holds exactly the entry points, each as entryText says, running a script that is there', () => {
  const files = fs.readdirSync(path.join(PROJECT_ROOT, ENTRY_DIR)).sort();
  assert.deepEqual(files, [...names].sort());
  for (const name of names) {
    const text = read(entryPath(name));
    // Windows PowerShell 5.1 reads a .ps1 without a BOM in the ANSI code page (the Korean comments would break).
    assert.equal(text.startsWith(BOM), name.endsWith('.ps1'), `${name}: BOM only on .ps1`);
    assert.equal(text.replace(BOM, '').replace(/\r\n/g, '\n'), entryText(name), `${ENTRY_DIR}/${name} should be:\n${entryText(name)}`);
    assert.ok(fs.existsSync(scriptPath(ENTRY_POINTS[name])), `${name} → ${SCRIPTS[ENTRY_POINTS[name]]} missing`);
  }
});

test('nothing the secretary ships names its own folder: the worker allow list has no PC path', () => {
  const perms = read(path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-permissions.json'));
  assert.doesNotMatch(perms, /[A-Za-z]:\\\\Users\\\\/);
});

test('ego-grab through bin/ exports the real grab', async () => {
  const viaBin = await import(pathToFileURL(entryPath('ego-grab.mjs')).href);
  const real = await import(pathToFileURL(scriptPath('egoGrab')).href);
  assert.equal(typeof viaBin.grab, 'function');
  assert.equal(viaBin.grab, real.grab);
});

test('workspace rules name ego-grab by its bin entry and say how to reach the secretary’s scripts', () => {
  const charter = renderCharter({ kind: 'solo', name: 'ext', title: '확장', purpose: '크롬 확장' });
  assert.ok(charter.includes(`\`${entryPath('ego-grab.mjs').replace(/\\/g, '/')}\``));
  // The entrance folder: the workspace's secretary-link.local.json first, then bin under this secretary's own variable (its install
  // id in the name); not the old SECRETARY_DIR any more. Nothing else of the secretary folder.
  assert.ok(charter.includes(`비서 스크립트는 비서의 입구 폴더(\`${ENTRY_DIR}\`)에 있는 이름으로만 부르고, 비서 폴더의 다른 파일은 열거나 실행하지 않는다`));
  assert.ok(charter.includes('입구 폴더는 이 공간 맨 위 `secretary-link.local.json`의 `bin`이다'));
  assert.ok(charter.includes(renderFindSecretary().join('\n')), 'the charter carries this copy\'s lines');
  // The variable comes from the secretary id; with none yet, only the old name.
  const linesFor = (root: string) => renderFindSecretary(secretaryDirEnv(readSecretaryId(root))).join('\n');
  const withId = tempDir();
  write(path.join(withId, '.secretary-id'), 'A3F9\n');
  assert.ok(linesFor(withId).includes('그 파일이 없으면 환경변수 `SECRETARY_A3F9_DIR` 아래 `bin`을 쓴다'));
  assert.ok(!linesFor(withId).includes('SECRETARY_DIR'), 'the old name is not in the charter');
  assert.ok(linesFor(tempDir()).includes('환경변수 `SECRETARY_DIR` 아래 `bin`을 쓴다'));
  assert.equal(secretaryDirEnv('a3f9'), 'SECRETARY_A3F9_DIR');
  assert.equal(secretaryDirEnv('A3F9'), 'SECRETARY_A3F9_DIR');
  assert.ok(!charter.includes(SCRIPTS.egoGrab));
});

/** A copy of the run-job entry in a temp folder, running a stand-in script that prints what it got. */
function fakeEntry(): { root: string; entry: string } {
  const root = tempDir();
  const entry = entryPath('run-job.ps1', root);
  write(entry, BOM + entryText('run-job.ps1'));
  write(
    scriptPath('runJob', root),
    [
      'param([Parameter(Mandatory)] [string]$Job, [string[]]$Inputs = @(), [string]$OutDir, [string]$ToolArgs = \'\', [switch]$Detach)',
      '"Job=$Job Inputs=$($Inputs.Count):$($Inputs -join \'|\') OutDir=$OutDir ToolArgs=<$ToolArgs> Detach=$Detach"',
      '"Root=$PSScriptRoot"',
      'if ($Job -eq \'fail\') { exit 7 }',
      'if ($Job -eq \'native\') { cmd /c exit 3 }',
      '',
    ].join('\r\n'),
  );
  return { root, entry };
}

test('a PowerShell entry passes arguments and the exit code through as -File would', { skip: !win }, () => {
  const { root, entry } = fakeEntry();
  // As a Python tool passes them (subprocess list, -ToolArgs quotes written \").
  const args = ['-Job', 'demo', '-Inputs', 'C:\\x y\\a.txt', '-OutDir', 'out', '-ToolArgs', '\\"{in}\\a.txt\\" --out \\"{out}\\"', '-Detach'];
  const direct = ps(scriptPath('runJob', root), args);
  assert.match(direct.stdout, /^Job=demo Inputs=1:C:\\x y\\a\.txt OutDir=out ToolArgs=<.*\{in\}.*\{out\}.*> Detach=True/);
  for (const file of [entry]) {
    const r = ps(file, args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, direct.stdout, file);
    // The real script sees its own folder, not bin\..\scripts\..: its sibling paths and process matching hold.
    assert.match(r.stdout.trim().split(/\r?\n/)[1], /^Root=.*\\scripts\\run-job$/);
    assert.equal(ps(file, ['-Job', 'fail']).status, 7);
    // A native command's code left over at a normal end is not the script's exit code (powershell -File gives 0).
    assert.equal(ps(file, ['-Job', 'native']).status, 0);
    // A missing mandatory parameter is an error (non-interactive), not a hang.
    assert.notEqual(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' }).status, 0);
  }
  // Called from PowerShell code with an array and a switch (workspace tools build such lines).
  const line = `& '${entry}' -Job ffmpeg -Inputs 'a b','c' -OutDir o -Detach; exit $LASTEXITCODE`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', line], { encoding: 'utf8' });
  assert.match(r.stdout, /Job=ffmpeg Inputs=2:a b\|c OutDir=o ToolArgs=<> Detach=True/);
});

test('the PowerShell scripts set SECRETARY_DIR to their own folder, and the worker allow list reads', { skip: !win }, () => {
  const common = path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1');
  const cmd = `. '${common}'; $env:SECRETARY_DIR; @((Get-WorkerPermissions).permissions.allow | Where-Object { $_ -like '*{SECRETARY_DIR}*' }).Count; @((Get-WorkerPermissions).permissions.allow).Count -gt 10`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    encoding: 'utf8',
    env: { ...process.env, SECRETARY_DIR: 'C:\\somewhere-else' },
  })
    .trim()
    .split(/\r?\n/);
  assert.deepEqual(out, [PROJECT_ROOT, '0', 'True']);
});

test('the folder variables the scripts hand down: SECRETARY_<id>_DIR of the secretary id, and the old SECRETARY_DIR while tools move', { skip: !win }, () => {
  const common = path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1');
  const withId = tempDir();
  write(path.join(withId, '.secretary-id'), 'a3f9\n');
  const noId = tempDir();
  const show = (root: string) => `((Get-SecretaryDirVars '${root}').GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ';'`;
  const cmd = `. '${common}'; ${show(withId)}; ${show(noId)}; Get-SecretaryDirEnv 'a3f9'; Get-SecretaryDirEnv ''`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(out, [`SECRETARY_DIR=${withId};SECRETARY_A3F9_DIR=${withId}`, `SECRETARY_DIR=${noId}`, 'SECRETARY_A3F9_DIR', 'SECRETARY_DIR']);
  // The same name on both sides (src/core/paths.ts).
  assert.equal(secretaryDirEnv('a3f9'), out[2]);
});

test('install-usage-guard writes the bin entries, moves old-path ones over, and leaves another status line alone', () => {
  const run = (dir: string) => execFileSync(process.execPath, [scriptPath('installUsageGuard')], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const fresh = tempDir();
  assert.match(run(fresh), /상태줄 등록\n- 정지 훅 등록/);
  assert.deepEqual(usageHookProblems(fresh, PROJECT_ROOT), []);
  assert.match(run(fresh), /상태줄은 이미 등록돼 있음\n- 정지 훅은 이미 등록돼 있음/);
  assert.equal(JSON.parse(read(path.join(fresh, 'settings.json'))).hooks.PreToolUse.length, 1);

  const moved = tempDir();
  const oldCmd = (n: string) => `node "C:/old/secretary/scripts/${n}"`;
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.mjs' }] };
  write(path.join(moved, 'settings.json'), BOM + JSON.stringify({
    statusLine: { type: 'command', command: oldCmd('usage-statusline.mjs') },
    hooks: { PreToolUse: [other, { hooks: [{ type: 'command', command: oldCmd('usage-guard.mjs'), timeout: 5 }] }] },
    model: 'opus',
  }));
  assert.match(run(moved), /상태줄을 입구로 고침 \(전: node "C:\/old\/secretary\/scripts\/usage-statusline\.mjs"\)\n- 정지 훅을 입구로 고침/);
  const after = JSON.parse(read(path.join(moved, 'settings.json')));
  assert.deepEqual(usageHookProblems(moved, PROJECT_ROOT), []);
  assert.deepEqual(after.hooks.PreToolUse[0], other);
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.equal(after.model, 'opus');
  assert.ok(fs.existsSync(path.join(moved, 'settings.json.bak')));

  const theirs = tempDir();
  write(path.join(theirs, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-line.exe' } }));
  assert.match(run(theirs), /다른 상태줄이 있어 건드리지 않음/);
  assert.deepEqual(usageHookProblems(theirs, PROJECT_ROOT), ['다른 상태줄']);
});

test('install-usage-guard leaves another secretary’s hook and status line alone, and moves this copy’s old ones from a folder no secretary is in', () => {
  const run = (dir: string) => execFileSync(process.execPath, [scriptPath('installUsageGuard')], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const other = tempDir();
  write(path.join(other, 'package.json'), JSON.stringify({ name: 'secretary' }));
  for (const n of ['usage-guard.mjs', 'usage-statusline.mjs'] as EntryName[]) write(entryPath(n, other), entryText(n));
  const cmd = (dir: string, n: string) => `node "${path.join(dir, 'bin', n).replace(/\\/g, '/')}"`;
  const settings = (dir: string) => ({
    statusLine: { type: 'command', command: cmd(dir, 'usage-statusline.mjs') },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: cmd(dir, 'usage-guard.mjs'), timeout: 5 }] }] },
  });
  const shared = tempDir();
  write(path.join(shared, 'settings.json'), JSON.stringify(settings(other)));
  const out = run(shared);
  assert.match(out, /상태줄: 다른 비서\(.+\) 것이라 건드리지 않음/);
  assert.match(out, /정지 훅: 다른 비서\(.+\) 것이라 건드리지 않음/);
  assert.deepEqual(JSON.parse(read(path.join(shared, 'settings.json'))), settings(other));
  // That copy's files gone (its own old layout): still that copy's, still left alone.
  fs.rmSync(path.join(other, 'bin'), { recursive: true });
  assert.match(run(shared), /없는 파일을 부르지만 그 비서 것이라 건드리지 않음\(그 비서 폴더에서 이 스크립트를 다시 돌린다\)/);
  assert.deepEqual(JSON.parse(read(path.join(shared, 'settings.json'))), settings(other));
  // No secretary there any more (this copy was moved from there): this copy's old path, moved over.
  fs.rmSync(path.join(other, 'package.json'));
  assert.match(run(shared), /상태줄을 입구로 고침[^\n]*\n- 정지 훅을 입구로 고침/);
  assert.deepEqual(usageHookProblems(shared, PROJECT_ROOT), []);
});
