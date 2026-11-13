import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { BOARD_HEADINGS, boardChunks, boardPrompt, checkHeadings, markClosedQuestions, OK_VERSION_KEY, parseBoard, readBoard, runBoardUpdate, spawnBoardJob, spawnBoardJobAfterUpdate } from '../src/session-continuity/situation-board.ts';
import { readStaff, secretaryTag, staffFolder } from '../src/staff/staff.ts';
import { boardBlock, boardContext, HANDOFF_MARK } from '../src/session-continuity/situation-board-notice.ts';
import { boardDecisionLines, openLineDecisions } from '../src/session-continuity/board-decisions.ts';
import type { Board } from '../src/session-continuity/situation-board.ts';
import { runJobScript } from '../src/staff/launch.ts';
import { assertModelCallsAllowed, NO_MODEL_ENV } from '../src/core/no-model-calls.ts';
import { sessionStartContext } from '../src/hooks/session-start.ts';
import { openQuestionKeys, openQuestionLines, updateOpenQuestions, type ClosedQuestion } from '../src/session-continuity/open-questions.ts';
import { nextLabel, noteAnswerLabels } from '../src/mistake-guards/question-labels.ts';
import { say, tempDir, tempStore } from './helpers.ts';

// No real transcripts or Haiku in tests.
const offline = { catchUp: () => 0, spawnJob: () => {} };

const BOARD = '요약: 상황판 시험 중\n## 지금 주제\n상황판 (#2)\n## 진행 중인 사항\n없음';

