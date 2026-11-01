import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardChunks, boardContext, boardPrompt, HANDOFF_MARK, parseBoard } from '../src/board.ts';
import { tempStore } from './helpers.ts';

let n = 0;
function say(s: ReturnType<typeof tempStore>, session: string, role: 'user' | 'assistant', content: string): void {
  n++;
  s.appendLog([{ session_id: session, message_uuid: `b${n}`, role, content, created_at: new Date(Date.now() + n).toISOString() }]);
}

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
  assert.equal(await boardContext(s, 'new', 100, '', offline), '');
  assert.equal(await boardContext(s, 'never-started', 100, '', offline), '');
  // A handoff prompt gets no board: that session runs handoff-wake after archiving the old one.
  s.setMeta('board_pending:handed', new Date().toISOString());
  assert.equal(await boardContext(s, 'handed', 100, `${HANDOFF_MARK}
넘길 일 없음`), '');
  assert.equal(s.getMeta('board_pending:handed'), undefined);
});

test('a failed rewrite falls back to the continuity pointers and the old board', async () => {
  const s = tempStore();
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


test('a board written before talk elsewhere is rewritten on the first prompt', async () => {
  const s = tempStore();
  say(s, 'other-server', 'user', '먼저 한 말');
  const first = s.logAfter(0)[0].id;
  s.setMeta('situation_board', JSON.stringify({ text: BOARD, lastLogId: first, updatedAt: new Date().toISOString() }));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: true, ms: 9000 }));
  s.setMeta('board_pending:new', new Date().toISOString());
  say(s, 'other-server', 'assistant', '그 뒤의 마지막 답');
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
  assert.match(ctx, /watch-worker\.ps1 -Id <id>를 백그라운드 명령\(시간제한 7200000ms\)으로 다시 띄운다/);
});
