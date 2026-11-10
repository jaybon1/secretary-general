import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { boardChunks, boardPrompt, OK_VERSION_KEY, parseBoard, readBoard, runBoardUpdate, spawnBoardJob } from '../src/session-continuity/situation-board.ts';
import { boardContext, HANDOFF_MARK } from '../src/session-continuity/situation-board-notice.ts';
import { runJobScript } from '../src/staff/launch.ts';
import { assertModelCallsAllowed, NO_MODEL_ENV } from '../src/core/no-model-calls.ts';
import { say, tempStore } from './helpers.ts';

// No real transcripts or Haiku in tests.
const offline = { catchUp: () => 0, spawnJob: () => {} };

const BOARD = '요약: 상황판 시험 중\n## 지금 주제\n상황판 (#2)\n## 진행 중\n없음';

test('parses a board out of run-job output and rejects anything else', () => {
  assert.equal(parseBoard(`${BOARD}\n(새 세션) 세션: abc-123`), BOARD);
  assert.equal(parseBoard(`알겠어요. 아래가 새 판이에요.\n\n${BOARD}`), BOARD);
  assert.equal(parseBoard('Error: rate limited'), null);
});

test('the rewrite reads everything after the board, across sessions', () => {
  const s = tempStore();
  say(s, 'sess-a', 'user', '옛 대화');
  say(s, 'sess-b', 'assistant', '새 대화 1');
  say(s, 'sess-a', 'user', '새 대화 2');
  const first = s.logAfter(0)[0].id;
  const chunks = boardChunks(s, { text: BOARD, lastLogId: first, updatedAt: new Date().toISOString() });
  assert.equal(chunks.length, 1);
  const rows = chunks[0];
  assert.deepEqual(rows.map((r) => r.content), ['새 대화 1', '새 대화 2']);
  const prompt = boardPrompt(undefined, rows, ['- A. 진행할까요?']);
  assert.match(prompt, /\(없음 — 처음 만든다\)/);
  assert.match(prompt, /- A\. 진행할까요\?/);
  assert.match(prompt, /세션 sess-b 비서\]\n새 대화 1/);
  assert.doesNotMatch(prompt, /대화 밖에서 확인된 사실/);
  assert.doesNotMatch(prompt, /\d자 안팎/, 'no character cap: accuracy first, kept short line by line');
  assert.match(prompt, /빠뜨리지 않게 정확히 쓰되, 한 줄에 한 사실을 짧게 쓰고, 같은 내용을 두 칸에 쓰지 않으며, 기억에 이미 저장된 결정은 한 줄 요지와 근거 번호만 쓴다\. 끝난 일·풀린 질문은 남기지 않는다/);
  assert.match(prompt, /큰 일[^\n]*상태[^\n]*상황판에 쓰지 않는다[^\n]*"## 큰 일 바뀐 듯"에만[^\n]*근거 번호/);
  assert.match(prompt, /## 풀린 듯한 질문\n## 큰 일 바뀐 듯\n/);
  // 없으면 놓치는 실수: 무엇이 끝난 뒤로 미룬 일이 때 표시 없이 "다음 행동"에 들어가 비서가 지금 할 일로 권한다.
  assert.match(prompt, /## 정한 것\n## 비서가 확인할 것\n/);
  assert.doesNotMatch(prompt, /## 다음 행동/);
  assert.match(prompt, /"## 비서가 확인할 것"[^\n]*대괄호[^\n]*\[지금\][^\n]*미룬 일을 \[지금\]으로 쓰지 않는다[^\n]*"## 부탁하고 기다리는 것"에만/);
  assert.match(prompt, /\[지금\]이 아닌 줄[^\n]*조건이 채워졌다고 보이면[^\n]*\[지금\]으로 바꾸고[^\n]*\(조건 채워진 듯, #\d+\)/);
  // 없으면 놓치는 실수: "비서가 확인할 것"의 끝난 줄을 Haiku가 바로 지워, 정말 끝났는지 비서가 확인할 기회 없이 사라진다.
  assert.match(prompt, /"진행 중"·"부탁하고 기다리는 것"·"비서가 확인할 것"의 줄은 지우지 않는다[^\n]*\(끝난 듯, #\d+\)/);
  assert.match(prompt, /\[큰 일 판\] \(읽기만[^\n]*\n\(비어 있음\)/);
  assert.match(boardPrompt(undefined, rows, [], [], '- 이사 준비 — 보류 · 11-04 갱신'), /\[큰 일 판\][^\n]*\n- 이사 준비 — 보류 · 11-04 갱신\n/);
  assert.match(boardPrompt(undefined, rows, [], ['옛 세션을 보관했다.']), /\[대화 밖에서 확인된 사실\][^\n]*\n옛 세션을 보관했다\./);
});

test('a backlog over the cap is split into chunks, oldest first, none dropped', () => {
  const s = tempStore();
  for (let i = 1; i <= 5; i++) say(s, 'sess', 'user', `${i}`.repeat(40));
  const chunks = boardChunks(s, undefined, 100);
  assert.deepEqual(chunks.map((c) => c.map((r) => r.content[0]).join('')), ['12', '34', '5']);
});

test('a message longer than a chunk is split into marked parts', () => {
  const s = tempStore();
  say(s, 'sess', 'user', '짧음');
  say(s, 'sess', 'assistant', 'x'.repeat(250));
  const chunks = boardChunks(s, undefined, 100);
  assert.deepEqual(chunks.map((c) => c.map((r) => r.content.length)), [[2], [100], [100], [50]]);
  assert.deepEqual(chunks.slice(1).map((c) => c[0].part), [{ index: 1, count: 3 }, { index: 2, count: 3 }, { index: 3, count: 3 }]);
  assert.match(boardPrompt(undefined, chunks[1], []), /비서 \(1\/3 부분\)\]/);
});

test('a rewrite runs one run-job per chunk (fakes here), saves the board and the version it ran on; an answer that is no board fails it', async () => {
  const s = tempStore();
  say(s, 'sess', 'user', '첫 대화');
  say(s, 'sess', 'assistant', '답');
  const prompts: string[] = [];
  const deps = {
    claudeVersion: async () => '9.9.9',
    runJob: async (file: string) => (prompts.push(fs.readFileSync(file, 'utf8')), `${BOARD}\n(새 세션) 세션: abc-123`),
  };
  const job = await runBoardUpdate(s, ['옛 세션을 보관했다.'], deps);
  assert.deepEqual([job.ok, job.version], [true, '9.9.9']);
  assert.deepEqual([readBoard(s)?.text, readBoard(s)?.lastLogId], [BOARD, s.logAfter(0).at(-1)!.id]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /\[대화 밖에서 확인된 사실\][^\n]*\n옛 세션을 보관했다\./);
  assert.equal(s.getMeta(OK_VERSION_KEY), '9.9.9');
  say(s, 'sess', 'user', '또');
  const bad = await runBoardUpdate(s, [], { ...deps, runJob: async () => 'Error: rate limited' });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /상황판 형식이 아닌 답 \(1\/1번째 덩어리\): Error: rate limited/);
  assert.equal(readBoard(s)?.text, BOARD, 'the board stays');
});

test('under the tests\' mark the real run-job, claude --version and the detached rewrite are refused', async () => {
  assert.ok(process.env[NO_MODEL_ENV], 'test/env.ts sets the mark');
  await assert.rejects(runJobScript(['-Model', 'haiku'], 'none.txt', 1000), /시험 중에는 claude·run-job을 부르지 않아요/);
  const s = tempStore();
  say(s, 'sess', 'user', '대화');
  const job = await runBoardUpdate(s);
  assert.equal(job.ok, false);
  assert.match(job.error ?? '', /claude --version/);
  assert.throws(() => spawnBoardJob(s), /situation-board-update/);
  assert.doesNotThrow(() => assertModelCallsAllowed('x', {}), 'without the mark nothing is refused');
  // The PowerShell scripts find claude in one place (common.ps1 Get-ClaudeExe), which refuses too.
  if (process.platform === 'win32') {
    const common = path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${common}'; Get-ClaudeExe`], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SECRETARY_NO_MODEL_CALLS/);
  }
});

test('only the first prompt of a waiting session gets the board', async () => {
  const s = tempStore();
  say(s, 'old', 'user', '대화');
  s.setMeta('situation_board', JSON.stringify({ text: BOARD, lastLogId: 1, updatedAt: new Date().toISOString() }));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: true, ms: 9000 }));
  s.setMeta('board_pending:new', new Date().toISOString());
  const ctx = await boardContext(s, 'new', 100, '', offline);
  assert.match(ctx, /<secretary-board>/);
  assert.match(ctx, /요약: 상황판 시험 중/);
  assert.match(ctx, /> 이어서: …/);
  assert.match(ctx, /"큰 일 바뀐 듯"의 줄은[^\n]*search_log\(log_id\)[^\n]*set_big_work/, 'the secretary checks a suspected big-work change before fixing the board');
  // 없으면 놓치는 실수: 비서가 상황판의 미룬 일([지금]이 아닌 줄)을 다음 행동으로 옮겨 권하거나, 조건이 채워진 줄을 확인 없이 꺼낸다.
  assert.match(ctx, /\[지금\]이 아닌 줄[^\n]*다음 행동[^\n]*옮기지[^\n]*\(조건 채워진 듯, #번호\)[^\n]*search_log\(log_id\)[^\n]*먼저 꺼내/);
  // 없으면 놓치는 실수: "비서가 확인할 것"의 "(끝난 듯)" 줄을 비서가 확인 없이 그대로 전한다(안내가 다른 칸만 말할 때).
  assert.match(ctx, /\(끝난 듯, #번호\)"가 붙은 줄[^\n]*"비서가 확인할 것"[^\n]*정말 끝났으면 전하지 않고/);
  assert.equal(await boardContext(s, 'new', 100, '', offline), '');
  assert.equal(await boardContext(s, 'never-started', 100, '', offline), '');
  // A handoff prompt gets no board: that session runs session-handoff-wake after archiving the old one.
  s.setMeta('board_pending:handed', new Date().toISOString());
  assert.equal(await boardContext(s, 'handed', 100, `${HANDOFF_MARK}
넘길 일 없음`), '');
  assert.equal(s.getMeta('board_pending:handed'), undefined);
});

test('a failed rewrite falls back to the continuity pointers and the old board', async () => {
  const s = tempStore();
  // Over BOARD_RAW_MAX_TOKENS of raw talk after the board: the first prompt needs a rewrite.
  say(s, 'old-sess-9', 'user', '긴 이야기 '.repeat(4000));
  say(s, 'old-sess-9', 'user', '마지막 부탁');
  say(s, 'old-sess-9', 'assistant', '서버 창을 닫고 다시 실행해 주세요.');
  s.setMeta('situation_board', JSON.stringify({ text: BOARD, lastLogId: 0, updatedAt: new Date().toISOString() }));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: false, error: 'x' }));
  s.setMeta('board_pending:new', new Date().toISOString());
  const ctx = await boardContext(s, 'new', 100, '', offline);
  assert.match(ctx, /<secretary-continuity>/);
  assert.match(ctx, /비서의 마지막 답 끝: "…서버 창을 닫고 다시 실행해 주세요\."/);
  assert.match(ctx, /옛 상황판/);
  assert.match(ctx, /갱신이 실패/);
  assert.match(ctx, /실패 이유: x/);
  assert.doesNotMatch(ctx, /--bare/);
});

test('a failure right after a Claude Code update points at a claude -p default change', async () => {
  const s = tempStore();
  s.setMeta('board_ok_claude_version', '2.1.312');
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: false, error: 'Not logged in', version: '2.1.320' }));
  s.setMeta('board_pending:new', new Date().toISOString());
  const ctx = await boardContext(s, 'new', 100, '', offline);
  assert.match(ctx, /<secretary-board-failure>/);
  assert.match(ctx, /Not logged in/);
  assert.match(ctx, /2\.1\.312에서 2\.1\.320/);
  assert.match(ctx, /--bare/);
});

