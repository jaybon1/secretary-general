import { quoteNote } from '../src/memory/source-quote.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { consolidateNotice, consolidateNudge, isConsolidateConfirm, saveConsolidateReport, unseenReports, type ConsolidateReport } from '../src/memory/consolidate-notice.ts';
import { CandidateBook, planJudgement, type Duration, type JudgeInput, type Plan, type VerdictInput } from '../src/memory/consolidate-verdicts.ts';
import { readTally, tallyLine } from '../src/memory/consolidate-tally.ts';
import type { Memory, Store } from '../src/store/store.ts';
import { talk, tempStore } from './helpers.ts';
const report = (over: Partial<ConsolidateReport>): ConsolidateReport => ({ at: new Date().toISOString(), ok: true, text: '보고', fromLogId: 0, throughLogId: 2, ...over });

// 없으면 놓치는 실수: 정리 담당·비서가 비서의 추천을 사용자 결정(decision)으로 적어, 고르지 않은 안이 사용자가 정한 것으로 읽힌다.
test('the consolidation steps and the remember tool keep decisions for what the user chose', () => {
  const procedure = fs.readFileSync(path.join(PROJECT_ROOT, '.agents', 'skills', 'consolidate', 'references', 'procedure.md'), 'utf8');
  const tools = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'mcp', 'memory-tools.ts'), 'utf8');
  for (const text of [procedure, tools]) assert.match(text, /decision에는 사용자가 고르거나 말한 것만[^\n]*비서가 ~를 권함[^\n]*note/);
});

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

