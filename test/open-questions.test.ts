import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuityContext } from '../src/session-continuity/situation-board-notice.ts';
import { updateOpenQuestions } from '../src/store/open-questions.ts';
import { say, tempStore } from './helpers.ts';

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
