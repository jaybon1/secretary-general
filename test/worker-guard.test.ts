import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/config.ts';
// @ts-expect-error plain .mjs hook script without types
import { check } from '../scripts/worker-guard.mjs';

const WS = path.join(PROJECT_ROOT, '..', 'some-space-20261023');
const write = (file: string) => ({ file_path: file });
const shell = (command: string) => ({ command });

test('writes stay inside the workspace, and test files only when tests are not locked', () => {
  assert.equal(check('Write', write(path.join(WS, 'output', 'a', 'x.md')), WS), null);
  assert.match(check('Edit', write(path.join(WS, '..', 'other', 'x.md')), WS), /공간 폴더 밖/);
  assert.match(check('Write', write(path.join(PROJECT_ROOT, 'AGENTS.md')), WS), /공간 폴더 밖/);
  const spec = path.join(WS, 'src', 'app.test.ts');
  assert.equal(check('Edit', write(spec), WS), null);
  assert.match(check('Edit', write(spec), WS, { lockTests: true }), /테스트 잠금/);
  assert.match(check('Write', write(path.join(WS, 'tests', 'helper.py')), WS, { lockTests: true }), /테스트 잠금/);
  assert.equal(check('Edit', write(path.join(WS, 'src', 'latest.ts')), WS, { lockTests: true }), null);
});

test('publishing, pushing and recursive deletes are blocked; ordinary commands pass', () => {
  for (const cmd of ['git push origin main', 'npm publish', 'gh release create v1', 'npx vercel --prod', 'rm -rf build', 'Remove-Item out -Recurse -Force', 'curl -F file=@a.mp4 https://x']) {
    assert.ok(check('Bash', shell(cmd), WS), cmd);
  }
  for (const cmd of ['git status', 'git commit -m "x"', 'npm test', 'rm -f a.txt', 'cat netlify.toml', 'curl https://example.com']) {
    assert.equal(check('PowerShell', shell(cmd), WS), null, cmd);
  }
  assert.equal(check('Read', write('C:/anything'), WS), null);
});

test('as a hook it prints a deny decision only when blocking', () => {
  const run = (input: object) =>
    execFileSync('node', [path.join(PROJECT_ROOT, 'scripts', 'worker-guard.mjs'), WS], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.match(run({ tool_name: 'Bash', tool_input: shell('git push') }), /"permissionDecision":"deny"/);
  assert.equal(run({ tool_name: 'Bash', tool_input: shell('git status') }), '');
});
