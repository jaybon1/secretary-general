import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir, testStore, write } from './helpers.ts';

const lib = path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-lib.ps1');

// 없으면 놓치는 실수: Haiku가 메시지를 못 보냈을 때 세션이 떠 있는데도(또는 떠 있는지 모르는데도) --bg --resume으로 깨워, 다른 id의 사본 세션이 뜬다.
test('send-worker wakes a session only when the list shows it off (no status), not when it is up or the list cannot be read', { skip: process.platform !== 'win32' }, () => {
  const home = tempDir();
  const cwd = tempDir();
  const fake = path.join(home, 'fake-claude.ps1');
  const wakeLog = path.join(home, 'wake.txt');
  const promptLog = path.join(home, 'prompt.txt');
  // The Haiku send answers FAKE_ANSWER (default '못 찾음': it never reaches the session) and logs its prompt; a wake logs its
  // arguments and answers like claude --bg.
  write(
    fake,
    [
      `if ($args[0] -eq '--bg') { Add-Content -LiteralPath '${wakeLog}' -Value ($args -join ' ') -Encoding UTF8; 'backgrounded 90000001'; exit 0 }`,
      `Set-Content -LiteralPath '${promptLog}' -Value $args[-1] -Encoding UTF8`,
      "if ($env:FAKE_ANSWER) { $env:FAKE_ANSWER } else { '못 찾음' }",
      'exit 0',
    ].join('\r\n'),
  );
  const entry = (extra: object) => ({ id: '90000001', sessionId: '90000001-0000-4000-8000-000000000001', name: 'w-test', kind: 'background', cwd, ...extra });
  const temp = tempDir();
  // A session no start-worker record names counts as on a provider personal data may not go to: the message is checked against a DB.
  const db = path.join(tempDir(), 'p.db');
  testStore(db).db.close();
  const run = (list: object | 'error-second', answer = '', send = "Send-Worker 'bg:90000001' 'hello'") => {
    const agentsFile = path.join(home, 'agents.json');
    fs.writeFileSync(agentsFile, JSON.stringify([list === 'error-second' ? entry({ state: 'working' }) : list]));
    // The list comes from a file through the real worker-agent (no claude agents in tests); 'error-second' fails the re-read.
    const script = [
      `$env:USERPROFILE = '${home}'; $env:SECRETARY_KEYS_DIR = '${home}'; $env:TEMP = '${temp}'; $env:FAKE_ANSWER = '${answer}'; $env:SECRETARY_DB = '${db}'`,
      `function Initialize-ClaudeScript { '${fake}' }`,
      '$global:reads = 0',
      `function Get-WorkerAgent([string]$Claude, [string]$Id) { $global:reads++; if (${list === 'error-second' ? '$true' : '$false'} -and $global:reads -gt 1) { throw '업무 세션 목록(claude agents --json)을 못 읽었어요: test' }; $o = & node --no-warnings '${path.join(PROJECT_ROOT, 'src', 'cli.ts')}' worker-agent $Id --agents-file '${agentsFile}'; if ($LASTEXITCODE -eq 2) { return $null }; ($o -join [char]10) | ConvertFrom-Json }`,
      send,
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${lib}'; ${script}`], { encoding: 'utf8' });
    const woke = fs.existsSync(wakeLog) ? fs.readFileSync(wakeLog, 'utf8') : '';
    fs.rmSync(wakeLog, { force: true });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, woke: !!woke, wake: woke };
  };
  const up = run(entry({ status: 'idle', pid: 4242, state: 'done' }));
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /못 보냄: 세션이 떠 있는데 메시지가 닿지 않음/);
  assert.equal(up.woke, false, 'a session that is up is not woken (a copy would start)');
  const unknown = run('error-second');
  assert.equal(unknown.code, 1, unknown.out);
  assert.match(unknown.out, /못 보냄: 세션이 떠 있는지 확인하지 못해 깨우지 않음/);
  assert.equal(unknown.woke, false, 'a list that cannot be read wakes nothing');
  // Off: the background service's entry has no status and no pid, only its last state.
  const off = run(entry({ state: 'working' }));
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /깨워서 보냄/);
  assert.equal(off.woke, true);
  // The wake carries the one line that points at the message file, not the message itself.
  assert.match(off.wake, /비서 메시지: .*secretary-worker-messages.*\.md 파일을 Read/);
});

