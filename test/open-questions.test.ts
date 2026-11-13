import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuityContext } from '../src/session-continuity/situation-board-notice.ts';
import { labelAt, labelIndex, openQuestionKeys, openQuestionLines, parseAnswers, parseQuestions, parseRemaining, updateOpenQuestions } from '../src/session-continuity/open-questions.ts';
import { runningTaskLines } from '../src/workspace/watch-check.ts';
import { say, tempStore } from './helpers.ts';

test('labels count A..Z then AA', () => {
  assert.equal(labelAt(labelIndex('Z') + 1), 'AA');
  assert.equal(labelAt(labelIndex('AF') + 1), 'AG');
});

test('parses labeled questions with options and the remaining line', () => {
  const text = [
    '설명 문단이에요.',
    '',
    'AE. 직전 대화를 얼마나 넣을까요?',
    '1) 3번 (추천)',
    '2) 5번',
    '',
    '- **Y. 알림 켜짐 설정 확인:** 실제 설정을 확인할까요? 1) 확인 2) 안 함',
    'B. 이건 질문이 아닌 목록 항목',
    '',
    '남은 질문: AE, Y · 보류: Z',
  ].join('\n');
  const q = parseQuestions(text);
  assert.deepEqual(Object.keys(q).sort(), ['AE', 'Y']);
  assert.match(q.AE, /^AE\. 직전 대화를 얼마나 넣을까요\? 1\) 3번 \(추천\) 2\) 5번$/);
  assert.deepEqual(parseRemaining(text), ['AE', 'Y', 'Z']);
  assert.deepEqual(parseRemaining('남은 질문: 없음'), []);
  // 없으면 놓치는 실수: 뜻 속 대문자("새PC", "UAC")를 남은 질문 알파벳으로 읽어, 없는 질문 PC·UAC가 열린 채 다음 세션으로 넘어간다.
  assert.deepEqual(parseRemaining('남은 질문: F(새PC UAC 단계), AB(알림 시각 (KST)), C\n'), ['F', 'AB', 'C']);
  assert.deepEqual(parseRemaining('남은 질문: A(옛 G, #1234), B(새 PC 설정)'), ['A', 'B']);
  // Only the front of each item: a capital word later in an item is not a label.
  assert.deepEqual(parseRemaining('남은 질문: D 급하지 않음 PC 켜면'), ['D']);
  assert.equal(parseRemaining('질문 없음'), null);
});