test('a still-running rewrite is waited for only up to the limit', async () => {
  const s = tempStore();
  say(s, 'old', 'user', '대화');
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString() }));
  s.setMeta('board_pending:new', new Date().toISOString());
  const t = Date.now();
  const ctx = await boardContext(s, 'new', 600, '', offline);
  assert.ok(Date.now() - t >= 500);
  assert.match(ctx, /갱신이 늦어/);
});


test('a board behind the talk is injected at once with the raw tail, and rewritten in the background', async () => {
  const s = tempStore();
  say(s, 'other-server', 'user', '먼저 한 말');
  const first = s.logAfter(0)[0].id;
  s.setMeta('situation_board', JSON.stringify({ text: BOARD, lastLogId: first, updatedAt: new Date().toISOString() }));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: true, ms: 9000 }));
  s.setMeta('board_pending:new', new Date().toISOString());
  say(s, 'other-server', 'assistant', '그 뒤의 마지막 답');
  let spawned = 0;
  const t = Date.now();
  // The spawned rewrite never finishes here: the prompt must not wait for it.
  const ctx = await boardContext(s, 'new', 2000, '', { ...offline, spawnJob: () => void spawned++ });
  assert.ok(Date.now() - t < 1000, 'no waiting');
  assert.equal(spawned, 1);
  assert.match(ctx, /요약: 상황판 시험 중/);
  assert.match(ctx, /\[상황판 뒤 대화 원문\] \(#\d+~#\d+, 1개\.[^\n]*상황판과 어긋나면 이것을 따른다/);
  assert.match(ctx, /세션 other-se 비서\]\n그 뒤의 마지막 답\n\[원문 끝\]/);
  assert.doesNotMatch(ctx, /먼저 한 말/, 'what the board already covers is not repeated');
  assert.doesNotMatch(ctx, /<secretary-board-failure>/);
  // A last rewrite that failed is still reported.
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: false, error: 'rate limited' }));
  s.setMeta('board_pending:new2', new Date().toISOString());
  assert.match(await boardContext(s, 'new2', 100, '', offline), /<secretary-board-failure>\n[^\n]*rate limited/);
});