// 없으면 놓치는 실수: start-worker -Prompt가 큰따옴표를 작은따옴표로, 줄바꿈을 공백으로 바꿔 지시가 원문과 다르게 닿거나, 개인정보를 넣으면 안 되는
// 공급자의 업무 세션이 읽기 제한 때문에 그 지시 파일을 못 읽거나, 그런 공급자로 기억 번호가 든 지시가 그대로 나가거나, 메시지 파일이 끝없이 쌓인다.
test('start-worker -PromptFile: the brief reaches a new session word for word through a file it may read; a brief with a record number never starts; old message folders go', { skip: process.platform !== 'win32' }, () => {
  const home = tempDir();
  const temp = tempDir();
  const space = tempDir();
  const fake = path.join(home, 'fake-claude.ps1');
  const argsLog = path.join(home, 'args.txt');
  write(fake, [`Set-Content -LiteralPath '${argsLog}' -Value ($args -join [char]10) -Encoding UTF8`, "'backgrounded · 90000002 · w-test'", 'exit 0'].join('\r\n'));
  const db = path.join(tempDir(), 'p.db');
  testStore(db).db.close();
  // A message folder last written 40 days ago, and one written now.
  const msgRoot = path.join(temp, 'secretary-worker-messages');
  write(path.join(msgRoot, 'old-session', 'a.md'), 'old');
  write(path.join(msgRoot, 'new-session', 'b.md'), 'new');
  const old = new Date(Date.now() - 40 * 86400_000);
  fs.utimesSync(path.join(msgRoot, 'old-session', 'a.md'), old, old);
  fs.utimesSync(path.join(msgRoot, 'old-session'), old, old);
  const start = (brief: string) => {
    const file = path.join(home, 'brief.md');
    fs.writeFileSync(file, brief);
    fs.rmSync(argsLog, { force: true });
    const script = [
      `$env:USERPROFILE = '${home}'; $env:TEMP = '${temp}'; $env:SECRETARY_DB = '${db}'`,
      `function Initialize-ClaudeScript { '${fake}' }`,
      "function Use-Provider([string]$Name) { [pscustomobject]@{ Name = 'gw-test'; Type = 'claude-gateway'; Models = $null; Effort = $null; PersonalDataAllowed = $false } }",
      `Start-Worker -Folder '${space}' -Name 'w-test' -PromptFile '${file}'`,
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${lib}'; ${script}`], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, args: fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').replace(/^\uFEFF/, '') : null };
  };
  const blocked = start('근거 대화 #900126을 보고 만든다.');
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.out, /개인정보가 있어 멈췄어요[^]*#900126/);
  assert.equal(blocked.args, null, 'no session started');
  const brief = '제목은 "카페 소개"로 한다.\n  들여쓴 둘째 줄과 $env:X 글도 그대로.';
  const ok = start(brief);
  assert.equal(ok.code, 0, ok.out);
  const file = /비서 메시지: (.+?\.md) 파일을 Read/.exec(ok.args ?? '')?.[1] ?? '';
  assert.ok(file.startsWith(path.join(msgRoot, 'start-w-test-')), `${file}\n${ok.args}`);
  assert.equal(fs.readFileSync(file, 'utf8'), brief);
  assert.doesNotMatch(ok.args ?? '', /카페 소개/, 'the argument carries the pointer, not the brief');
  // The read-limit hook of this session lets it read that folder.
  const settings = JSON.parse(fs.readFileSync(path.join(temp, 'worker-settings-w-test.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(` --read-root "${path.dirname(file)}"`), settings.hooks.PreToolUse[0].hooks[0].command);
  assert.equal(fs.existsSync(path.join(msgRoot, 'old-session')), false, 'a folder untouched 30 days goes');
  assert.ok(fs.existsSync(path.join(msgRoot, 'new-session', 'b.md')));
});
