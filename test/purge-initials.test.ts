import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIALS_MAX, initialsText, runPreview, wordInitials } from '../src/log/purge-initials.ts';
import { tempStore } from './helpers.ts';

/** A marker only the rows hold: it must never reach the output whole. */
const BAD = 'ZQXBADMARK';

test('first letters: one per whitespace word, Hangul syllable or first letter/digit, punctuation-only chunks skipped', () => {
  // The example the user gave (2026-11-06).
  assert.deepEqual(wordInitials('대화 삭제 테스트해보자. 임의로 점심메뉴 추천해봐'), ['대', '삭', '테', '임', '점', '추']);
  assert.equal(initialsText('대화 삭제 테스트해보자. 임의로 점심메뉴 추천해봐'), '6낱말 — 대 삭 테 임 점 추');
  // English: the first letter, case kept; digits count; leading punctuation is passed over.
  assert.deepEqual(wordInitials('Seoul weather 2026년 "점심" (메뉴) **굵게** #4614'), ['S', 'w', '2', '점', '메', '굵', '4']);
  // Punctuation, symbols and emoji alone are not words; spaces, tabs and newlines all split.
  assert.deepEqual(wordInitials('  가나 — ... 😀 !!\n\t다라  '), ['가', '다']);
  // Hangul jamo alone still counts as a letter.
  assert.deepEqual(wordInitials('ㅋㅋㅋ 좋아'), ['ㅋ', '좋']);
  assert.equal(initialsText(' ... — '), '0낱말 — (낱말 없음)');
  assert.equal(initialsText(''), '0낱말 — (낱말 없음)');
});

test(`first letters: at most ${INITIALS_MAX}, then a mark that the rest was cut`, () => {
  const words = Array.from({ length: 45 }, (_, i) => `낱말${i}`).join(' ');
  const out = initialsText(words);
  assert.equal(out, `45낱말 — ${Array(INITIALS_MAX).fill('낱').join(' ')} …(앞 40낱말)`);
  assert.equal(initialsText(Array(40).fill('가').join(' ')), `40낱말 — ${Array(40).fill('가').join(' ')}`, 'exactly 40: no mark');
});

test('the preview: rows and memories with word count and first letters, no model and no summary line, never the text', () => {
  const s = tempStore();
  const now = Date.now();
  const at = (i: number) => new Date(now - 10_000 + i * 1000).toISOString();
  s.appendLog([
    { session_id: 'p', message_uuid: 'u1', role: 'user', content: '대화 삭제 테스트해보자. 임의로 점심메뉴 추천해봐', created_at: at(0) },
    { session_id: 'p', message_uuid: 'a1', role: 'assistant', content: `Lunch 추천: 김치찌개, 비빔밥! ${BAD}`, created_at: at(1) },
  ]);
  const id = (u: string) => (s.db.prepare('SELECT id FROM raw_log WHERE message_uuid = ?').get(u) as { id: number }).id;
  const mem = s.remember({ kind: 'fact', content: `영상 카드 순서 ${BAD}`, sourceLogId: id('u1') }).id;
  const out = runPreview(s, { kind: 'turns', n: 1 }, { here: 'p', dirs: [] });
  assert.match(out, new RegExp(`^#${id('u1')} 사용자 27자 · 6낱말 — 대 삭 테 임 점 추$`, 'm'));
  assert.match(out, new RegExp(`^#${id('a1')} 비서 \\d+자 · 5낱말 — L 추 김 비 Z$`, 'm'));
  assert.match(out, new RegExp(`^무효 처리할 기억\\(그 턴에 저장된 것\\) 1개:\n기억 #${mem} 19자 · 4낱말 — 영 카 순 Z$`, 'm'));
  assert.match(out, /\n승인 코드: [0-9a-z]{6}\n/);
  assert.doesNotMatch(out, /요약|Haiku/);
  assert.doesNotMatch(out, new RegExp(`${BAD}|삭제|점심|김치|영상`));
});