test('parses a board out of run-job output and rejects anything else', () => {
  assert.equal(parseBoard(`${BOARD}\n(새 세션) 세션: abc-123`), BOARD);
  // 없으면 놓치는 실수: run-job이 세션을 재사용했을 때의 끝 줄("(재사용) 세션: …", 2026-11-11 전 "(이어 부름) 세션: …")이 상황판 끝에 붙어 남는다.
  assert.equal(parseBoard(`${BOARD}\n(재사용) 세션: abc-123`), BOARD);
  assert.equal(parseBoard(`${BOARD}\n(이어 부름) 세션: abc-123`), BOARD);
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
  assert.match(prompt, /빠짐없이[^\n]*한 줄에 한 사실[^\n]*한 항목에만[^\n]*근거 번호만[^\n]*끝난 일·풀린 질문은 뺀다/);
  assert.match(prompt, /안건[^\n]*상태[^\n]*상황판에 쓰지 않는다[^\n]*"## 바뀐 듯한 안건"에만[^\n]*근거 번호/);
  assert.match(prompt, /## 풀린 듯한 질문\n## 바뀐 듯한 안건\n/);
  // 없으면 놓치는 실수: 무엇이 끝난 뒤로 미룬 일이 때 표시 없이 "다음 행동"에 들어가 비서가 지금 할 일로 권한다.
  assert.match(prompt, /## 정한 사항\n## 비서가 확인할 사항\n/);
  assert.doesNotMatch(prompt, /## 다음 행동/);
  // 없으면 놓치는 실수: 상황판 칸 이름을 바꿀 때(2026-11-12) 형식의 한 칸만 옛 이름으로 남아 Haiku가 옛 칸과 새 칸을 섞어 쓴다.
  assert.match(prompt, /\n요약: <[^\n]*>\n## 지금 주제\n## 진행 중인 사항\n## 사용자의 실행·확인·결정이 필요한 사항\n## 보류한 사항\n## 정한 사항\n## 비서가 확인할 사항\n## 풀린 듯한 질문\n## 바뀐 듯한 안건\n/);
  assert.match(prompt, /"## 비서가 확인할 사항"[^\n]*대괄호[^\n]*\[지금\][^\n]*미룬 일은[^\n]*조건을 그대로 적는다[^\n]*"## 사용자의 실행·확인·결정이 필요한 사항"에만/);
  assert.match(prompt, /\[지금\]이 아닌 줄[^\n]*조건이 채워졌다고 보이면[^\n]*\[지금\]으로 바꾸고[^\n]*\(조건 채워진 듯, #\d+\)/);
  // 없으면 놓치는 실수: "비서가 확인할 사항"의 끝난 줄을 Haiku가 바로 지워, 정말 끝났는지 비서가 확인할 기회 없이 사라진다.
  assert.match(prompt, /"진행 중인 사항"·"사용자의 실행·확인·결정이 필요한 사항"·"비서가 확인할 사항"의 줄은 모두 남긴다[^\n]*\(끝난 듯, #\d+\)[^\n]*빼는 일은 비서가/);
  assert.match(prompt, /\[주요 현안\] \(읽기만[^\n]*\n\(비어 있음\)/);
  assert.match(boardPrompt(undefined, rows, [], [], '- 이사 준비 — 보류 · 11-04 갱신'), /\[주요 현안\][^\n]*\n- 이사 준비 — 보류 · 11-04 갱신\n/);
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
  assert.match(bad.error ?? '', /상황판 형식이 아닌 답 \(1\/1번째 부분\): Error: rate limited/);
  assert.equal(readBoard(s)?.text, BOARD, 'the board stays');
});

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

/** A full board with the format's headings; `old` puts other names in their places (index → name). */
const fullBoard = (old: Record<number, string> = {}) => ['요약: 제목 시험', ...BOARD_HEADINGS.flatMap((h, i) => [`## ${old[i] ?? h}`, `${i}번 칸 (#1)`])].join('\n');
/** The v0.10.0 format's headings, the same eight in the same order under the old names. */
const V010 = ['지금 주제', '진행 중', '부탁하고 기다리는 것', '보류', '정한 것', '비서가 확인할 것', '풀린 듯한 질문', '큰 일 바뀐 듯'];
const runsLines = () => {
  const file = path.join(staffFolder(readStaff('situation-board')), `runs-${secretaryTag()}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { headings?: string[] }) : [];
};

// 없으면 놓치는 실수: 칸 이름을 바꾼 뒤(2026-11-12) Haiku가 직전 판의 옛 제목("## 비서가 확인할 것")을 베껴, 형식과 다른 칸이 판에 남는다.
test('a board\'s headings are held to the format: old names renamed by place, anything else left and said why', () => {
  assert.deepEqual(checkHeadings(fullBoard()), { text: fullBoard(), renamed: [] });
  const one = checkHeadings(fullBoard({ 5: '비서가 확인할 것' }));
  assert.equal(one.text, fullBoard());
  assert.deepEqual(one.renamed, ['비서가 확인할 것 → 비서가 확인할 사항']);
  const all = checkHeadings(fullBoard(Object.fromEntries(V010.map((h, i) => [i, h]))));
  assert.equal(all.text, fullBoard(), 'a v0.10.0 board gets every new name');
  assert.equal(all.renamed.length, 6);
  // One missing, or two known ones swapped: renaming by place would put lines under the wrong heading.
  const missing = fullBoard().replace('## 보류한 사항\n', '');
  assert.deepEqual([checkHeadings(missing).text, checkHeadings(missing).renamed], [missing, []]);
  assert.match(checkHeadings(missing).problem ?? '', /못 고침\(7개, 형식은 8개\)/);
  const swapped = fullBoard({ 3: '정한 사항', 4: '보류한 사항' });
  assert.equal(checkHeadings(swapped).text, swapped);
  assert.match(checkHeadings(swapped).problem ?? '', /못 고침/);
});

test('a rewrite renames old headings in the answer and records it; an answer it cannot fix is saved as is and recorded', async () => {
  const s = tempStore();
  say(s, 'sess', 'user', '대화');
  const deps = (answer: string) => ({ claudeVersion: async () => '9.9.9', runJob: async () => `${answer}\n(새 세션) 세션: abc-123` });
  const before = runsLines().length;
  const job = await runBoardUpdate(s, [], deps(fullBoard({ 5: '비서가 확인할 것' })));
  assert.equal(job.ok, true);
  assert.equal(readBoard(s)?.text, fullBoard());
  assert.deepEqual(job.headings, ['1/1번째 부분: 제목 고침 비서가 확인할 것 → 비서가 확인할 사항']);
  assert.deepEqual(runsLines().slice(before).map((r) => r.headings), [job.headings], 'one line in the staff member\'s runs file');
  say(s, 'sess', 'user', '또');
  const odd = fullBoard().replace('## 보류한 사항\n', '');
  const kept = await runBoardUpdate(s, [], deps(odd));
  assert.equal(kept.ok, true);
  assert.equal(readBoard(s)?.text, odd, 'kept, not thrown away');
  assert.match(kept.headings?.join() ?? '', /1\/1번째 부분: 제목이 형식과 달라 못 고침/);
  say(s, 'sess', 'user', '또또');
  assert.equal((await runBoardUpdate(s, [], deps(fullBoard()))).headings, undefined, 'nothing recorded when the headings are right');
});

// 없으면 놓치는 실수: 사용자가 답한 질문 줄이 상황판에 열린 채 남는다(사용자가 답한 질문이 다음 판에도 "답하기"로 남음, 2026-11-13 평가).
// 거꾸로 아직 열린 질문(알파벳이 새 세션에서 바뀐 것, 괄호 메모 속 대문자 "F(새PC …)")이나 질문이 아닌 줄("- PC: …")을 끝난 듯으로
// 표시하거나, 7일 지나 빠진 질문을 "끝난 듯"으로 적거나, 목록이 비었을 때 모든 질문 줄에 한꺼번에 표시하면 비서가 답 없는 질문을 뺀다
// (출처 재검토 C12·C13, 2026-11-13 사용자 결정).
test('board question lines of questions the list closed are marked with why, open ones, unknown labels and other headings left, nothing in bulk', async () => {
  const sec = BOARD_HEADINGS[2];
  const lines = [
    '- J: 옛 칸 줄 옮기는 방식 답하기 (#900675)',
    '- F(새PC UAC 단계): 지금 단계로 둘지 (#900075)',
    '- A(옛 G, #1234). 알림 시각 정하기',
    '- C: 답한 질문인데 열린 B를 물은 대화를 근거로 듦 (#900800)',
    '- B: 새로 물은 것 (#900800)',
    '- PC: 시험 PC 켜 두기 (#900810)',
    '- H: 7일 지난 질문 (#900000)',
    '- API 키를 무엇에 쓸지 정하기 (#900732)',
    '- K: 이미 표시된 줄 (#900675) (끝난 듯, #900677)',
    '- E: 모델이 다르게 적은 표시 (#900434, 끝난 듯, #900434)',
  ];
  const board = fullBoard().replace(`## ${sec}\n2번 칸 (#1)`, `## ${sec}\n${lines.join('\n')}`).replace('## 보류한 사항\n3번 칸 (#1)', '## 보류한 사항\n- AK: 보류한 질문 (#900622)');
  const at = new Date().toISOString();
  const closed = new Map<string, ClosedQuestion>([
    ['J', { at, reason: 'answered', evidence: 900677 }],
    ['C', { at, reason: 'not-in-list', evidence: 900801 }],
    ['H', { at, reason: 'expired' }],
    ['AK', { at, reason: 'answered', evidence: 5700 }],
    ['F', { at, reason: 'answered', evidence: 5076 }],
  ]);
  // Open now: A (was G in an earlier session), B, F, D. "PC" was never asked: no record, no mark.
  const keys = { labels: new Set(['A', 'G', 'B', 'F', 'D']), closed, openCount: 4 };
  const { text, marked, held } = markClosedQuestions(board, keys);
  // C cites the log that asked the open B: still marked (one message can ask one question and report others done).
  assert.deepEqual([marked, held], [['J', 'C', 'H'], []]);
  assert.ok(text.includes('- J: 옛 칸 줄 옮기는 방식 답하기 (#900675) (끝난 듯: 사용자가 답함 #900677)\n'));
  assert.ok(text.includes('(#900800) (끝난 듯: 비서 답의 남은 질문에서 빠짐 #900801)\n'));
  assert.ok(text.includes('- H: 7일 지난 질문 (#900000) (답 없는 질문 목록에서 빠짐: 7일 지남, 답 확인 안 됨)\n'), 'expired is not called done');
  for (const l of lines.filter((x) => !/^- [JCH]:/.test(x))) assert.ok(text.includes(`${l}\n`), l);
  assert.ok(text.includes('- AK: 보류한 질문 (#900622)\n'), 'only the user\'s section');
  assert.equal(markClosedQuestions(text, keys).text, text, 'a marked line is not marked again');
  assert.deepEqual(markClosedQuestions(board, undefined), { text: board, marked: [], held: [] }, 'no list yet: nothing said');
  // C13: the open list empty, so only what the user answered is marked; the others are held.
  assert.deepEqual(markClosedQuestions(board, { ...keys, labels: new Set(), openCount: 0 }).held, ['C', 'H']);
  // Every labelled line would be marked at once (two or more): held the same way.
  const allClosed = fullBoard().replace(`## ${sec}\n2번 칸 (#1)`, `## ${sec}\n- C: 하나 (#1)\n- H: 둘 (#2)`);
  assert.deepEqual(markClosedQuestions(allClosed, keys), { text: allClosed, marked: [], held: ['C', 'H'] });

  // In a rewrite: the records kept by the Stop hook are what the saved board is checked against, and the run says so.
  const s = tempStore();
  say(s, 'sess', 'user', 'j3');
  assert.equal(openQuestionKeys(s), undefined);
  s.setJson('open_questions', { lastLogId: 0, open: ['B'], defs: { B: { text: 'B. 진행?', session: 'sess', at, logId: 900800, formerly: ['Q'] } }, closed: { J: { at, reason: 'answered', evidence: 900677 } } });
  assert.deepEqual(openQuestionKeys(s)?.labels, new Set(['B', 'Q']));
  const job = await runBoardUpdate(s, [], { claudeVersion: async () => '9.9.9', runJob: async () => board });
  const saved = readBoard(s)?.text ?? '';
  assert.match(saved, /- J: [^\n]*\(끝난 듯: 사용자가 답함 #900677\)/);
  assert.match(saved, /- B: 새로 물은 것 \(#900800\)\n/);
  assert.match(saved, /- F\(새PC UAC 단계\): 지금 단계로 둘지 \(#900075\)\n/, 'F was never closed in this list: left');
  assert.deepEqual(job.questions, ['질문 줄 끝남 표시(1/1번째 부분): J']);
});

// 없으면 놓치는 실수: 칸 이름을 바꾼 뒤 새 대화가 없으면 상황판 갱신이 아무것도 안 해(chunks 0), 옛 제목 판이 다음 대화까지 새 세션에 붙는다.
test('with nothing new said, a rewrite renames a saved board\'s old headings without a model', async () => {
  const s = tempStore();
  say(s, 'sess', 'user', '대화');
  const last = s.logAfter(0).at(-1)!.id;
  const updatedAt = '2026-11-12T10:00:00.000Z';
  s.setJson('situation_board', { text: fullBoard({ 5: '비서가 확인할 것' }), lastLogId: last, updatedAt });
  const job = await runBoardUpdate(s, [], { runJob: async () => assert.fail('no model'), claudeVersion: async () => assert.fail('no model') });
  assert.equal(job.ok, true);
  assert.deepEqual(readBoard(s), { text: fullBoard(), lastLogId: last, updatedAt });
  assert.deepEqual(job.headings, ['새 대화 없음, 저장된 판: 제목 고침 비서가 확인할 것 → 비서가 확인할 사항']);
  assert.equal((await runBoardUpdate(s)).headings, undefined, 'then there is nothing to do');
});

// 없으면 놓치는 실수: 배포판을 올린 뒤 새 세션이 옛 칸 이름의 상황판을 읽는다. 시험·꺼진 기능에서 다시 쓰기가 모델을 부른다.
test('after an update the rewrite is started in the background, except where models are not called, the feature is off or nothing is due', () => {
  const s = tempStore();
  assert.match(spawnBoardJobAfterUpdate(s), /건너뜀: 모델을 부르지 않는 환경/);
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: [{ id: 'session-continuity', enabled: false }] }));
  assert.match(spawnBoardJobAfterUpdate(s, {}, root), /건너뜀: 상황판 기능이 꺼져/);
  assert.match(spawnBoardJobAfterUpdate(s, {}), /다시 쓰지 않았어요/, 'no board and no talk: nothing to do');
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
  // 없으면 놓치는 실수: 비서가 상황판의 미룬 일([지금]이 아닌 줄)을 다음 행동으로 옮겨 권하거나, 조건이 채워진 줄을 확인 없이 꺼낸다.
  assert.match(ctx, /다음 행동[^\n]*\[지금\] 줄만[^\n]*\[지금\]이 아닌 줄[^\n]*미룬 일로 둔다[^\n]*\(조건 채워진 듯, #번호\)[^\n]*search_log\(log_id\)[^\n]*먼저 꺼내/);
  // 없으면 놓치는 실수: "비서가 확인할 사항"의 "(끝난 듯)" 줄을 비서가 확인 없이 그대로 전한다(안내가 다른 항목만 말할 때).
  assert.match(ctx, /\(끝난 듯, #번호\)"가 붙은 줄[^\n]*"비서가 확인할 사항"[^\n]*아직 안 끝난 줄만 전하고/);
  assert.equal(await boardContext(s, 'new', 100, '', offline), '');
  assert.equal(await boardContext(s, 'never-started', 100, '', offline), '');
  // A handoff prompt gets no board: that session runs session-handoff-wake after archiving the old one.
  s.setMeta('board_pending:handed', new Date().toISOString());
  assert.equal(await boardContext(s, 'handed', 100, `${HANDOFF_MARK}
넘길 일 없음`), '');
  assert.equal(s.getMeta('board_pending:handed'), undefined);
});

// 없으면 놓치는 실수: /compact(자동 압축 포함) 뒤 첫 질문에 상황판이 붙지 않아 요약이 빠뜨린 일을 비서가 모르고(2026-11-12 결정), 붙이더라도
// 이어지는 세션의 남은 질문을 새 세션처럼 A부터 다시 붙여 이 세션에서 이미 쓴 알파벳과 겹친다.
test('a compaction waits for the board like /clear; its open questions keep their labels', async () => {
  const s = tempStore();
  say(s, 'cmp', 'user', '대화');
  say(s, 'cmp', 'assistant', 'G. 알림은 몇 시에 보낼까요?\n1. 9시\n2. 기타 (직접 입력)\n\n다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: G(알림 시각)');
  updateOpenQuestions(s, 'cmp');
  noteAnswerLabels(s, 'cmp', s.sessionTail('cmp', 1)[0].content);
  s.setMeta('situation_board', JSON.stringify({ text: BOARD, lastLogId: 0, updatedAt: new Date().toISOString() }));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: true, ms: 9000 }));
  // A resume does not wait; a compaction does, as /clear and a new session.
  sessionStartContext(s, 'cmp', 'resume');
  assert.equal(s.getMeta('board_pending:cmp'), undefined);
  sessionStartContext(s, 'cmp', 'compact');
  assert.ok(s.getMeta('board_pending:cmp'));
  const ctx = await boardContext(s, 'cmp', 100, '', offline);
  assert.match(ctx, /<secretary-board>/);
  assert.match(ctx, /상황판 뒤 대화 원문[^]*G\. 알림은 몇 시에/);
  assert.match(ctx, /질문 알파벳은 그대로[^]*- G \(#\d+\)\. 알림은 몇 시에/);
  // 없으면 놓치는 실수: 압축 뒤에도 화면에 남은 질문을 선택지까지 다시 보여 줘 답이 길어진다(2026-11-12 사용자 확인: 압축 뒤에도 원격 화면에 앞 대화가 남음).
  assert.match(ctx, /선택지도 화면에 있다[^]*남은 질문에 답해 주세요/);
  assert.doesNotMatch(ctx, /선택지까지[^\n]*다시 보여 주고/);
  assert.doesNotMatch(ctx, /옛 G|- A \(/);
  assert.match(openQuestionLines(s).join('\n'), /G\. 알림은/, 'not relabelled in the store either');
  assert.equal(nextLabel(s, 'cmp'), 'H');
  assert.equal(await boardContext(s, 'cmp', 100, '', offline), '', 'only the first prompt after it');
  // The fallback points at this session before the compaction, not the one before it.
  say(s, 'cmp', 'user', '긴 이야기 '.repeat(4000));
  s.setMeta('board_job', JSON.stringify({ startedAt: new Date().toISOString(), done: true, ok: false, error: 'x' }));
  sessionStartContext(s, 'cmp', 'compact');
  const fallback = await boardContext(s, 'cmp', 100, '', offline);
  assert.match(fallback, /압축 전 이 세션 cmp/);
  assert.match(fallback, /- G \(#\d+\)\./);
  // A new session still relabels from A.
  sessionStartContext(s, 'next', 'startup');
  assert.match(await boardContext(s, 'next', 100, '', offline), /- A \(옛 G, #\d+\)\./);
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

// 없으면 놓치는 실수: 상황판에 "답 대기·미정"으로 남은 일이 다른 질문의 답 속에서 이미 정해져 기억에 있는데, 비서가 그 줄만 보고 "답 없음"이라고 전한다(2026-11-13 사용자 결정).
test('board: each "답 없음·미정" line gets the decision memories sharing its words, by number and first words; other lines and other kinds get none', () => {
  const s = tempStore();
  const d = s.remember({ kind: 'decision', content: '2026-11-13 자문단 방식은 비서에 넣지 않기로 결정함.' });
  s.remember({ kind: 'fact', content: '자문단 방식 조사 보고서가 나왔다.' });
  s.remember({ kind: 'decision', content: '알림 시각은 아침 9시로 정함.' });
  const board = ['## 사용자의 실행·확인·결정이 필요한 사항', '- 자문단 방식 적용 여부: BW 답 대기 (#900772)', '- 알림 소리 바꾸기 (#10)', '## 보류한 사항', '- 전혀 상관없는 일: 미정 (#3)'].join('\n');
  const found = openLineDecisions(s, board);
  assert.deepEqual(found.map((f) => [f.line, f.memories.map((m) => m.id)]), [['자문단 방식 적용 여부: BW 답 대기 (#900772)', [d.id]]]);
  const lines = boardDecisionLines(s, board);
  assert.match(lines[0], /recall\(ids\)/);
  assert.match(lines[1], new RegExp(`→ #${d.id}\\(2026-\\d\\d-\\d\\d\\) 자문단 방식은 비서에 넣지`));
  assert.deepEqual(boardDecisionLines(s, '- 알림 소리 바꾸기'), []);
  // The block the prompt hook attaches carries them.
  assert.match(boardBlock(s, { text: board, updatedAt: new Date().toISOString(), lastLogId: 0 } as Board), /단어가 겹치는 결정 기억[^]*자문단 방식은/);
});
