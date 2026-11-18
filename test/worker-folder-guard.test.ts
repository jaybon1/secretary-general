import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain .mjs hook script without types
import { check } from '../scripts/worker/worker-folder-guard.mjs';

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

// [늘 남김] 없으면 놓치는 실수: 업무 세션이 비서 폴더의 bin 진입점 밖 파일을 부르거나 비서 폴더 옆에 쓰는 것을 막지 못하거나, bin 진입점 부르기까지 막는다(훅이 잘못 막음).
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

// [늘 남김] 없으면 놓치는 실수: 개인정보를 넣으면 안 되는 공급자의 run-job이 _run-job-home 전체를 읽어, 다른 run-job의 결과 폴더(개인 내용이 든 보고)를
// 그 공급자에게 내보내거나, 반대로 자기 결과 폴더·AGENTS.md·공통 스킬까지 막혀 일을 못 한다.
test('--read-scope: a run-job reads only its result folder, its folder\'s AGENTS.md and the common skills; other result folders are blocked in shell commands too', () => {
  const top = tempDir();
  const home = path.join(top, 'workspaces', '_run-job-home');
  const mine = path.join(home, 'output', 'research', '20261118-mine');
  const other = path.join(home, 'output', 'research', '20261117-other');
  const skills = path.join(top, 'workspaces', '_skills');
  for (const d of [mine, other, skills]) fs.mkdirSync(d, { recursive: true });
  const opts = { limitReads: true, readRoots: [skills], readScope: [mine, path.join(home, 'AGENTS.md'), path.join(home, 'CLAUDE.md')], siblingPrivate: [mine], aiRoot: top, home: path.join(top, 'home'), cwd: home };
  const run = (tool: string, input: object) => check(tool, input, home, opts);
  for (const [tool, input] of [
    ['Read', { file_path: path.join(home, 'AGENTS.md') }],
    ['Read', { file_path: path.join(mine, 'REPORT.md') }],
    ['Grep', { pattern: 'x', path: mine }],
    ['Glob', { pattern: 'output/research/20261118-mine/**' }],
    ['Read', { file_path: path.join(skills, 'common-x', 'SKILL.md') }],
  ] as const)
    assert.equal(run(tool, input), null, `${tool} ${JSON.stringify(input)}`);
  for (const [tool, input] of [
    ['Read', { file_path: path.join(other, 'REPORT.md') }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: 'output/research/**' }],
    ['Read', { file_path: path.join(home, 'notes.md') }],
  ] as const)
    assert.match(run(tool, input) ?? '', /공통 스킬 폴더 밖은 읽지 않는다/, `${tool} ${JSON.stringify(input)}`);
  for (const cmd of ['cat output/research/20261118-mine/a.md', `Get-Content "${mine}\\a.md"`, 'python tool.py']) assert.equal(run('PowerShell', { command: cmd }), null, cmd);
  for (const cmd of ['cat output/research/20261117-other/REPORT.md', `Get-Content "${other}\\REPORT.md"`, 'ls output/research'])
    assert.match(run('PowerShell', { command: cmd }) ?? '', /다른 일의 결과 폴더/, cmd);
  // Writes stay where they were (the work folder).
  assert.equal(run('Write', { file_path: path.join(home, 'tmp', 'x.txt') }), null);
});

