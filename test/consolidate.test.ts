import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { consolidateLineShown, consolidateNotice, saveConsolidateReport, unseenReports, type ConsolidateReport } from '../src/memory/consolidate-notice.ts';
import { planJudgement, type Duration, type Plan, type VerdictInput } from '../src/memory/consolidate-verdicts.ts';
import type { Memory } from '../src/store/store.ts';
import { talk, tempStore } from './helpers.ts';
const report = (over: Partial<ConsolidateReport>): ConsolidateReport => ({ at: new Date().toISOString(), ok: true, text: '보고', fromLogId: 0, throughLogId: 2, ...over });

// 없으면 놓치는 실수: 정리 안내 줄은 "다음 행동 및 순서: 없음"인 답에만 붙는데(2026-11-14 사용자 결정) 세션마다 한 번만 주면, 할 일이 있는 답이
// 그 줄을 빼는 순간 다시 나오지 않아 사용자가 정리 보고를 못 본다.
test('consolidation notice: the line is asked for until an answer of the session carries it, and "기억 정리 확인" hands over the reports once', () => {
  const s = tempStore();
  assert.equal(consolidateNotice(s, 'a', '안녕'), '');
  saveConsolidateReport(s, report({ text: '새 기억 2개' }));
  const line = consolidateNotice(s, 'a', '안녕');
  assert.match(line, /<secretary-consolidate>[^\n]*"없음"인 답에만[^\n]*\/clear 안내가 있으면 그 윗줄[^\n]*"기억 정리가 끝났어요\. 필요하신 경우 '기억 정리 확인'을 보내 주세요\."[^\n]*할 일이 있는 답에는 붙이지 않는다/);
  consolidateLineShown(s, 'a', '답\n\n다음 행동 및 순서:\n1. 확인하기');
  assert.match(consolidateNotice(s, 'a', '또'), /기억 정리가 끝났어요/, 'asked again until an answer carries it');
  consolidateLineShown(s, 'a', "답\n\n기억 정리가 끝났어요. 필요하신 경우 '기억 정리 확인'을 보내 주세요.\n\n다음 행동 및 순서: 없음");
  assert.equal(consolidateNotice(s, 'a', '또'), '', 'shown in this session');
  assert.match(consolidateNotice(s, 'b', '다른 세션'), /기억 정리가 끝났어요/);

  saveConsolidateReport(s, report({ at: new Date(Date.now() + 1000).toISOString(), ok: false, text: 'rate limited', fromLogId: 2 }));
  assert.match(consolidateNotice(s, 'a', '또'), /기억 정리가 실패했어요\(rate limited\)/, 'a newer report is announced again');

  // "기억 정리 확인" quoted by a subagent's report or a task notice does not take the reports.
  const quoted = 'Another Claude session sent a message:\n<agent-message from="add2bf77">\n[Subagent hand-back] 질문 2번(두 번째는 "기억 정리 확인")\n</agent-message>';
  const REPORT = /<secretary-consolidate-report>/;
  assert.doesNotMatch(consolidateNotice(s, 'a', quoted), REPORT);
  assert.doesNotMatch(consolidateNotice(s, 'a', '<task-notification>\n<summary>기억 정리 확인</summary>\n</task-notification>'), REPORT);
  assert.equal(unseenReports(s).length, 2);
  // Inside a sentence it is ordinary talk.
  for (const p of ['기억 정리 확인해 줘', '기억 정리 확인?', '"기억 정리 확인"이 뭐야', '기억 정리 확인 부탁']) assert.doesNotMatch(consolidateNotice(s, 'a', p), REPORT, p);
  // The old phrase (before 2026-11-06) is ordinary talk.
  for (const p of ['정리 확인', '정리확인']) assert.doesNotMatch(consolidateNotice(s, 'a', p), REPORT, p);
  assert.equal(unseenReports(s).length, 2);

  const out = consolidateNotice(s, 'a', '기억 정리 확인');
  assert.match(out, /<secretary-consolidate-report>/);
  assert.match(out, /get_profile/);
  assert.match(out, /정리 끝남 · 대화 #1~#2\]\n새 기억 2개/);
  assert.match(out, /정리 실패[^\n]*\]\nrate limited/);
  assert.deepEqual(unseenReports(s), []);
  assert.equal(consolidateNotice(s, 'a', '기억 정리 확인'), '');

  // Another session's message is not the person's, whatever it starts with (this release has no session that speaks for the person).
  saveConsolidateReport(s, report({ text: '새 기억 1개' }));
  const peer = 'Another Claude session sent a message:\n<agent-message from="relay01">\n[전달]\n기억정리확인\n</agent-message>';
  assert.doesNotMatch(consolidateNotice(s, 'a', peer), /<secretary-consolidate-report>/);
});

