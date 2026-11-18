import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir, write } from './helpers.ts';

const script = path.join(PROJECT_ROOT, 'scripts', 'subagent-report', 'subagent-report.ts');
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ['--no-warnings', script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const line = (o: object) => JSON.stringify(o);
const assistant = (id: string, content: object[]) => line({ type: 'assistant', isSidechain: true, agentId: 'a1', message: { id, role: 'assistant', content } });

// 없으면 놓치는 실수: 비서가 서브에이전트 보고를 REPORT.md로 직접 옮겨 적다가 빠뜨리거나 섞고(보고 길이만큼 출력도 든다),
// 다른 설정 폴더(.claude-b 등)에서 돈 서브에이전트의 기록이나 이미 있는 다른 보고를 덮어쓰는 일을 놓친다.
test('subagent-report saves the last SubagentHandback message word for word, finds it in any config folder, and does not overwrite another report', () => {
  const cfgA = tempDir();
  const cfgB = tempDir();
  const out = tempDir();
  const report = '결론: 다 됐다.\n\n| 표 | 값 |\n|---|---|\n| "따옴표" | `코드` |\n\n끝 줄';
  const jsonl = [
    line({ type: 'user', isSidechain: true, message: { role: 'user', content: '지시' } }),
    assistant('m1', [{ type: 'text', text: '중간 글' }]),
    assistant('m2', [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message: '첫 보고(옛것)' } }]),
    assistant('m3', [{ type: 'tool_use', id: 't2', name: 'SubagentHandback', input: { message: report } }]),
    line({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }),
  ].join('\n');
  // The subagent ran under a second config folder, in some project folder, under some secretary session.
  write(path.join(cfgB, 'projects', 'C--x-secretary', '90000000-0000-4000-8000-000000000001', 'subagents', 'agent-a90000000000001.jsonl'), jsonl + '\n');
  const ok = run('agent-a90000000000001', out, '--config', cfgA, '--config', cfgB);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /SubagentHandback 보고/);
  assert.equal(fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8'), report);
  assert.equal(run('a90000000000001', out, '--config', cfgB).code, 0, 'the same report again is fine');
  // Another report already there: kept unless --force.
  fs.writeFileSync(path.join(out, 'REPORT.md'), '다른 보고');
  const kept = run('a90000000000001', out, '--config', cfgB);
  assert.equal(kept.code, 1, kept.out);
  assert.equal(fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8'), '다른 보고');
  assert.equal(run('a90000000000001', out, '--config', cfgB, '--force').code, 0);
  assert.equal(fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8'), report);
  // No transcript: exit 2, nothing written.
  const none = run('a90000000000999', path.join(out, 'none'), '--config', cfgA);
  assert.equal(none.code, 2, none.out);
  assert.equal(fs.existsSync(path.join(out, 'none')), false);
  // An older subagent without SubagentHandback: its last answer's text (lines of one message put together), said so.
  write(
    path.join(cfgA, 'projects', 'p', 's', 'subagents', 'agent-a90000000000002.jsonl'),
    [assistant('m1', [{ type: 'text', text: '앞 답' }]), assistant('m2', [{ type: 'text', text: '보고 첫 부분' }]), assistant('m2', [{ type: 'text', text: '보고 끝 부분' }])].join('\n') + '\n',
  );
  const old = run('a90000000000002', out, '--config', cfgA, '--name', 'sub-report.md');
  assert.equal(old.code, 0, old.out);
  assert.match(old.out, /마지막 답의 글/);
  assert.equal(fs.readFileSync(path.join(out, 'sub-report.md'), 'utf8'), '보고 첫 부분\n\n보고 끝 부분');
});