test('"기억 정리 확인" counts only as the whole message, spaces anywhere aside', () => {
  for (const p of ['기억 정리 확인', '기억정리확인', ' 기억 정리 확인 ', '기억정리 확인', '\n기억\t정리  확인\n', '기 억 정 리 확 인']) assert.equal(isConsolidateConfirm(p), true, JSON.stringify(p));
  for (const p of ['기억 정리 확인해 줘', '기억 정리 확인.', '"기억 정리 확인"', '그럼 기억 정리 확인', '기억정리확인 좀']) assert.equal(isConsolidateConfirm(p), false, p);
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

// 없으면 놓치는 실수: 판정이 빠진 답을 그대로 저장하거나, 거절한 뒤 후보가 사라져 다시 판정할 수 없거나, 후보를 낸 뒤 비서가 대화 중 저장한
// 가까운 기억을 판정 없이 지나치거나, 모델이 적은 날짜로 때를 견줘 옛 말이 지금 값을 덮는다(C1).
test('the candidate book takes the time from the conversation row, lists close memories with the time mark, refuses a missing verdict and keeps the candidate, and applies the judged one', async () => {
  const s = tempStore();
  talk(s, 5, Date.parse('2026-10-25T00:00:00Z'));
  talk(s, 5, Date.parse('2026-10-30T00:00:00Z'));
  const near = (ids: number[]) => async (store: Store) => ({ memories: ids.map((id) => store.getMemory(id)!) });
  await assert.rejects(new CandidateBook(s, near([])).propose({ kind: 'fact', content: 'x', sourceLogId: 900099 }), /대화 #900099이 없음/);
  const old = s.remember({ kind: 'fact', content: '시험 PC의 UAC는 꺼져 있다', validFrom: '2026-10-24T00:00:00Z', sourceLogId: 1 }).id;
  // Said at #8 (10-30), after the candidate's row (10-25), although its valid_from says earlier: the row decides.
  const later = s.remember({ kind: 'fact', content: '시험 PC의 UAC 확인은 다음 주에 한다', validFrom: '2026-10-01T00:00:00Z', sourceLogId: 8 }).id;
  let ids = [old, later];
  const book = new CandidateBook(s, async (store) => near(ids)(store));
  const shown = await book.propose({ kind: 'event', content: 'UAC를 켰다', sourceLogId: 3 });
  assert.match(shown, /후보 C1 \(event, 근거 #3\)/);
  const line = (id: number) => shown.split('\n').find((l) => l.startsWith(`#${id} `)) ?? '';
  assert.match(line(later), /\(이 후보보다 나중에 말해짐\)/);
  assert.doesNotMatch(line(old), /나중에 말해짐/);
  const judge = (verdicts: VerdictInput[], more: Partial<JudgeInput> = {}) => book.judge('C1', { duration: 'lasting', about: 'UAC', verdicts, ...more });
  const missing = await judge([{ id: old, verdict: 'ends' }]);
  assert.equal(missing.ok, false);
  assert.match(missing.text, new RegExp(`판정이 빠진 기억: #${later}`));
  assert.deepEqual(book.pending(), ['C1'], 'a refused candidate stays open');
  // The secretary saves a close memory in a chat meanwhile: it has to be judged too, and may be once it was shown.
  const chat = s.remember({ kind: 'fact', content: 'UAC를 켜서 비서가 일반 권한으로 돈다', validFrom: '2026-10-25T01:00:00Z', sourceLogId: 4 }).id;
  ids = [chat, old, later];
  const again = await judge([{ id: old, verdict: 'ends' }, { id: later, verdict: 'unrelated' }]);
  assert.match(again.text, new RegExp(`판정이 빠진 기억: #${chat}`));
  assert.match(again.text, /후보를 낸 뒤 새로 생긴 가까운 기억/);
  const done = await judge([{ id: old, verdict: 'ends', about: '시험 PC의 UAC' }, { id: later, verdict: 'unrelated' }, { id: chat, verdict: 'unrelated' }]);
  assert.equal(done.ok, true);
  assert.match(done.text, /대상: 후보 "UAC" \/ #\d+ "시험 PC의 UAC"/, 'the names side by side (C8)');
  const saved = done.applied!.saved!;
  assert.equal(s.getMemory(old)!.superseded_by, saved);
  assert.equal(s.getMemory(saved)!.source_log_id, 3);
  assert.equal(s.getMemory(saved)!.valid_from, '2026-10-25T00:00:00.000Z', 'valid_from is the row time');
  assert.deepEqual(book.pending(), []);
  assert.equal((await judge([])).ok, false, 'judged once');
  // C4: one decision of a memory that holds two changes; the other stays live as a memory of its own, its history kept.
  const two = s.remember({ kind: 'decision', content: 'K1 화면은 세로로 둔다. 채널 이름은 영상 처음과 끝에만 넣는다.', tags: ['영상', 'K1'], validFrom: '2026-10-20T00:00:00Z', sourceLogId: 2 }).id;
  ids = [two];
  // 없으면 놓치는 실수: 정리 담당이 비서의 추천이나 덧붙인 말을 사용자 결정으로 남긴다(2026-11-13 사용자 결정): 결정 후보는 사용자 말의 발췌와 함께, 근거 대화에 글자 그대로 없으면 거절해 다시 내게 한다.
  await assert.rejects(book.propose({ kind: 'decision', content: '채널 이름은 영상에 넣지 않는다', sourceLogId: 5 }), /quote/);
  await assert.rejects(book.propose({ kind: 'decision', content: '채널 이름은 영상에 넣지 않는다', sourceLogId: 5, quote: '채널 이름 빼자' }), /글자 그대로 없다/);
  await book.propose({ kind: 'decision', content: '채널 이름은 영상에 넣지 않는다', sourceLogId: 5, quote: '말' });
  const split = await book.judge('C2', { duration: 'lasting', about: '채널 이름', verdicts: [{ id: two, verdict: 'changes', rest: 'K1 화면은 세로로 둔다.' }] });
  assert.equal(split.ok, true, split.text);
  const [r] = split.applied!.rests;
  assert.equal(r.old, two);
  const rest = s.getMemory(r.id)!;
  assert.deepEqual([rest.kind, rest.content, rest.tags, rest.valid_from, rest.source_log_id, rest.valid_to], ['decision', 'K1 화면은 세로로 둔다.', '영상 k1', '2026-10-20T00:00:00.000Z', 2, null]);
  assert.match(s.getMemory(two)!.invalid_reason!, new RegExp(`superseded by #${split.applied!.saved} · 바뀌지 않은 나머지 → #${r.id}`));
  assert.equal(quoteNote(s, split.applied!.saved!), '  원문 #5 1줄: "말"');
  // A repeat of a memory already there: nothing saved, the old state it ends points at that memory.
  const old2 = s.remember({ kind: 'action', content: 'BIOS 정전 자동 켜짐을 설정해야 한다', validFrom: '2026-10-16T00:00:00Z', sourceLogId: 1 }).id;
  const chat2 = s.remember({ kind: 'event', content: 'BIOS 정전 자동 켜짐을 켰다', validFrom: '2026-11-01T20:54:00Z', sourceLogId: 2 }).id;
  ids = [chat2, old2];
  await book.propose({ kind: 'event', content: 'BIOS 정전 뒤 자동 켜짐을 켰다', sourceLogId: 6 });
  const max = s.maxMemoryId();
  const rep = await book.judge('C3', { duration: 'lasting', about: 'BIOS 정전 자동 켜짐', verdicts: [{ id: chat2, verdict: 'repeats' }, { id: old2, verdict: 'ends' }] });
  assert.match(rep.text, /저장 안 함/);
  assert.equal(s.maxMemoryId(), max, 'no second copy');
  assert.equal(s.getMemory(old2)!.superseded_by, chat2);
  // Withdrawn: nothing written, nothing left open, the reason handed back for the count (C10).
  await book.propose({ kind: 'note', content: '버릴 후보', sourceLogId: 9 });
  const gone = await book.judge('C4', { duration: 'lasting', about: '후보', verdicts: [], withdrawReason: '일회성 잡담' });
  assert.match(gone.text, /버림/);
  assert.deepEqual(gone.withdrawn, { key: 'C4', reason: '일회성 잡담' });
  assert.equal(s.maxMemoryId(), max);
  assert.deepEqual(book.pending(), []);
  assert.match(tallyLine({ ...readTally(s), withdrawn: ['C4: 일회성 잡담'], halted: ['서버 응답 없음'] }), /판정 없이 버린 후보 1개[^\n]*\n버린 후보: C4: 일회성 잡담\n정리 멈춤: 서버 응답 없음$/);
});

// 없으면 놓치는 실수: 의미 검색 서버가 응답하지 않을 때 정리 담당이 단어 검색만으로 가까운 기억을 찾아, 글자가 다른 옛 상태 기억을 판정 없이
// 지나치고 정리 위치까지 옮긴다(출처 재검토 C9, 2026-11-13 사용자 결정).
test('the candidate book waits for the semantic-search server, and stops the run when it never answers', async () => {
  const s = tempStore();
  talk(s, 3);
  let answers = false;
  let polls = 0;
  const stops: string[] = [];
  const search = async () => (answers ? { memories: [] } : { memories: [], miss: '서버가 모델을 불러오는 중' });
  const wait = (readyAfter: number) => ({ ms: 60_000, pollMs: 5_000, sleep: async () => {}, ready: () => ++polls >= readyAfter && (answers = true), onStop: (r: string) => stops.push(r) });
  const waits = new CandidateBook(s, search, wait(3));
  assert.match(await waits.propose({ kind: 'fact', content: '사실', sourceLogId: 1 }), /후보 C1/);
  assert.equal(polls, 3, 'polled until the server answered');
  assert.equal(waits.halted, undefined);

  answers = false;
  polls = 0;
  const stops0 = new CandidateBook(s, search, wait(Infinity));
  await assert.rejects(stops0.propose({ kind: 'fact', content: '사실', sourceLogId: 1 }), /1분 기다려도 응답하지 않아 정리를 멈춤\(처음 이유: 서버가 모델을 불러오는 중[^\n]*mark_consolidated도 부르지 말고/);
  assert.equal(polls, 12, 'the whole wait, a poll every 5 s');
  assert.equal(stops.length, 1);
  assert.match(stops0.halted!, /정리를 멈춤/);
  await assert.rejects(stops0.propose({ kind: 'fact', content: '다음 후보', sourceLogId: 2 }), /정리를 멈춤/, 'no more candidates');
  assert.equal(s.maxMemoryId(), 0, 'nothing saved');
});
