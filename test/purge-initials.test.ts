import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPreview } from '../src/log/purge-initials.ts';
import { tempStore } from './helpers.ts';

/** A marker only the rows hold: it must never reach the output whole. */
const BAD = 'ZQXBADMARK';

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
  assert.match(out, new RegExp(`^#${id('u1')} 사용자 27자 · 6단어 — 대 삭 테 임 점 추$`, 'm'));
  assert.match(out, new RegExp(`^#${id('a1')} 비서 \\d+자 · 5단어 — L 추 김 비 Z$`, 'm'));
  assert.match(out, new RegExp(`^무효 처리할 기억\\(그 턴에 저장된 것\\) 1개:\n기억 #${mem} 19자 · 4단어 — 영 카 순 Z$`, 'm'));
  assert.match(out, /\n승인 코드: [0-9a-z]{6}\n/);
  assert.doesNotMatch(out, /요약|Haiku/);
  assert.doesNotMatch(out, new RegExp(`${BAD}|삭제|점심|김치|영상`));
});