// 없으면 놓치는 실수: 남은 질문을 "다음 행동 및 순서:"의 번호 단계로 옮긴 뒤(2026-11-12) 새 형식을 못 읽어 답한 질문이 열린 채 남거나, 지난 대화 기록의 옛 "남은 질문:" 줄을 못 읽는다.
test('the remaining questions: the new step under "다음 행동 및 순서:", and the old line', () => {
  const asked = 'C. 알림 시각은 언제로 할까요?\n1. 9시 (추천)\n2. 기타 (직접 입력)\n\n';
  // New: a numbered step of the closing list (plain, bold, as a list item).
  const now = `${asked}다음 행동 및 순서:\n1. 테스트 결과를 봐 주세요.\n2. 남은 질문에 답해 주세요: C(알림 시각), AB(새PC 단계)`;
  assert.deepEqual(parseRemaining(now), ['C', 'AB']);
  assert.deepEqual(parseRemaining('다음 행동 및 순서:\n- 1. **남은 질문에 답해 주세요:** D(키 이름)'), ['D']);
  // 없으면 놓치는 실수: 단계를 "다음 행동 및 순서:" 줄에 이어 쓰면 단계 없는 목록으로 읽어 답 없는 질문을 목록에서 뺀다(2026-11-13 평가).
  assert.deepEqual(parseRemaining('다음 행동 및 순서: 남은 질문에 답해 주세요: AN(옛 형식)'), ['AN']);
  assert.deepEqual(parseRemaining('**다음 행동 및 순서:** 1. 남은 질문에 답해 주세요: B(키), C'), ['B', 'C']);
  assert.equal(parseRemaining('다음 행동 및 순서: 없음'), null);
  assert.deepEqual(parseRemaining('다음 행동 및 순서:\n1) 남은 질문에 답해 주세요: E'), ['E']);
  // The step does not run into the question block before it.
  assert.deepEqual(Object.keys(parseQuestions(now)), ['C']);
  // All settled: no step, so no remaining list at all (the closing list itself closes them, see the test below).
  assert.equal(parseRemaining('반영했어요.\n\n다음 행동 및 순서: 없음'), null);
  // The old line, as the past answers in the log have it.
  assert.deepEqual(parseRemaining(`${asked}남은 질문: C(알림 시각)\n\n다음 행동 및 순서: C에 답해 주세요.`), ['C']);
  // A purge result relayed as it is ("남은 질문에서 뺀 것: A") names no open question.
  assert.equal(parseRemaining('대화를 지웠어요.\n남은 질문에서 뺀 것: A'), null);

  // Through the Stop hook's list: the new step keeps C open, a closing list without it closes it.
  const s = tempStore();
  say(s, 'new-form', 'assistant', `${asked}다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: C(알림 시각)`);
  updateOpenQuestions(s, 'new-form');
  say(s, 'new-form', 'user', 'c1');
  say(s, 'new-form', 'assistant', '9시로 맞췄어요.\n\n다음 행동 및 순서:\n1. 내일 9시 알림이 오는지 봐 주세요.\n2. 남은 질문에 답해 주세요: C(알림 시각)');
  updateOpenQuestions(s, 'new-form');
  assert.match(openQuestionLines(s).join('\n'), /C\. 알림 시각은/, 'the step wins over the "c1" in between');
  say(s, 'new-form', 'assistant', '반영했어요.\n\n다음 행동 및 순서: 없음');
  updateOpenQuestions(s, 'new-form');
  assert.deepEqual(openQuestionLines(s), []);
});

// 없으면 놓치는 실수: 따로 떨어진 "남은 질문: 없음" 줄을 없앤 뒤(2026-11-12 결정) 다 풀린 질문이 닫히지 않고 다음 세션으로 넘어가거나,
// 거꾸로 "다음 행동 및 순서:"가 없는 짧은 설명 답에서 아직 답 안 한 질문까지 닫힌다.
test('a closing list without the remaining step closes the open questions; an answer without one keeps them', () => {
  const s = tempStore();
  const open = () => openQuestionLines(s).join('\n');
  const asked = 'C. 알림 시각은 언제로 할까요?\n1. 9시 (추천)\n2. 기타 (직접 입력)\n\nD. 키 이름은 어떻게 할까요?\n1. 짧게\n2. 기타 (직접 입력)\n\n';
  say(s, 'blk', 'assistant', `${asked}다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: C(알림 시각), D(키 이름)`);
  updateOpenQuestions(s, 'blk');
  // The step names only D: C closes, D stays.
  say(s, 'blk', 'assistant', '알림은 9시로 맞췄어요.\n\n다음 행동 및 순서:\n1. 내일 9시 알림이 오는지 봐 주세요.\n2. 남은 질문에 답해 주세요: D(키 이름)');
  updateOpenQuestions(s, 'blk');
  assert.doesNotMatch(open(), /C\. 알림/);
  assert.match(open(), /D\. 키 이름/);
  // No closing list (a short explanation): D stays.
  say(s, 'blk', 'assistant', '키 이름은 나중에 바꿀 수도 있어요.');
  updateOpenQuestions(s, 'blk');
  assert.match(open(), /D\. 키 이름/);
  // A closing list with steps but without the remaining step: D closes.
  say(s, 'blk', 'assistant', '키 이름을 정했어요.\n\n다음 행동 및 순서:\n1. 키 파일을 넣어 주세요.');
  updateOpenQuestions(s, 'blk');
  assert.deepEqual(openQuestionLines(s), []);
  // A question asked in the same answer as a closing list without the step stays open (it cannot be answered yet).
  say(s, 'blk', 'assistant', 'E. 알림 소리를 켤까요?\n1. 켬\n2. 기타 (직접 입력)\n\n**다음 행동 및 순서:** 없음');
  updateOpenQuestions(s, 'blk');
  assert.match(open(), /E\. 알림 소리/);
});

