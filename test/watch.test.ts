import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir, tempStore } from './helpers.ts';
import { lastAnswerAsks, markAnswered, markAskingFromTranscript, refMatches } from '../src/workspace/worker-asking.ts';
import { findTranscript } from '../src/core/transcript.ts';

// 없으면 놓치는 실수: 업무 세션이 [질문]으로 멈췄는데 업무 상태가 running으로 남아, 할 일 요약·대시보드가 질문 대기를 못 보여 주고 모니터링을 다시 띄울 대상에 남는다.
// 화면보다 긴 [질문](선택지가 많은 질문)은 claude logs 화면 글에서 밀려나 놓쳤으므로 대화 기록 jsonl로 본다.
// 반대로 지난 [질문] 뒤에 다시 일하는 세션이나 이미 끝난(done) 업무까지 asking으로 바꾼다.
test('a work session whose transcript ends on a [질문] puts its running task to asking; other transcripts and statuses are left alone', () => {
  const say = (...texts: string[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: texts.map((text) => ({ type: 'text', text })) } });
  const tool = (input: object) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input }] } });
  const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  const prompt = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const longChoices = Array.from({ length: 60 }, (_, i) => `${i + 1}. 선택지 ${i + 1}`).join('\n');
  const asks = [prompt('계획을 써 주세요'), say('plan.md를 썼어요.'), tool({ file_path: 'plan.md' }), result, say(`[질문] 계획 승인\n${longChoices}\n61. 기타 (직접 입력)`), JSON.stringify({ type: 'system', subtype: 'turn_duration' })];
  assert.equal(lastAnswerAsks(asks), true);
  // The last text block of the turn decides; an assistant line with only a tool call after it is skipped.
  assert.equal(lastAnswerAsks([say('정리했어요.', '[질문] 어느 쪽으로 할까요?'), tool({ file_path: 'q.md' })]), true);
  // An older [질문] the session went on from, a report, a [질문] inside a tool call, a sub-agent's line: not asking.
  assert.equal(lastAnswerAsks([say('[질문] 계획 승인'), prompt('승인해요'), tool({ command: 'npm test' }), result, say('끝났어요. REPORT.md를 썼어요.')]), false);
  assert.equal(lastAnswerAsks([say('[질문] 계획 승인'), prompt('승인해요')]), false);
  assert.equal(lastAnswerAsks([say('[질문] 어느 쪽?', '끝났어요.')]), false);
  assert.equal(lastAnswerAsks([say('끝났어요.'), tool({ file_path: 'notes/q.md', content: '[질문] 메모' })]), false);
  assert.equal(lastAnswerAsks([say('끝났어요.'), JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '[질문] 하위' }] } })]), false);
  assert.equal(lastAnswerAsks(['{"type":"assist', '']), false);

  assert.equal(refMatches('bg:abcd1234', 'abcd1234'), true);
  assert.equal(refMatches('bg:abcd1234', 'bg:abcd1234'), true);
  assert.equal(refMatches('abcd1234-0000-4000-8000-000000000000', 'abcd1234'), true);
  assert.equal(refMatches('bg:abcd1234', 'ffff0000'), false);
  assert.equal(refMatches(null, 'abcd1234'), false);

  // The transcript is found under the config folder's projects folder by the short id or the full uuid.
  const config = tempDir();
  const projects = path.join(config, 'projects');
  const uuid = 'abcd1234-0000-4000-8000-000000000000';
  const file = path.join(projects, 'C--work-space', `${uuid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [say('끝났어요.'), ''].join('\n'));
  assert.equal(findTranscript(projects, 'bg:abcd1234'), file);
  assert.equal(findTranscript(projects, uuid), file);
  assert.equal(findTranscript(projects, 'ffff0000'), null);
  assert.equal(findTranscript(path.join(projects, 'none'), 'abcd1234'), null);

  const s = tempStore();
  const ws = s.createWorkspace({ kind: 'quick', name: 'quick', title: '간단', purpose: 'p', folder: path.join(tempDir(), 'q'), agents: [] });
  const make = (ref: string, status: 'running' | 'done') => {
    const t = s.createTask({ workspaceId: ws.id, name: `t${Math.random()}`, title: `업무 ${ref}`, goal: 'g', outputDir: `o${Math.random()}` });
    s.updateTask(t.id, { status, sessionRef: ref });
    return t.id;
  };
  const running = make('bg:abcd1234', 'running');
  const done = make('bg:abcd1234', 'done');
  const other = make('bg:ffff0000', 'running');
  assert.deepEqual(markAskingFromTranscript(s, 'abcd1234', config), []);
  assert.equal(s.getTask(running)?.status, 'running');
  // No transcript for the session: nothing changes.
  assert.deepEqual(markAskingFromTranscript(s, 'ffff0000', config), []);
  fs.writeFileSync(file, [...asks, ''].join('\n'));
  const out = markAskingFromTranscript(s, 'abcd1234', config, uuid);
  assert.equal(out.length, 1);
  assert.match(out[0], new RegExp(`업무${running}\\(.*질문 대기\\(asking\\)`));
  assert.deepEqual([s.getTask(running)?.status, s.getTask(done)?.status, s.getTask(other)?.status], ['asking', 'done', 'running']);
  // Already asking: nothing to say the second time.
  assert.deepEqual(markAskingFromTranscript(s, 'abcd1234', config), []);
  // 없으면 놓치는 실수: 비서가 [질문]의 답을 보낸 뒤 상태를 직접 되돌리는 것을 잊어 업무가 질문 대기로 남고, 모니터링을 다시 띄울 대상에서 빠진다.
  // send-worker가 보낸 뒤 부른다(worker-asking <id> --answered): 그 세션의 질문 대기 업무만 진행 중으로, 끝난 업무와 다른 세션은 그대로.
  const answered = markAnswered(s, 'bg:abcd1234');
  assert.equal(answered.length, 1);
  assert.match(answered[0], new RegExp(`업무${running}\\(.*진행 중\\(running\\)`));
  assert.deepEqual([s.getTask(running)?.status, s.getTask(done)?.status, s.getTask(other)?.status], ['running', 'done', 'running']);
  assert.deepEqual(markAnswered(s, 'abcd1234'), [], 'nothing asking any more');
  const lib = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'worker', 'worker-lib.ps1'), 'utf8');
  assert.match(lib, /Invoke-SecretaryCli @\('worker-asking', \$Id, '--answered'\)/);
  assert.equal((lib.match(/; Set-WorkerAnswered \$Id; exit 0/g) ?? []).length, 3, 'every way that ends sent: 보냄, 보냄 not checked, 깨워서 보냄');
  // The watcher hands its config folder to this at idle (and only there), when worker-status saw the [질문].
  const script = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'worker', 'watch-worker.ps1'), 'utf8');
  assert.match(script, /\$cliArgs = @\('worker-asking', \$WorkerId, \(Get-ClaudeConfigDir\)\)/);
  assert.match(script, /idle\(대기\): [^\n]*\r?\n\s*if \(\$st\.asks\) \{ Set-AskingFromTranscript \$Id "\$\(\$st\.sessionId\)" \}\r?\n/);
});