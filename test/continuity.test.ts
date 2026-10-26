import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuityContext, labelAt, labelIndex, parseQuestions, parseRemaining, updateOpenQuestions } from '../src/continuity.ts';
import { tempStore } from './helpers.ts';

let n = 0;
function say(s: ReturnType<typeof tempStore>, session: string, role: 'user' | 'assistant', content: string): void {
  n++;
  s.appendLog([{ session_id: session, message_uuid: `u${n}`, role, content, created_at: new Date(Date.now() + n).toISOString() }]);
}

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
    '- **Y. 백업 켜짐 설정 확인:** 실제 설정을 확인할까요? 1) 확인 2) 안 함',
    'B. 이건 질문이 아닌 목록 항목',
    '',
    '남은 질문: AE, Y · 보류: Z',
  ].join('\n');
  const q = parseQuestions(text);
  assert.deepEqual(Object.keys(q).sort(), ['AE', 'Y']);
  assert.match(q.AE, /^AE\. 직전 대화를 얼마나 넣을까요\? 1\) 3번 \(추천\) 2\) 5번$/);
  assert.deepEqual(parseRemaining(text), ['AE', 'Y', 'Z']);
  assert.deepEqual(parseRemaining('남은 질문: 없음'), []);
  assert.equal(parseRemaining('질문 없음'), null);
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

  // A reply without a remaining line keeps the list; "없음" clears it.
  say(s, 'new-session', 'assistant', '네, 알겠어요.');
  updateOpenQuestions(s, 'new-session');
  assert.match(continuityContext(s, 'x'), /- A \(#\d+\)\. 남은/);
  say(s, 'new-session', 'assistant', '다 처리했어요.\n\n남은 질문: 없음');
  updateOpenQuestions(s, 'new-session');
  assert.doesNotMatch(continuityContext(s, 'x'), /남은 질문\(/);
});

test('session tail accepts an 8-char prefix', () => {
  const s = tempStore();
  say(s, 'abcdef12-rest', 'user', '첫 말');
  say(s, 'abcdef12-rest', 'assistant', '답');
  assert.deepEqual(s.sessionTail('abcdef12', 5).map((r) => r.content), ['첫 말', '답']);
});
