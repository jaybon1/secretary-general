import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { promptNotices, boardWaitMs } from '../src/hooks/prompt-notices.ts';
import { HOOK_ERRORS_TOLD_KEY, hookErrorsFile, hookErrorSummary, noteHookError, REPEAT_COUNT } from '../src/core/hook-errors.ts';
import { BACKUP_TOLD_KEY, backupNotice, backupRecordFile, recordBackup } from '../src/core/backup-record.ts';
import path from 'node:path';
import { tempStore } from './helpers.ts';
import { HOOK_NOTICE_KEYS, hookNoticeText } from '../src/core/hook-notice-text.ts';
import { FORMAT_NOTICE_KEYS } from '../src/mistake-guards/answer-check-table.ts';
import { PROJECT_ROOT, PROMPT_HOOK_TIMEOUT_S, PROMPT_HOOK_BUDGET_MS } from '../src/core/config.ts';
import { TIMEOUT_NOTE_LEAD_MS, noteTimeoutSoon } from '../src/hooks/run-hook.ts';
import { BOARD_WAIT_MS } from '../src/session-continuity/situation-board.ts';
import { SEARCH_TIMEOUT_MS } from '../src/semantic-search/client.ts';

// 없으면 놓치는 실수: .agents/hook-notices의 파일이나 `## 항목` 이름이 바뀌어, 훅이 붙이는 안내(상황판 읽는 법, 기억 정리 보고 때 할 일, 답 형식)가 빈 채로 나간다.
test('hook notices: every text a hook reads is in .agents/hook-notices, and a missing one is empty', () => {
  // The answer checks' pieces are listed by their own feature (2026-11-12: core does not import mistake-guards).
  assert.ok(FORMAT_NOTICE_KEYS.length > 0);
  for (const [name, keys] of Object.entries({ ...HOOK_NOTICE_KEYS, 'answer-format': FORMAT_NOTICE_KEYS })) for (const key of keys) assert.ok(hookNoticeText(name, key).length > 10, `${name}.md ## ${key}`);
  assert.equal(hookNoticeText('situation-board', 'no-such-key'), '');
  assert.equal(hookNoticeText('no-such-file', 'reading'), '');
});

// [늘 남김] 없으면 놓치는 실수: 안내 하나(예: DB 잠김으로 실패한 상황판)가 예외를 내면 기억 주입까지 모든 안내가 사라지고, 기록도 없어 비서가 "관련 기억 없음"으로 읽는다.
test('prompt notices: one that throws is left out alone, named in a tag line first, and recorded', async () => {
  const file = hookErrorsFile();
  fs.rmSync(file, { force: true });
  const n = (name: string, text: string) => ({ name, run: () => text });
  const boom = { name: 'situation-board', run: async () => Promise.reject(new Error('database is locked')) };
  const out = await promptNotices({ store: tempStore(), prompt: '질문' }, [n('a', 'A'), boom, n('memory-core', 'M')]);
  const lines = out.split('\n');
  assert.match(lines[0], /^<secretary-hook-error>질문 훅에서 안내 1개가 실패해 이번 질문에 빠졌어요: situation-board — .*recall.*<\/secretary-hook-error>$/);
  assert.ok(lines[0].includes(file), 'the record path is told');
  assert.deepEqual(lines.slice(1), ['A', 'M'], 'the others still go out');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(rec.hook, 'prompt');
  assert.equal(rec.part, 'situation-board');
  assert.equal(rec.error, 'Error: database is locked');
});

// [늘 남김] 없으면 놓치는 실수: 상황판이 300초를 다 기다린 뒤 기억 검색 30초가 더해져 질문 훅 시간 제한(330초)을 넘으면 훅이 끊겨 그 질문의 안내가 모두 빠지고, 끊긴 훅은 아무 기록도 남기지 않는다. 또는 설정의 330초와 코드의 예산이 따로 바뀐다.
test('prompt hook time: settings.json limit and the code agree, the board waits only what the budget leaves, a hook about to be cut is recorded', async () => {
  const settings = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf8'));
  const timeout = settings.hooks.UserPromptSubmit[0].hooks[0].timeout;
  assert.equal(timeout, PROMPT_HOOK_TIMEOUT_S);
  assert.ok(PROMPT_HOOK_BUDGET_MS + TIMEOUT_NOTE_LEAD_MS < timeout * 1000, 'the budget ends before the note and the cut');
  // The board's wait plus one search fits in the budget, whenever it starts.
  for (const elapsed of [0, 1_000, 100_000, 280_000, 400_000]) {
    const wait = boardWaitMs(elapsed);
    assert.ok(wait >= 0 && wait <= BOARD_WAIT_MS, `${elapsed}`);
    if (wait > 0) assert.ok(elapsed + wait + SEARCH_TIMEOUT_MS <= PROMPT_HOOK_BUDGET_MS, `${elapsed}`);
  }
  assert.equal(boardWaitMs(400_000), 0);
  const file = hookErrorsFile();
  fs.rmSync(file, { force: true });
  noteTimeoutSoon('s-timeout', 1);
  await new Promise((r) => setTimeout(r, 30));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual([rec.hook, rec.part, rec.session], ['prompt', 'timeout', 's-timeout']);
  assert.match(rec.error, /시간 제한\(330초\)/);
});

