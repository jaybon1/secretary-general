import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
// @ts-expect-error plain .mjs hook script without types
import { check, parseArgs } from '../scripts/worker/worker-folder-guard.mjs';

const WS = path.join(PROJECT_ROOT, '..', 'some-space-20261023');
const write = (file: string) => ({ file_path: file });
const shell = (command: string) => ({ command });

test('writes stay inside the workspace, and test files only when tests are not locked', () => {
  assert.equal(check('Write', write(path.join(WS, 'output', 'a', 'x.md')), WS), null);
  assert.match(check('Edit', write(path.join(WS, '..', 'other', 'x.md')), WS), /공간 폴더 안에만/);
  assert.match(check('Write', write(path.join(PROJECT_ROOT, 'AGENTS.md')), WS), /공간 폴더 안에만/);
  const spec = path.join(WS, 'src', 'app.test.ts');
  assert.equal(check('Edit', write(spec), WS), null);
  assert.match(check('Edit', write(spec), WS, { lockTests: true }), /테스트 잠금/);
  assert.match(check('Write', write(path.join(WS, 'tests', 'helper.py')), WS, { lockTests: true }), /테스트 잠금/);
  assert.equal(check('Edit', write(path.join(WS, 'src', 'latest.ts')), WS, { lockTests: true }), null);
});

// [늘 남김] 없으면 놓치는 실수: 업무 세션의 보통 명령까지 막아 일이 멈추거나, 공개·push·폴더째 지우기가 그대로 통과한다(훅이 도구를 잘못 막음).
test('publishing, pushing and recursive deletes are blocked; ordinary commands pass', () => {
  for (const cmd of ['git push origin main', 'npm publish', 'gh release create v1', 'npx vercel --prod', 'rm -rf build', 'Remove-Item out -Recurse -Force', 'curl -F file=@a.mp4 https://x']) {
    assert.ok(check('Bash', shell(cmd), WS), cmd);
  }
  for (const cmd of ['git status', 'git commit -m "x"', 'npm test', 'rm -f a.txt', 'cat netlify.toml', 'curl https://example.com']) {
    assert.equal(check('PowerShell', shell(cmd), WS), null, cmd);
  }
  assert.equal(check('Read', write('C:/anything'), WS), null);
});

// [늘 남김] 없으면 놓치는 실수: 막지 않을 때도 훅이 거부 결정을 내어 업무 세션의 모든 명령이 막힌다(훅이 도구를 잘못 막음).
test('as a hook it prints a deny decision only when blocking', () => {
  const run = (input: object) =>
    execFileSync('node', [path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-folder-guard.mjs'), WS], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.match(run({ tool_name: 'Bash', tool_input: shell('git push') }), /"permissionDecision":"deny"/);
  assert.equal(run({ tool_name: 'Bash', tool_input: shell('git status') }), '');
});

test('the secretary folder: only its bin entries may be called; anything else in it, or a write next to it, is blocked', () => {
  const sec = PROJECT_ROOT;
  const short = 'C:\\PROGRA~9\\SECRET~1';
  const opts = { secretary: [sec, short] };
  const run = (cmd: string, tool = 'PowerShell') => check(tool, shell(cmd), WS, opts);
  const bin = (name: string, root = sec) => path.join(root, 'bin', name);
  // Calling an entry, in any form a command writes it: quoted, forward slashes, Git Bash, the short name, the variables.
  for (const cmd of [
    `& "${bin('run-job.ps1')}" -Model sonnet -PromptFile p.txt 2>&1`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File ${bin('run-job.ps1')} -Model sonnet > out.txt`,
    `node "${bin('ego-grab.mjs').replace(/\\/g, '/')}" https://example.com`,
    `node "/${sec[0].toLowerCase()}${sec.slice(2).replace(/\\/g, '/')}/bin/ego-grab.mjs"`,
    `& "${short}\\bin\\run-job.ps1" -Model sonnet`,
    '& "$env:SECRETARY_AB12_DIR\\bin\\run-job.ps1" -Model sonnet',
    'python tool.py',
    'git status',
  ])
    assert.equal(run(cmd), null, cmd);
  // Anything else of the secretary folder: running its code, reading or changing its files, a write next to an entry.
  for (const cmd of [
    `node "${path.join(sec, 'src', 'cli.ts')}" stats`,
    `node ${path.join(sec, 'src', 'cli.ts').replace(/\\/g, '/')} board`,
    `Get-Content ${path.join(sec, 'AGENTS.md')}`,
    `cat "${short}\\secretary.db"`,
    `echo x > "${bin('run-job.ps1')}"`,
    `Copy-Item evil.ps1 "${bin('run-job.ps1')}"`,
    `& "${bin('not-an-entry.ps1')}"`,
    `cd "${sec}"`,
    'node "$env:SECRETARY_AB12_DIR\\src\\cli.ts" memory-stats',
    'Get-ChildItem $env:SECRETARY_DIR',
    `node ..\\..\\${path.basename(sec)}\\src\\cli.ts memory-stats`,
  ])
    assert.match(run(cmd) ?? '', /비서 폴더는 진입점\(bin\\<이름>\)을 부르는 것만 된다/, cmd);
  assert.match(run(`cat ${path.join(sec, 'README.md').replace(/\\/g, '/')}`, 'Bash') ?? '', /진입점/);
  // A folder that only starts like it is another folder; without --secretary nothing of this applies.
  assert.equal(run(`Get-Content "${sec}-2\\notes.md"`), null);
  assert.equal(check('PowerShell', shell(`node "${path.join(sec, 'src', 'cli.ts')}"`), WS), null);
});

test('as a hook it takes the secretary folders after --secretary (start-worker passes the long and the short name)', () => {
  const run = (input: object) =>
    execFileSync('node', [path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-folder-guard.mjs'), WS, '--lock-tests', '--secretary', PROJECT_ROOT, '--secretary', 'C:\\X~1'], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    });
  assert.match(run({ tool_name: 'PowerShell', tool_input: shell(`node "${path.join(PROJECT_ROOT, 'src', 'cli.ts')}" stats`) }), /"permissionDecision":"deny"/);
  assert.match(run({ tool_name: 'Bash', tool_input: shell('cat C:/X~1/AGENTS.md') }), /"permissionDecision":"deny"/);
  assert.equal(run({ tool_name: 'PowerShell', tool_input: shell(`& "${path.join(PROJECT_ROOT, 'bin', 'run-job.ps1')}" -Model sonnet`) }), '');
  // --lock-tests is still read with --secretary after it.
  assert.match(run({ tool_name: 'Edit', tool_input: { file_path: path.join(WS, 'tests', 'a.ts') } }), /테스트 잠금/);
  assert.deepEqual(parseArgs(['ws', '--secretary', 'A', '--lock-tests', '--secretary', 'B']), { folder: 'ws', lockTests: true, secretary: ['A', 'B'] });
});

test('start-worker hands the hook this secretary folder, long and 8.3 short name (worker-lib.ps1 Get-SecretaryGuardArgs)', { skip: process.platform !== 'win32' }, () => {
  const lib = path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-lib.ps1');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${lib}'; Get-SecretaryGuardArgs`], { encoding: 'utf8' }).trim();
  assert.ok(out.startsWith(`--secretary "${PROJECT_ROOT}"`), out);
  const forms = [...out.matchAll(/--secretary "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(forms.length >= 1 && forms.length <= 2, out);
  for (const f of forms) assert.equal(fs.realpathSync.native(f).toLowerCase(), fs.realpathSync.native(PROJECT_ROOT).toLowerCase());
});
