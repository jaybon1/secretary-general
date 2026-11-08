import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidateNotice, consolidateNudge, isConsolidateConfirm, saveConsolidateReport, unseenReports, type ConsolidateReport } from '../src/memory/consolidate-notice.ts';
import { talk, tempStore } from './helpers.ts';
const report = (over: Partial<ConsolidateReport>): ConsolidateReport => ({ at: new Date().toISOString(), ok: true, text: '보고', fromLogId: 0, throughLogId: 2, ...over });

test('consolidation notice: one line per session per new report, and "기억 정리 확인" hands over the reports once', () => {
  const s = tempStore();
  assert.equal(consolidateNotice(s, 'a', '안녕'), '');
  saveConsolidateReport(s, report({ text: '새 기억 2개' }));
  const line = consolidateNotice(s, 'a', '안녕');
  assert.match(line, /<secretary-consolidate>[^\n]*\/clear 안내가 있으면 그 윗줄[^\n]*"기억 정리가 끝났어요\. 확인하려면 '기억 정리 확인'만 보내 주세요\."/);
  assert.equal(consolidateNotice(s, 'a', '또'), '', 'once per session');
  assert.match(consolidateNotice(s, 'b', '다른 세션'), /기억 정리가 끝났어요/);

  saveConsolidateReport(s, report({ at: new Date(Date.now() + 1000).toISOString(), ok: false, text: 'rate limited', fromLogId: 2 }));
  assert.match(consolidateNotice(s, 'a', '또'), /기억 정리가 실패했어요\(rate limited\)/, 'a newer report is announced again');

  // "기억 정리 확인" quoted by a subagent's report or a task notice does not take the reports.
  const quoted = 'Another Claude session sent a message:\n<agent-message from="add2bf77">\n[Subagent hand-back] 질문 2번(두 번째는 "기억 정리 확인")\n</agent-message>';
  assert.equal(consolidateNotice(s, 'a', quoted), '');
  assert.equal(consolidateNotice(s, 'a', '<task-notification>\n<summary>기억 정리 확인</summary>\n</task-notification>'), '');
  assert.equal(unseenReports(s).length, 2);
  // Inside a sentence it is ordinary talk.
  for (const p of ['기억 정리 확인해 줘', '기억 정리 확인?', '"기억 정리 확인"이 뭐야', '기억 정리 확인 부탁']) assert.equal(consolidateNotice(s, 'a', p), '', p);
  // The old phrase (before 2026-11-06) is ordinary talk.
  for (const p of ['정리 확인', '정리확인']) assert.equal(consolidateNotice(s, 'a', p), '', p);
  assert.equal(unseenReports(s).length, 2);

  const out = consolidateNotice(s, 'a', '기억 정리 확인');
  assert.match(out, /<secretary-consolidate-report>/);
  assert.match(out, /get_profile 전체와 list_big_work 전체/);
  assert.match(out, /정리 끝남 · 대화 #1~#2\]\n새 기억 2개/);
  assert.match(out, /정리 실패[^\n]*\]\nrate limited/);
  assert.deepEqual(unseenReports(s), []);
  assert.equal(consolidateNotice(s, 'a', '기억 정리 확인'), '');

  // Another session's message is not the person's, whatever it starts with (this release has no session that speaks for the person).
  saveConsolidateReport(s, report({ text: '새 기억 1개' }));
  const peer = 'Another Claude session sent a message:\n<agent-message from="relay01">\n[전달]\n기억정리확인\n</agent-message>';
  assert.doesNotMatch(consolidateNotice(s, 'a', peer), /<secretary-consolidate-report>/);
});

test('"기억 정리 확인" counts only as the whole message, spaces anywhere aside; the old "정리 확인" no more', () => {
  for (const p of ['기억 정리 확인', '기억정리확인', ' 기억 정리 확인 ', '기억정리 확인', '\n기억\t정리  확인\n', '기 억 정 리 확 인']) assert.equal(isConsolidateConfirm(p), true, JSON.stringify(p));
  for (const p of ['기억 정리 확인해 줘', '기억 정리 확인.', '"기억 정리 확인"', '그럼 기억 정리 확인', '기억정리확인 좀', '정리 확인', '정리확인', ' 정 리 확 인 ']) assert.equal(isConsolidateConfirm(p), false, p);
});

test('the /consolidate nudge is a fallback: from 120 pending (the idle job did not run), once per session per 60, over after a run', () => {
  const store = tempStore();
  talk(store, 60);
  assert.equal(consolidateNudge(store, 's'), '', 'at 60 the idle job is expected to consolidate by itself');
  talk(store, 59);
  assert.equal(consolidateNudge(store, 's'), '');
  talk(store, 1);
  const nudge = consolidateNudge(store, 's');
  assert.match(nudge, /120건[^\n]*자동 정리가 아직 돌지 않았다[^\n]*Secretary Idle Jobs/);
  assert.match(nudge, /\/clear 안내가 있으면 그 윗줄/);
  assert.equal(consolidateNudge(store, 's'), '');
  assert.match(consolidateNudge(store, 'other'), /120건/);
  talk(store, 60);
  assert.match(consolidateNudge(store, 's'), /180건/);
  store.markConsolidated(store.logAfter(0).at(-1)!.id);
  talk(store, 60);
  assert.equal(consolidateNudge(store, 's'), '');
  talk(store, 60);
  assert.match(consolidateNudge(store, 's'), /120건/);
});