// [늘 남김] 없으면 놓치는 실수: 정리 담당의 판정을 코드가 작업으로 잘못 바꿔, 옛 상태가 대체되지 않고 남거나("UAC 꺼짐" 기억이
// UAC를 켠 뒤에도 남음) 같은 내용이 두 번 저장되거나, 늦게 정리된 옛 말이 그 뒤에 말한 지금 값을 덮는다(2026-11-13 평가 I).
// 출처 재검토 고칠 것(2026-11-13 사용자 결정): 그 일 한 번(once)의 예외가 늘 따르는 규칙을 대체함(C3), 잘못 적은 번호 하나로
// 보여 주지 않은 기억이 대체됨(C2), 여러 결정이 든 옛 기억이 통째로 무효가 돼 바뀌지 않은 결정이 사라짐(C4), 대화 중 저장한 기억이
// 후보의 일부만 담았을 때 나머지가 버려짐(C5).
test('consolidation verdicts become actions: changes/ends replace with what still holds kept, repeats save only what they add, once replaces nothing, a later memory stays', () => {
  const at = (d: string) => `2026-11-${d}T00:00:00.000Z`;
  const rows: Array<[number, string, string, string | null]> = [
    [1, 'fact', '01', null],
    [2, 'action', '01', null],
    [3, 'event', '01', null],
    [4, 'decision', '20', null],
    [5, 'fact', '01', at('02')],
    [6, 'decision', '01', null],
  ];
  const mems = new Map(rows.map(([id, kind, d, validTo]) => [id, { id, kind, content: `기억 ${id}`, tags: '', valid_from: at('01'), created_at: at(d), valid_to: validTo, superseded_by: null } as unknown as Memory]));
  const c = { kind: 'decision' as const, content: '후보', saidAt: at('10') };
  const shown = new Set([1, 2, 3, 4, 5]);
  const plan = (duration: Duration, verdicts: VerdictInput[], required = [1, 2, 3], adds?: string) => planJudgement(c, { duration, verdicts, adds }, required, shown, (id) => mems.get(id));
  const v = (id: number, verdict: VerdictInput['verdict'], rest?: string) => ({ id, verdict, ...(rest ? { rest } : {}) });
  const error = (j: ReturnType<typeof plan>) => ('error' in j ? j.error : '');
  const base = { rests: [], repeats: [], keptNewer: [], keptForOnce: [], ignored: [] };

  // changes and ends both replace the old memory with the saved candidate; unrelated leaves it.
  assert.deepEqual(plan('lasting', [v(1, 'changes'), v(2, 'ends'), v(3, 'unrelated')]), { ...base, save: { kind: 'decision', content: '후보', supersedes: [1, 2] } });
  // C4: what still holds in a replaced memory is kept (rest); a rest that copies the old memory whole is refused.
  assert.deepEqual((plan('lasting', [v(1, 'changes', '나머지 결정'), v(2, 'ends'), v(3, 'unrelated')]) as Plan).rests, [{ id: 1, content: '나머지 결정' }]);
  assert.match(error(plan('lasting', [v(1, 'changes', '기억 1'), v(2, 'unrelated'), v(3, 'unrelated')])), /#1의 rest가 옛 기억 글 그대로/);
  // C3: once (a permission for that one job) is an event and replaces nothing, even judged changes or ends.
  assert.deepEqual(plan('once', [v(1, 'changes'), v(2, 'ends'), v(3, 'unrelated')]), { ...base, keptForOnce: [1, 2], save: { kind: 'event', content: '후보', supersedes: [] } });
  // repeats: nothing new is saved; an old state it ends is replaced by the memory that already says it.
  assert.deepEqual(plan('lasting', [v(1, 'repeats'), v(2, 'ends'), v(3, 'unrelated')]), { ...base, repeats: [1], replaceWith: { by: 1, ids: [2] } });
  // C5: with repeats, what the candidate adds is saved by itself.
  assert.deepEqual((plan('lasting', [v(1, 'repeats'), v(2, 'unrelated'), v(3, 'unrelated')], [1, 2, 3], '더한 내용') as Plan).save, { kind: 'decision', content: '더한 내용', supersedes: [] });
  // C1: a memory said after the candidate (its time, not a date the model wrote) is not replaced by older news.
  assert.deepEqual(plan('lasting', [v(1, 'unrelated'), v(2, 'unrelated'), v(3, 'unrelated'), v(4, 'changes')], [1, 2, 3, 4]), { ...base, keptNewer: [4], save: { kind: 'event', content: '후보', supersedes: [] } });
  // Refused: a listed memory without a verdict, one judged twice, a made-up id, a real memory that was not shown (C2).
  assert.match(error(plan('lasting', [v(1, 'changes')])), /판정이 빠진 기억: #2, #3/);
  assert.match(error(plan('lasting', [v(1, 'changes'), v(1, 'unrelated'), v(2, 'unrelated'), v(3, 'unrelated')])), /판정이 둘: #1/);
  assert.match(error(plan('lasting', [v(1, 'unrelated'), v(2, 'unrelated'), v(3, 'unrelated'), v(99, 'ends')])), /없는 기억 번호: #99/);
  assert.match(error(plan('lasting', [v(1, 'unrelated'), v(2, 'unrelated'), v(3, 'unrelated'), v(6, 'changes')])), /보여 준 목록 밖의 번호: #6/);
  assert.equal(mems.get(6)!.valid_to, null);
  assert.ok('save' in plan('lasting', [v(1, 'unrelated')], [1, 5]), 'an invalid listed memory needs no verdict');
  assert.deepEqual((plan('lasting', [v(1, 'unrelated'), v(5, 'ends')], [1, 5]) as Plan).ignored, [5]);
});
