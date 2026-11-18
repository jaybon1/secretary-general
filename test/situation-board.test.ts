import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BEFORE_TODO_KEY, BOARD_HEADINGS, OK_VERSION_KEY, runBoardUpdate, spawnBoardJob } from '../src/session-continuity/situation-board.ts';
import { boardContext, HANDOFF_MARK } from '../src/session-continuity/situation-board-notice.ts';
import type { Board } from '../src/store/board-state.ts';
import { readBoard } from '../src/store/board-state.ts';
import { say, tempStore } from './helpers.ts';
import { NO_MODEL_ENV, assertModelCallsAllowed } from '../src/core/no-model-calls.ts';
import { runJobScript } from '../src/staff/launch.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { spawnSync } from 'node:child_process';

// No real transcripts or Haiku in tests.
const offline = { catchUp: () => 0, spawnJob: () => {} };

const BOARD = '요약: 상황판 시험 중\n## 지금 주제\n상황판 (#2)\n## 진행 중인 사항\n없음';

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
  assert.match(bad.error ?? '', /상황판 형식이 아닌 답 \(1\/1번째 부분\): Error: rate limited/);
  assert.equal(readBoard(s)?.text, BOARD, 'the board stays');
});

/** A full board with the format's headings; `old` puts other names in their places (index → name). */
const fullBoard = (old: Record<number, string> = {}) => ['요약: 제목 시험', ...BOARD_HEADINGS.flatMap((h, i) => [`## ${old[i] ?? h}`, `${i}번 칸 (#1)`])].join('\n');

// [늘 남김] 없으면 놓치는 실수: 시험을 돌릴 때 실제 run-job·claude 명령·상황판 다시 쓰기가 떠 모델을 부른다.
test('under the tests\' mark the real run-job, claude --version and the detached rewrite are refused', async () => {
  assert.ok(process.env[NO_MODEL_ENV], 'test/env.ts sets the mark');
  await assert.rejects(runJobScript(['-Model', 'haiku'], 'none.txt', 1000), /테스트 중에는 claude·run-job을 부르지 않아요/);
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

// [늘 남김] 없으면 놓치는 실수: 새 세션의 첫 질문에 상황판이 안 붙거나, 질문마다 다시 붙는다(기억 주입, 2026-11-12 늘 남김으로 올림).
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
  assert.match(ctx, /"바뀐 듯한 안건"의 줄은[^\n]*search_log\(log_id\)[^\n]*set_main_agenda/, 'the secretary checks a suspected main-agenda change before fixing the board');
  // 없으면 놓치는 실수: 할 일을 DB로 옮긴 뒤 비서가 상황판에서 할 일을 찾거나, "채워진 듯"·"끝난 듯" 할 일을 확인 없이 꺼낸다.
  assert.match(ctx, /할 일[^\n]*상황판이 아니라 DB의 할 일 기억[^\n]*<secretary-todo>[^\n]*search_log\(log_id\)로 확인한 뒤/);
  // 없으면 놓치는 실수: "진행 중인 사항"의 "(끝난 듯)" 줄을 비서가 확인 없이 그대로 전한다.
  assert.match(ctx, /"진행 중인 사항"에서 "\(끝난 듯, #번호\)"가 붙은 줄[^\n]*아직 안 끝난 줄만 전하고/);
  assert.equal(await boardContext(s, 'new', 100, '', offline), '');
  assert.equal(await boardContext(s, 'never-started', 100, '', offline), '');
  // A handoff prompt gets no board: that session runs session-handoff-wake after archiving the old one.
  s.setMeta('board_pending:handed', new Date().toISOString());
  assert.equal(await boardContext(s, 'handed', 100, `${HANDOFF_MARK}
넘길 일 없음`), '');
  assert.equal(s.getMeta('board_pending:handed'), undefined);
});

// [늘 남김] 없으면 놓치는 실수: 상황판 갱신이 실패했을 때 아무것도 안 붙어, 새 세션이 앞 대화를 모른 채 시작한다(기억 주입, 2026-11-12 늘 남김으로 올림).
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


