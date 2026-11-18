import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';

// Without it: a provider with no personalDataAllowed (a gateway, a free plan, a new entry) is taken as allowed and gets the memory
// tools or runs in the secretary folder, or a paid one (anthropic-api) is still blocked as "not a subscription" (2026-11-13 decision).
test('personalDataAllowed: only true lets a provider have the memory read tools (Claude Code only) and run in the secretary folder', { skip: process.platform !== 'win32' }, () => {
  const root = tempDir();
  const keys = tempDir();
  const other = tempDir();
  const lib = path.join(root, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['common.ps1', 'this-secretary.ps1', 'providers.ps1', 'memory-mcp.ps1']) fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'lib', f), path.join(lib, f));
  fs.mkdirSync(path.join(root, 'scripts', 'worker'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-permissions.json'), path.join(root, 'scripts', 'worker', 'worker-permissions.json'));
  fs.writeFileSync(
    path.join(lib, 'providers.json'),
    JSON.stringify({
      providers: {
        subscription: { type: 'claude-subscription', personalDataAllowed: true },
        api: { type: 'claude-api-key', personalDataAllowed: true, keyFile: 'api-key-*.env' },
        gw: { type: 'claude-gateway', personalDataAllowed: false, base_url: 'https://gw.example/v1' },
        unset: { type: 'claude-api-key' },
        text: { type: 'claude-api-key', personalDataAllowed: 'true' },
        agy: { type: 'antigravity-cli', personalDataAllowed: true },
      },
    }),
  );
  for (const f of ['api-key-x.env', 'gw.env', 'unset.env', 'text.env']) fs.writeFileSync(path.join(keys, f), 'K=1\n');
  const env: NodeJS.ProcessEnv = { ...process.env, SECRETARY_KEYS_DIR: keys };
  delete env.CLAUDE_CONFIG_DIR;
  const folder = (name: string, dir: string) => `try { Assert-SecretaryFolderProvider (Use-Provider ${name}) '${dir}'; '${name} ok' } catch { '${name} blocked' }`;
  const lines = [
    `. '${path.join(lib, 'common.ps1')}'`,
    `. '${path.join(lib, 'providers.ps1')}'`,
    `. '${path.join(lib, 'memory-mcp.ps1')}'`,
    `foreach ($n in 'subscription', 'api', 'gw', 'unset', 'text', 'agy') { $i = Use-Provider $n; "$n|$($i.PersonalDataAllowed)|$(Test-MemoryMcp $i)" }`,
    folder('gw', root),
    folder('unset', root),
    folder('api', root),
    folder('gw', other),
    // 없으면 놓치는 실수: 개인정보를 넣으면 안 되는 공급자의 업무 세션·run-job 폴더 훅에 읽기 제한(--limit-reads, Read·Grep·Glob)이 빠지거나,
    // 개인정보를 넣어도 되는 공급자의 세션까지 읽기가 막힌다.
    `foreach ($n in 'gw', 'unset', 'api', 'subscription') { $h = Get-FolderGuardHook (Use-Provider $n) '${other}\\' -LockTests; "$n|$($h.matcher)|$($h.hooks[0].command -match ' --limit-reads --read-root ')|$($h.hooks[0].command -match '--lock-tests')" }`,
    // 없으면 놓치는 실수: run-job에는 폴더 훅이 없어 개인정보를 넣으면 안 되는 공급자의 run-job이 작업 폴더 밖 개인 자료를 읽거나,
    // 개인정보를 넣어도 되는 공급자(API 키)의 run-job까지 훅이 붙어 작업 폴더 밖 원본을 읽는 일이 막힌다. 되풀이 알림 훅은 그대로 남는다.
    `foreach ($n in 'gw', 'api') { $p = Get-RunJobPermissions (Use-Provider $n) '${other}' @([pscustomobject]@{ matcher = 'Bash' }); "$n|$($null -ne $p.hooks.PreToolUse)|$(if ($p.hooks.PreToolUse) { $p.hooks.PreToolUse[0].hooks[0].command -match [regex]::Escape('"${other}"') } else { $false })|$(@($p.hooks.PostToolUse).Count)|$(@($p.permissions.allow).Count -gt 10)" }`,
    `"none|$((Get-RunJobPermissions (Use-Provider api) '${other}').PSObject.Properties.Name -contains 'hooks')"`,
    // 없으면 놓치는 실수: 기본 작업 폴더에서 도는 그런 공급자의 run-job이 결과 폴더 없이 _run-job-home 전체를 읽거나, 결과 폴더가 작업 폴더 밖을 가리키거나,
    // -Folder로 공간을 준 run-job·개인정보를 넣어도 되는 공급자의 run-job까지 결과 폴더를 요구받는다.
    `foreach ($c in @(@('gw', '', $false), @('api', '', $false), @('gw', 'output\\research\\x', $false), @('gw', '..\\out', $false), @('gw', 'x', $true), @('gw', '', $true))) { try { "rd|$($c[0])|$($c[1])|$($c[2])|$(Resolve-RunJobReadDir (Use-Provider $c[0]) '${other}' $c[1] $c[2])" } catch { "rd|$($c[0])|$($c[1])|$($c[2])|멈춤" } }`,
    `$c = (Get-RunJobPermissions (Use-Provider gw) '${other}' @() '${path.join(other, 'output', 'research', 'x')}').hooks.PreToolUse[0].hooks[0].command; "scope|$($c -match [regex]::Escape(' --read-scope "${path.join(other, 'output', 'research', 'x')}" --read-scope "${path.join(other, 'AGENTS.md')}"'))|$($c -match [regex]::Escape(' --sibling-private "${path.join(other, 'output', 'research', 'x')}"'))"`,
    // 없으면 놓치는 실수: 업무 세션과 run-job이 설정을 따로 만들어 한쪽(run-job)에만 작업 폴더 전체 경로의 Edit 규칙이 빠지고(cd 뒤 그 폴더의 다른 곳이 막힘),
    // 구독 설정에 빈 hooks가 들어가거나, cli를 못 띄운 부르기가 예외로 스크립트를 멈춘다.
    `$e1 = @((Get-RunJobPermissions (Use-Provider api) '${other}').permissions.allow) -contains '${'Edit(//' + other[0].toLowerCase() + other.slice(2).replace(/\\/g, '/') + '/**)'}'`,
    `$e2 = @((New-ClaudeRunSettings -Permissions -EditFolder '\\\\server\\share').permissions.allow | Where-Object { $_ -like 'Edit(//*' }).Count`,
    `$e3 = (New-ClaudeRunSettings).PSObject.Properties.Name -contains 'hooks'`,
    `"edit|$e1|$e2|$e3"`,
    `$r = Invoke-SecretaryCli @('no-such-command'); "cli|$($r.code -ne 0)|$(@($r.err).Count -gt 0)"`,
  ];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('; ')], { encoding: 'utf8', env }).trim().split(/\r?\n/);
  assert.deepEqual(out, [
    'subscription|True|True',
    'api|True|True',
    'gw|False|False',
    'unset|False|False',
    'text|False|False',
    // Another company's CLI: allowed, but it has no per-run MCP option, so no memory tools.
    'agy|True|False',
    'gw blocked',
    'unset blocked',
    'api ok',
    'gw ok',
    'gw|Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob|True|True',
    'unset|Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob|True|True',
    'api|Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|False|True',
    'subscription|Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|False|True',
    'gw|True|True|1|True',
    'api|False|False|1|True',
    'none|False',
    'rd|gw||False|멈춤',
    'rd|api||False|',
    `rd|gw|output\\research\\x|False|${path.join(other, 'output', 'research', 'x')}`,
    'rd|gw|..\\out|False|멈춤',
    'rd|gw|x|True|멈춤',
    'rd|gw||True|',
    'scope|True|True',
    'edit|True|0|False',
    'cli|True|True',
  ]);
  assert.ok(fs.statSync(path.join(other, 'output', 'research', 'x')).isDirectory(), 'the result folder is made when missing');
});