test('a raw tail over the cap is rewritten on the first prompt, and waited for', async () => {
  const s = tempStore();
  say(s, 'other-server', 'user', '먼저 한 말');
  const first = s.logAfter(0)[0].id;
  s.setMeta('situation_board', JSON.stringify({ text: BOARD, lastLogId: first, updatedAt: new Date().toISOString() }));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: true, ms: 9000 }));
  s.setMeta('board_pending:new', new Date().toISOString());
  say(s, 'other-server', 'assistant', `그 뒤의 긴 답 ${'긴 이야기 '.repeat(4000)}`);
  let spawned = 0;
  const ctx = await boardContext(s, 'new', 100, '', {
    ...offline,
    spawnJob: (st) => {
      spawned++;
      const last = st.logAfter(0).at(-1)!.id;
      st.setMeta('situation_board', JSON.stringify({ text: `${BOARD}\n마지막 답 반영`, lastLogId: last, updatedAt: new Date().toISOString() }));
      st.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: true, ms: 1 }));
    },
  });
  assert.equal(spawned, 1);
  assert.match(ctx, /<secretary-board>/);
  assert.match(ctx, /마지막 답 반영/);
});
test('a fresh board also lists running tasks to watch again', async () => {
  const s = tempStore();
  say(s, 'old', 'user', '대화');
  const last = s.logAfter(0).at(-1)!.id;
  s.setMeta('situation_board', JSON.stringify({ text: BOARD, lastLogId: last, updatedAt: new Date().toISOString() }));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: true, ms: 1 }));
  s.setMeta('board_pending:new', new Date().toISOString());
  const ws = s.createWorkspace({ kind: 'solo', name: 'video', title: '영상', purpose: '영상 제작', folder: 'C:/ws/video', agents: [] });
  const t = s.createTask({ workspaceId: ws.id, name: 'step6', title: '6단계 조립', goal: 'g', outputDir: 'o' });
  s.updateTask(t.id, { status: 'running', sessionRef: 'bg:ad8ca57f' });
  const ctx = await boardContext(s, 'new', 100, '', offline);
  assert.match(ctx, /<secretary-board>/);
  assert.match(ctx, /- 업무 \d+ "6단계 조립" · bg:ad8ca57f/);
  assert.match(ctx, /watch-worker\.ps1 -Id <id>를 백그라운드 명령\(시간제한 3600000ms\)으로 다시 띄운다/);
});