// 없으면 놓치는 실수: 상황판 담당의 할 일 판단(2026-11-14 사용자 결정)이 DB에 안 들어가거나, 끝난 듯한 할 일을 코드가 바로 닫거나, 읽지 않은
// 대화를 근거로 든 줄·형식 밖 줄까지 들어가 없는 할 일이 생긴다. 할 일 칸이 있던 옛 판을 덮어써 비서가 옮길 줄을 잃는다.
// 비서가 제안만 한 일이 사용자 할 일로 들어가거나, 지어낸 말로 쓴 할 일이 할 일 요약에 오른다.
test('the rewrite\'s to-do part goes to the DB: done only marked, a condition seemingly met, new actions with their values; the rest left and recorded', async () => {
  const s = tempStore();
  const done = s.remember({ kind: 'action', content: '사장님께 사진 허락 받기' }).id;
  s.setAction(done, { owner: 'user', due: '2026-11-20', by: 't' });
  const cond = s.remember({ kind: 'action', content: '로고를 받으면 소개 페이지에 넣기' }).id;
  s.setAction(cond, { owner: 'secretary', condition: { kind: 'text', value: '로고 파일 받음' }, by: 't' });
  const bare = s.remember({ kind: 'action', content: '값 없는 옛 할 일' }).id;
  const oldBoard = '요약: 옛 판\n## 사용자의 실행·확인·결정이 필요한 사항\n- 사진 허락 받기 (#1)';
  s.setJson('situation_board', { text: oldBoard, lastLogId: 0, updatedAt: new Date().toISOString() });
  say(s, 'sess', 'user', '사장님이 사진 써도 된대. 로고도 inbox에 넣었어. 가격표 사진은 내일 보낼게');
  say(s, 'sess', 'assistant', '좋아요. 메뉴판도 찍어 주실래요?');
  const [u, a] = s.logAfter(0).map((r) => r.id);
  const answer = [
    fullBoard(),
    '=== 할 일 판단 ===',
    `- 끝남 #${done} (#${u})`,
    `- 조건 채워짐 #${cond} (#${u})`,
    `- 끝남 #${bare} (#${u})`,
    `- 새 할 일 | 주인: 사용자 | 기한: 2026-11-20 | 조건: 없음 | 주제: 꽃집 | 내용: 가격표 사진을 보낸다 | 인용: "가격표 사진은 내일 보낼게" (#${u})`,
    `- 새 할 일 | 주인: 사용자 | 기한: 없음 | 조건: 없음 | 주제: 꽃집 | 내용: 메뉴판 사진을 보낸다 | 인용: "메뉴판도 찍어 주실래요" (#${u})`,
    `- 새 할 일 | 주인: 사용자 | 기한: 없음 | 조건: 없음 | 주제: 꽃집 | 내용: 로고 파일을 다시 보낸다 (#${u})`,
    `- 새 할 일 | 주인: 비서 | 기한: 없음 | 조건: 없음 | 주제: 꽃집 | 내용: 옮길 절 표를 만든다 (#${a})`,
    `- 새 할 일 | 주인: 비서 | 기한: 없음 | 조건: 업무 3 끝남 | 주제: 꽃집 | 내용: 업무 결과를 검수한다 (#${a})`,
    '- 새 할 일 | 주인: 사용자 | 기한: 없음 | 조건: 없음 | 주제: 꽃집 | 내용: 읽지 않은 대화의 일 (#900999)',
    '- 아무 말',
  ].join('\n');
  const prompts: string[] = [];
  const job = await runBoardUpdate(s, [], { claudeVersion: async () => '9.9.9', runJob: async (f) => (prompts.push(fs.readFileSync(f, 'utf8')), `${answer}\n(새 세션) 세션: abc-123`) });
  assert.equal(job.ok, true);
  assert.match(prompts[0], new RegExp(`\\[DB 할 일 목록\\][^\\n]*\\n- #${done} \\[사용자 · 기한 2026-11-20\\] 사장님께[^]*- #${cond} \\[비서 · 조건 로고 파일 받음 \\(기다림\\)\\][^]*- #${bare} \\[값 없음\\]`));
  assert.equal(readBoard(s)?.text, fullBoard(), 'the to-do part is not on the board');
  assert.deepEqual([s.getAction(done)?.done_log_id, s.getMemory(done)?.valid_to], [u, null], 'marked, the memory left for the secretary to close');
  assert.deepEqual([s.getAction(cond)?.state, s.getAction(cond)?.marked_by, s.getAction(cond)?.marked_log_id], ['maybe_met', 'board', u]);
  const made = s.liveActions().filter((x) => x.id > bare);
  assert.deepEqual(
    made.map((x) => [x.content, x.action?.owner, x.action?.due_at, x.action?.cond_kind, x.action?.cond_value, x.action?.marked_by]),
    [
      ['가격표 사진을 보낸다', 'user', '2026-11-20', null, null, 'board'],
      ['업무 결과를 검수한다', 'secretary', null, 'task_done', '3', 'board'],
    ],
  );
  assert.equal(s.getMemory(made[0].id)?.source_log_id, u);
  const record = job.todos?.join('\n') ?? '';
  assert.match(record, /근거 #900999이 읽은 대화 밖이라 뺌/);
  assert.match(record, /형식 밖이라 뺌: - 아무 말/);
  assert.match(record, new RegExp(`#${bare}: 할 일 값\\(주인\\)이 없어`));
  // A user's to-do rests on the user's own words: one quoting the secretary's offer, or quoting nothing, is left out.
  assert.match(record, /인용 "메뉴판도 찍어 주실래요"이 읽은 대화의 사용자 말에 없어 뺌: 메뉴판 사진을 보낸다/);
  assert.match(record, /사용자 말 인용이 없어\(또는 형식이 틀려\) 뺌: 로고 파일을 다시 보낸다/);
  // Wording with a made-up word is left out, the secretary's to-dos too.
  assert.match(record, /지어낸 말\("절 표"\)이 있어 뺌: 옮길 절 표를 만든다/);
  assert.equal(s.getJson<Board>(BEFORE_TODO_KEY)?.text, oldBoard, 'the last board with the to-do sections is kept');
});