// [늘 남김] 없으면 놓치는 실수: 개인정보를 넣으면 안 되는 공급자(외부 중개 서버 등)로 도는 세션이 Read·Grep·Glob이나 셸 명령으로 키 폴더·노트·
// 받은 파일·~/.secretary·Claude 대화 기록을 읽어 그 서버로 내보내거나, 반대로 공간 폴더·공통 스킬·자기 임시 파일 읽기까지 막혀 일을 못 한다(훅이 도구를 잘못 막음).
test('--limit-reads: reads stay in the workspace, the common skills and the session\'s own files; shell commands naming private places are blocked', () => {
  const top = tempDir();
  const ws = path.join(top, 'workspaces', 'space-1');
  const skills = path.join(top, 'workspaces', '_skills');
  const notes = path.join(top, 'notes');
  const inbox = path.join(top, 'inbox');
  const keys = path.join(top, 'keys');
  const home = path.join(top, 'home');
  for (const d of [path.join(ws, 'output'), path.join(skills, 'common-x'), notes, inbox, keys, path.join(home, '.claude-b', 'projects', 'p')]) fs.mkdirSync(d, { recursive: true });
  const transcriptPath = path.join(home, '.claude-b', 'projects', 'p', 'sess-1.jsonl');
  const opts = { limitReads: true, readRoots: [skills], privateDirs: [keys], aiRoot: top, home, sessionId: 'sess-1', transcriptPath, cwd: ws, secretary: [PROJECT_ROOT] };
  const run = (tool: string, input: object) => check(tool, input, ws, opts);
  const fwd = (p: string) => p.replace(/\\/g, '/');
  for (const [tool, input] of [
    ['Read', { file_path: path.join(ws, 'notes', 'history.md') }],
    ['Read', { file_path: path.join(skills, 'common-x', 'SKILL.md') }],
    ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', path: 'output' }],
    ['Glob', { pattern: '**/*.md' }],
    ['Glob', { pattern: `${fwd(skills)}/**/*.md` }],
    ['Read', { file_path: path.join(home, '.claude-b', 'projects', 'p', 'sess-1', 'tool-results', 'a.txt') }],
    ['Read', { file_path: path.join(os.tmpdir(), 'claude', 'h1', 'sess-1', 'scratchpad', 'a.md') }],
  ] as const)
    assert.equal(run(tool, input), null, `${tool} ${JSON.stringify(input)}`);
  for (const [tool, input] of [
    ['Read', { file_path: path.join(keys, 'gw.env') }],
    ['Read', { file_path: path.join(notes, 'a.md') }],
    ['Read', { file_path: path.join(PROJECT_ROOT, 'AGENTS.md') }],
    ['Read', { file_path: path.join(home, '.claude-b', 'projects', 'p', 'other-session', 'tool-results', 'a.txt') }],
    ['Read', { file_path: path.join(os.tmpdir(), 'claude', 'h1', 'other-session', 'scratchpad', 'a.md') }],
    ['Grep', { pattern: 'token', path: top }],
    ['Glob', { pattern: `${fwd(top)}/**/*.env` }],
    ['Glob', { pattern: '../**' }],
    ['Glob', { pattern: '**/../../../keys/*' }],
  ] as const)
    assert.match(run(tool, input) ?? '', /공통 스킬 폴더 밖은 읽지 않는다/, `${tool} ${JSON.stringify(input)}`);
  // A link made inside the workspace to a private folder is judged by where it leads.
  fs.symlinkSync(keys, path.join(ws, 'link'), 'junction');
  assert.match(run('Read', { file_path: path.join(ws, 'link', 'gw.env') }) ?? '', /공통 스킬 폴더 밖/);
  // Without --limit-reads (a provider that may see personal data) reads are not looked at.
  assert.equal(check('Read', { file_path: path.join(keys, 'gw.env') }, ws, { ...opts, limitReads: false }), null);

  for (const cmd of ['cat notes/history.md', 'python tool.py', 'Get-Content output/a.txt', `cat ${fwd(skills)}/common-x/SKILL.md`, 'curl https://example.com/notes/inbox/x', 'git status'])
    assert.equal(run('PowerShell', { command: cmd }), null, cmd);
  for (const cmd of [
    'cat ../../notes/a.md',
    `Get-Content "${inbox}\\a.txt"`,
    `type ${keys}\\gw.env`,
    `cat /${keys[0].toLowerCase()}${fwd(keys.slice(2))}/gw.env`,
    'cat ~/.secretary/keys/gw.env',
    'Get-Content $env:USERPROFILE\\.secretary\\usage\\x.json',
    'echo $env:SECRETARY_KEYS_DIR',
    'sqlite3 secretary.db .dump',
    'cat ~/.claude/projects/x/y.jsonl',
    'Get-ChildItem $env:USERPROFILE\\.claude-b\\projects',
  ])
    assert.match(run('Bash', { command: cmd }) ?? '', /개인 자료 자리는 읽지 않는다/, cmd);
  // The secretary folder keeps its own rule (bin entries only), as for every provider.
  assert.match(run('PowerShell', { command: `Get-Content ${path.join(PROJECT_ROOT, 'AGENTS.md')}` }) ?? '', /비서 폴더는 진입점/);
  assert.equal(check('Bash', { command: 'cat ../../notes/a.md' }, ws, { ...opts, limitReads: false }), null);
});