test('open questions carry into the next session with their text', () => {
  const s = tempStore();
  say(s, 'old-session-1', 'user', '기억정리해줘');
  say(s, 'old-session-1', 'assistant', 'V. 1번 공간 검증 칸 추가할까요? 1) 넣음 2) 안 넣음\n\nW. 남은 예약 작업 지울까요? 1) 지움 2) 둠\n\n남은 질문: V, W');
  updateOpenQuestions(s, 'old-session-1');
  say(s, 'old-session-1', 'user', 'v1');
  say(s, 'old-session-1', 'assistant', '반영했어요.\n\n남은 질문: W');
  updateOpenQuestions(s, 'old-session-1');

  const ctx = continuityContext(s, 'new-session');
  assert.match(ctx, /직전 세션 old-sess/);
  assert.match(ctx, /- "v1"/);
  // Carried questions are relabeled from A, keeping the old label and the log id that asked them.
  assert.match(ctx, /- A \(옛 W, #\d+\)\. 남은 예약 작업 지울까요\?/);
  assert.doesNotMatch(ctx, /1번 공간/);
  assert.match(ctx, /새 질문은 B부터/);
  assert.match(ctx, /search_log\(session_id="old-sess"\)/);

  // A reply without a closing list keeps the list; a closing list without the remaining step clears it.
  say(s, 'new-session', 'assistant', '네, 알겠어요.');
  updateOpenQuestions(s, 'new-session');
  assert.match(continuityContext(s, 'x'), /- A \(#\d+\)\. 남은/);
  say(s, 'new-session', 'assistant', '다 처리했어요.\n\n다음 행동 및 순서: 없음');
  updateOpenQuestions(s, 'new-session');
  assert.doesNotMatch(continuityContext(s, 'x'), /남은 질문\(/);
});

test('label answers close open questions only when the remaining line is missing', () => {
  assert.deepEqual(parseAnswers('c1 설치했어\nA2 B1 / e - 근데 / mp3, h264, v12'), ['C', 'A', 'B', 'MP', 'V']);
  const s = tempStore();
  const open = () => openQuestionLines(s).join('\n');
  say(s, 'ans-1', 'assistant', 'C. 설치는 어떻게 할까요? 1) 직접 2) 규칙\n\nE. 어떻게 할까요? 1) 하나 2) 둘\n\n남은 질문: C, E');
  updateOpenQuestions(s, 'ans-1');
  // "e - …" is discussion and "mp3"/"b2" name no open question: nothing closes.
  say(s, 'ans-1', 'user', 'e - 근데 이건 어때? mp3 b2');
  say(s, 'ans-1', 'assistant', '설명이에요.');
  updateOpenQuestions(s, 'ans-1');
  assert.match(open(), /C\. 설치는[\s\S]*E\. 어떻게/);
  // The secretary's remaining line wins over a label used as an example.
  say(s, 'ans-1', 'user', '내가 e3 이렇게 말할 때도 있잖아');
  say(s, 'ans-1', 'assistant', '맞아요.\n\n남은 질문: C, E');
  updateOpenQuestions(s, 'ans-1');
  assert.match(open(), /C\. 설치는[\s\S]*E\. 어떻게/);
  // No remaining line: the user's "c1" closes C and leaves E.
  say(s, 'ans-1', 'user', 'c1 설치했어');
  say(s, 'ans-1', 'assistant', '확인했어요.');
  updateOpenQuestions(s, 'ans-1');
  assert.doesNotMatch(open(), /설치는/);
  assert.match(open(), /어떻게 할까요\? 1\) 하나/);
});

test('session tail accepts an 8-char prefix', () => {
  const s = tempStore();
  say(s, 'abcdef12-rest', 'user', '첫 말');
  say(s, 'abcdef12-rest', 'assistant', '답');
  assert.deepEqual(s.sessionTail('abcdef12', 5).map((r) => r.content), ['첫 말', '답']);
});

test('running tasks are listed for a new session with a cue to watch them again', () => {
  const s = tempStore();
  assert.deepEqual(runningTaskLines(s), []);
  assert.equal(continuityContext(s, 'new'), '');
  const ws = s.createWorkspace({ kind: 'solo', name: 'video', title: '영상', purpose: '영상 제작', folder: 'C:/ws/video', agents: [] });
  const done = s.createTask({ workspaceId: ws.id, name: 'old', title: '끝난 업무', goal: 'g', outputDir: 'o1' });
  s.updateTask(done.id, { status: 'done', sessionRef: 'bg:11111111' });
  const run = s.createTask({ workspaceId: ws.id, name: 'step6', title: '6단계 조립', goal: 'g', outputDir: 'o' });
  s.updateTask(run.id, { status: 'running', sessionRef: 'bg:ad8ca57f' });
  const lines = runningTaskLines(s, () => false);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], `- 업무 ${run.id} "6단계 조립" · bg:ad8ca57f`);
  assert.match(lines[2], /scripts\/worker\/watch-worker\.ps1 -Id <id>를 백그라운드 명령\(시간제한 3600000ms\)으로 다시 띄운다/);
  // After /clear the old watcher may still be alive: mark it and do not ask for a second one.
  const watched = runningTaskLines(s, (bg) => bg === 'ad8ca57f');
  assert.equal(watched[1], `- 업무 ${run.id} "6단계 조립" · bg:ad8ca57f · 모니터링 살아 있음`);
  assert.equal(watched[2], '모두 모니터링이 살아 있으니 다시 띄우지 않는다(겹친다).');
  const run2 = s.createTask({ workspaceId: ws.id, name: 'step7', title: '7단계', goal: 'g', outputDir: 'o2' });
  s.updateTask(run2.id, { status: 'running', sessionRef: 'bg:bbbbbbbb' });
  const mixed = runningTaskLines(s, (bg) => bg === 'ad8ca57f');
  assert.equal(mixed.filter((l) => l.endsWith('모니터링 살아 있음')).length, 1);
  assert.match(mixed.at(-1)!, /^"모니터링 살아 있음"이 없는 업무만 첫 답에서/);
  // Even with no previous session or open questions, the continuity block carries them.
  const ctx = continuityContext(s, 'new');
  assert.match(ctx, /<secretary-continuity>[\s\S]*"6단계 조립" · bg:ad8ca57f[\s\S]*<\/secretary-continuity>/);
  assert.doesNotMatch(ctx, /끝난 업무/);
});

// 없으면 놓치는 실수: 질문이 목록에서 빠질 때 왜 빠졌는지 남기지 않아, 상황판이 답한 질문과 7일 지나 빠진 질문을 같은 "끝난 듯"으로 표시한다(C12).
test('the open-question list records why each question closed, for a week', () => {
  const s = tempStore();
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  say(s, 'sess', 'assistant', 'A. 알림 시각은요?\n1. 8시\n\nB. 이름은요?\n1. 가\n\nC. 색은요?\n1. 빨강\n\n다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: A, B, C');
  updateOpenQuestions(s, 'sess', t0);
  const asked = s.logAfter(0).at(-1)!.id;
  say(s, 'sess', 'user', 'a1');
  const answer = s.logAfter(0).at(-1)!.id;
  say(s, 'sess', 'assistant', '정했어요.\n\n다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: C');
  updateOpenQuestions(s, 'sess', t0);
  const reply = s.logAfter(0).at(-1)!.id;
  const keys = openQuestionKeys(s)!;
  assert.deepEqual([...keys.labels], ['C']);
  assert.deepEqual(keys.closed.get('A'), { at: keys.closed.get('A')!.at, reason: 'answered', evidence: answer, logId: asked });
  assert.deepEqual(keys.closed.get('B'), { at: keys.closed.get('B')!.at, reason: 'not-in-list', evidence: reply, logId: asked });
  // A week on, C ran out of time; the records of A and B are gone with it.
  say(s, 'sess', 'assistant', '설명만 했어요.');
  const later = Date.now() + 8 * 24 * 3600_000;
  updateOpenQuestions(s, 'sess', later);
  const after = openQuestionKeys(s)!;
  assert.equal(after.openCount, 0);
  assert.deepEqual([...after.closed.keys()], ['C']);
  assert.equal(after.closed.get('C')!.reason, 'expired');
});
