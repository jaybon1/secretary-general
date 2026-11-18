import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workerStatus, type AgentEntry, type WorkerJob } from '../src/workspace/worker-status.ts';
import { tempDir } from './helpers.ts';

// The watcher's verdict (src/workspace/worker-status.ts). Entries and job files are shaped like what Claude Code wrote
// in a test (status waiting / waitingFor "permission prompt" / tempo blocked); ids, paths and words are made up.
const SHORT = 'abcd1234';
const UUID = `${SHORT}-0000-4000-8000-000000000000`;
const line = (o: object) => JSON.stringify({ sessionId: UUID, timestamp: '2026-11-14T05:00:00.000Z', ...o });
const say = (id: string, content: object[]) => line({ type: 'assistant', uuid: `${id}-1`, message: { id, role: 'assistant', content } });
const writeTool = say('m2', [{ type: 'tool_use', id: 't1', name: 'PowerShell', input: { command: 'Set-Content -Path .\\note.txt -Value x', description: '메모 파일 쓰기' } }]);

/** A config folder with the session's transcript (lines given) and job file (when given). */
function config(lines: string[] | null, job?: WorkerJob) {
  const dir = tempDir('worker-status-');
  if (lines) {
    const file = path.join(dir, 'projects', 'C--work-space', `${UUID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...lines, ''].join('\n'));
  }
  if (job) {
    fs.mkdirSync(path.join(dir, 'jobs', SHORT), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jobs', SHORT, 'state.json'), JSON.stringify(job));
  }
  return dir;
}
const entry = (o: AgentEntry): AgentEntry[] => [{ id: 'ffff0000', sessionId: 'ffff0000-0000-4000-8000-000000000000', status: 'busy' }, { id: SHORT, sessionId: UUID, pid: 4242, cwd: 'C:\\work\\space', ...o }];
const transcript = [line({ type: 'user', message: { role: 'user', content: '메모를 써 주세요' } }), say('m1', [{ type: 'text', text: '메모를 쓸게요.' }]), writeTool];

// 없으면 놓치는 실수: 끝난 명령이 멈춘 채 남아 목록이 busy로 50분 남은 업무 세션을 모니터링이 쉼으로 못 본다.
// 반대로 뒤에서 도는 명령을 기다리는 세션(state working)이나 모델이 아직 도는 세션(tempo active)을 쉼으로 본다.
test('rest: any status but busy and waiting, or busy with the model resting and an answer out; a background command left is listed', () => {
  const ask = [...transcript, line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), say('m3', [{ type: 'text', text: '[질문] 메모 이름을 정해 주세요\n1. a\n2. 기타 (직접 입력)' }])];
  const leftover: WorkerJob = { state: 'done', tempo: 'idle', fan: [{ id: 'b900001', kind: 'shell', label: `cd /c/x && cat > make.ps1 <<EOF\n${'x'.repeat(100)}` }] };
  const busyRest = workerStatus({ configDir: config(ask, leftover), id: SHORT, agents: entry({ status: 'busy', state: 'working' }) });
  assert.deepEqual([busyRest.verdict, busyRest.restState, busyRest.asks], ['rest', 'done', true]);
  assert.equal(busyRest.leftover.length, 1);
  assert.match(busyRest.leftover[0], /^shell b900001: cd \/c\/x && cat > make\.ps1 <<EOF x+…$/);
  const idle = workerStatus({ configDir: config(transcript), id: SHORT, agents: entry({ status: 'idle', state: 'done' }) });
  assert.deepEqual([idle.verdict, idle.restState, idle.asks, idle.leftover], ['rest', 'done', false, []]);
  assert.match(idle.notes.join(' '), /state\.json/);
  const blocked = workerStatus({ configDir: config(transcript, { state: 'blocked', tempo: 'blocked' }), id: SHORT, agents: entry({ status: 'busy' }) });
  assert.deepEqual([blocked.verdict, blocked.restState], ['rest', 'blocked']);
  // Working: waiting for its own background command, the model still running, no job file while busy.
  for (const job of [{ state: 'working', tempo: 'idle' }, { state: 'done', tempo: 'active' }, undefined]) {
    assert.equal(workerStatus({ configDir: config(transcript, job), id: SHORT, agents: entry({ status: 'busy' }) }).verdict, 'working', JSON.stringify(job));
  }
  // An entry with only id and state (its service seems off): its state, or the job file's, says rest.
  const off = workerStatus({ configDir: config(transcript), id: SHORT, agents: [{ id: SHORT, state: 'done' }] });
  assert.deepEqual([off.verdict, off.restState, off.status], ['rest', 'done', '']);
});