// 없으면 놓치는 실수: 훅 실패가 기록 파일에만 쌓여 아무도 모르거나, 세션이 열릴 때마다 같은 실패를 다시 알리거나, 되풀이되는 실패를 한 번짜리와 구별하지 못한다.
test('session start: the hook failures since the last summary, by hook and part, the repeating ones apart, once', () => {
  const dir = path.dirname(hookErrorsFile());
  for (const f of fs.readdirSync(dir)) if (f.startsWith('hook-errors')) fs.rmSync(path.join(dir, f), { force: true });
  const s = tempStore();
  assert.equal(hookErrorSummary(s), '', 'no record: nothing');
  const now = Date.now();
  noteHookError('prompt', new Error('old one'), 'memory-core', { now: now - 30 * 24 * 3600_000 });
  noteHookError('prompt', new Error('database is locked'), 'situation-board', { now: now - 3000 });
  assert.match(hookErrorSummary(s, now), /^<secretary-hook-error>지난번 알린 뒤 훅 실패 1건\(prompt·situation-board 1건\) · 마지막 [^<]*비서가 알고만 있으면/, 'the first time: the last week only');
  assert.equal(hookErrorSummary(s, now), '', 'told once');
  // Where it got to is in the database's meta, not in a file beside the record.
  assert.ok(s.getMeta(HOOK_ERRORS_TOLD_KEY));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('told')), []);
  for (let i = 1; i < REPEAT_COUNT; i++) noteHookError('prompt', new Error('database is locked'), 'situation-board', { now: now - 2000 + i });
  noteHookError('stop', new Error('other'), undefined, { now: now - 1000 });
  const again = hookErrorSummary(s, now);
  assert.match(again, new RegExp(`훅 실패 ${REPEAT_COUNT}건\\(prompt·situation-board ${REPEAT_COUNT - 1}건, stop 1건\\)`));
  assert.match(again, new RegExp(`되풀이[^:]*: prompt·situation-board "Error: database is locked" ${REPEAT_COUNT}번`));
  assert.match(again, /고칠지 묻는다/, 'the words for a repeating failure');
  assert.doesNotMatch(again, /stop "Error: other"/, 'once is not repeating');
});

// 없으면 놓치는 실수: DB 백업 예약 작업이 외부 기기 연결 안 됨·설정 없음으로 조용히 끝나 며칠째 복사되지 않아도 아무도 모른다(또는 세션마다 같은 말을 되풀이한다).
test('session start: a DB backup or device copy older than three days is told once per new run line', () => {
  const file = backupRecordFile();
  fs.rmSync(file, { force: true });
  const s = tempStore();
  assert.equal(backupNotice(s), '', 'no record: nothing');
  const day = 24 * 3600_000;
  const now = Date.now();
  recordBackup({ backup: 'ok', device: 'ok', kept: 3 }, now - 5 * day);
  recordBackup({ backup: 'ok', device: 'skipped', reason: '기기 pc-a 연결 안 됨', kept: 4 }, now - 2 * day);
  assert.equal(backupNotice(s, now - 2.5 * day), '', 'two and a half days since the last copy: fine');
  recordBackup({ backup: 'ok', device: 'skipped', reason: '기기 pc-a 연결 안 됨', kept: 5 }, now - 1000);
  const told = backupNotice(s, now);
  assert.match(told, /^외부 기기로의 백업 복사가 [^·]+ 뒤로 성공하지 않았어요 · 마지막 실행 \S+ \S+: 백업 ok · 기기 복사 skipped \(기기 pc-a 연결 안 됨\) — /);
  assert.doesNotMatch(told, /DB 백업이/, 'the backup itself went');
  assert.ok(told.includes(file), 'the record path is told');
  assert.equal(backupNotice(s, now), '', 'told once for this run');
  assert.equal(s.getMeta(BACKUP_TOLD_KEY), new Date(now - 1000).toISOString(), 'kept in the database meta');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('told')), [], 'no told file beside the record');
  // A copy without a device (a release): only the backup itself counts.
  fs.rmSync(file, { force: true });
  recordBackup({ backup: 'ok', kept: 3 }, now - 5 * day);
  recordBackup({ backup: 'failed', reason: 'node 종료 코드 1' }, now - 500);
  assert.match(backupNotice(s, now), /^DB 백업이 [^·]+ 뒤로 성공하지 않았어요 · 마지막 실행 \S+ \S+: 백업 failed \(node 종료 코드 1\)/);
  assert.throws(() => recordBackup({ backup: 'done' as 'ok' }), /ok\|failed/);
});
