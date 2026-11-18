import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, testStore } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { isShieldedLocal, writeLocalJson } from '../src/core/local-settings.ts';
import { carryOverQuestions, parseQuestions, openQuestionLines } from '../src/store/open-questions.ts';
import { checkAnswer, checkBasisSource, checkReportJudgment, questionBlocks, questionsWithoutJudgment, checkDependentQuestions, checkInventedWords, checkReportRelay, inventedWordsIn, checkBasisUnopened, checkEnglish, checkPaths, checkRecommendBasis, hangulRatio, unbackedPicks } from '../src/mistake-guards/answer-checks.ts';
import { commandPlaceProblem, mentionedPaths, writePlaceProblem } from '../src/mistake-guards/folder-place.ts';
import { labelNotice, nextLabel, noteAnswerLabels, startLabelsAfter } from '../src/store/open-questions.ts';
import { preToolProblem } from '../src/mistake-guards/pre-tool-hook.ts';
import { DEFAULT_LEVELS, guardsOn, readGuardSettings, type GuardSettings } from '../src/mistake-guards/mistake-guard-settings.ts';
import { guardWarnNotice, stopGuard, FILL_HEAD } from '../src/mistake-guards/stop-guard.ts';
import { type Line, type Turn } from '../src/mistake-guards/last-turn.ts';
import { seenSinceCompaction } from '../src/mistake-guards/seen-sources.ts';
import { addInventedWords, baseInventedWords, inventedWords } from '../src/mistake-guards/invented-words.ts';
import { formatMistake } from '../src/mcp/mistake-tools.ts';

/** A results parent folder like the real one: a few places already there. */
function aiRootWith(...names: string[]): string {
  const root = tempDir('guards-ai-');
  for (const n of names) fs.mkdirSync(path.join(root, n), { recursive: true });
  return root;
}

const OTHER = 'Y:\\results';
const roots = (aiRoot: string, extra: Partial<GuardSettings> = {}): GuardSettings => ({
  on: true,
  levels: { ...DEFAULT_LEVELS },
  aiRoot,
  otherPcRoot: OTHER,
  phoneRoot: null,
  ...extra,
});

// ---- the answer's language ------------------------------------------------------------------------------------------

// [늘 남김] 없으면 놓치는 실수: 코드와 끝 줄이 든 한국어 답을 영어 답으로 잘못 막거나, 짧은 영어 답을 놓친다(훅이 턴을 잘못 막음).
test('english: a short English answer is caught (no length floor), a Korean one with code and closing lines is not', () => {
  assert.equal(checkEnglish("I'll wait for the background notification.")?.check, 'english');
  // English body, Korean closing lines (they are left out of the count).
  assert.equal(checkEnglish('The watcher finished because the worker went idle.\n\n남은 질문: F, G\n\n다음 행동 및 순서: 없음')?.check, 'english');
  const korean = [
    '테스트 23개를 모두 통과했어요. `npm test`와 `npm run typecheck` 출력은 아래와 같아요.',
    '```',
    'ℹ pass 23',
    'ℹ fail 0',
    'All tests passed without any warnings or problems at all in the repository',
    '```',
    'C:\\Users\\someone\\Documents\\results\\workspaces\\x\\REPORT.md 에 보고서가 있어요.',
    '다음 행동 및 순서: 없음',
  ].join('\n');
  assert.equal(checkEnglish(korean), null);
  // Korean with English names in it stays Korean.
  assert.equal(checkEnglish('Claude Code 2.3 업데이트 뒤 PreToolUse 훅이 잘 돌아요. MCP 서버도 다시 켰어요.'), null);
  // What the app writes in the model's place is not the model's English.
  for (const s of ["You've hit your session limit · resets 7:20pm (Asia/Seoul)", 'API Error: 500 {"type":"error"}', 'Prompt is too long']) assert.equal(checkEnglish(s), null, s);
  // Nothing to judge: no letters, or only code.
  assert.equal(checkEnglish('```\nnpm test\n```'), null);
  assert.equal(hangulRatio('👍'), null);
});

// ---- paths in the answer --------------------------------------------------------------------------------------------

// [늘 남김] 없으면 놓치는 실수: 결과물이 아닌 경로(비서 폴더 안 백업 파일)에 [폰에서 열기](폰 주소) 링크를 달면 링크 이름 검사를 건너뛰어, 어디로
// 가는지 안 보이는 링크가 그대로 나간다. 반대로 폰 주소가 아닌 링크, 이름이 주소인 링크, 이름이 맞는 링크가 같은 주소로 함께 있는 답까지 막아 턴을 잘못 멈춘다.
test('paths: a phone link to any folder is named by its address; other links and rightly named ones pass', () => {
  const ai = path.join(os.tmpdir(), 'results');
  const at = (rel: string) => path.join(ai, rel);
  const linkTo = (a: string) => `[${a}](${a})`;
  const ownPhone = roots(ai, { secretaryDir: at('secretary-1'), phoneRoot: 'https://pc.example.ts.net/share/results' });
  const BACKUP = 'https://pc.example.ts.net/share/results/secretary-1/backups/Secretary-Backup.db';
  const ownBlock = ['```', at('secretary-1\\backups\\Secretary-Backup.db'), '```'].join('\n');
  const ownMisnamed = checkPaths(`${ownBlock}\n[폰에서 열기](${BACKUP})`, ownPhone);
  assert.deepEqual(ownMisnamed.map((f) => f.check), ['path-link']);
  assert.match(ownMisnamed[0].reason, /링크 이름이 주소가 아니다: secretary-1\/backups\/Secretary-Backup\.db/);
  assert.deepEqual(checkPaths(`[폰에서 열기](${BACKUP})`, ownPhone).map((f) => f.check), ['path-link']);
  assert.deepEqual(checkPaths(`${ownBlock}\n${linkTo(BACKUP)}`, ownPhone), []);
  assert.deepEqual(checkPaths(`${ownBlock}\n[폰에서 열기](${BACKUP})\n${linkTo(BACKUP)}`, ownPhone), []);
  assert.deepEqual(checkPaths(`${ownBlock}\n[공식 문서](https://docs.example.com/guide)`, ownPhone), []);
  assert.deepEqual(checkPaths(ownBlock, ownPhone), []);

});
// [늘 남김] 없으면 놓치는 실수: 테스트가 이 PC의 실제 설정 파일을 읽어 PC마다 결과가 달라지거나, 그 파일을 고쳐 쓴다(자료 유실).
test('this PC: its own this-secretary.local.json and scripts/*.local.json are never read or written by tests, a temp copy\'s are', () => {
  const own = path.join(PROJECT_ROOT, 'scripts', 'mistake-guards.local.json');
  assert.equal(isShieldedLocal(own), true);
  assert.equal(isShieldedLocal(path.join(PROJECT_ROOT, 'this-secretary.local.json')), true);
  assert.equal(isShieldedLocal(path.join(tempDir(), 'this-secretary.local.json')), false);
  assert.equal(isShieldedLocal(path.join(PROJECT_ROOT, 'scripts', 'lib', 'providers.json')), false);
  assert.equal(isShieldedLocal(path.join(tempDir(), 'scripts', 'mistake-guards.local.json')), false);
  const s = readGuardSettings();
  assert.deepEqual(s.levels, DEFAULT_LEVELS, 'the defaults, whatever this PC has set');
  assert.equal(s.otherPcRoot, null);
  assert.throws(() => writeLocalJson(path.join(PROJECT_ROOT, 'scripts', 'usage.local.json'), {}), /쓰지 않음/);
});

// ---- the turn from the transcript -----------------------------------------------------------------------------------

const line = (o: object) => JSON.stringify({ sessionId: 's1', timestamp: new Date().toISOString(), ...o });
const userSays = (uuid: string, text: string) => line({ type: 'user', uuid, message: { role: 'user', content: text } });
const says = (uuid: string, text: string, extra: object = {}) => line({ type: 'assistant', uuid, message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] }, ...extra });

// ---- the Stop hook's verdict ----------------------------------------------------------------------------------------

const turnOf = (answer: string, extra: Partial<Turn> = {}): Turn => ({ startUuid: 'u9', startText: 'q', tools: ['Read', 'mcp__secretary__recall'], answer, synthetic: false, lastUuid: 'a9', ...extra });

// [늘 남김] 없으면 놓치는 실수: 되돌린 답을 Stop 훅이 또 막아 턴이 끝나지 않는다(훅이 턴을 잘못 막음).
test('stop: an English answer is sent back once; the second stop lets it end, records the turn and tells the next prompt', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const first = stopGuard(store, { session_id: 's1' }, { settings, turn: turnOf("I'll wait for the background notification.") });
  assert.match(first.block ?? '', /^\[답변 검사·Stop 훅\][^]*한국어로 다시 써서/);
  assert.equal(store.turnTools().length, 0, 'nothing recorded while the turn goes on');
  // Still English after being sent back: it ends now (no loop), and the next prompt is told.
  const second = stopGuard(store, { session_id: 's1', stop_hook_active: true }, { settings, turn: turnOf('Still English, sorry.') });
  assert.equal(second.block, undefined);
  assert.equal(second.startText, 'q', 'the end notice reads what started the turn');
  const [row] = store.turnTools();
  assert.deepEqual(row.tools, ['Read', 'mcp__secretary__recall']);
  assert.deepEqual(row.guard, [{ check: 'english', level: 'block' }, { check: 'english', level: 'warn' }]);
  assert.match(guardWarnNotice(store, 's1'), /^<secretary-answer-check>\n지난 답변 검사[^]*영어로 쓰였다/);
  assert.equal(guardWarnNotice(store, 's1'), '', 'told once');
  // Fixed after being sent back: the record keeps the block only.
  stopGuard(store, { session_id: 's2' }, { settings, turn: turnOf('Done.', { startUuid: 'v1' }) });
  stopGuard(store, { session_id: 's2', stop_hook_active: true }, { settings, turn: turnOf('끝났어요.', { startUuid: 'v1' }) });
  assert.deepEqual(store.turnTools({ sessionId: 's2' })[0].guard, [{ check: 'english', level: 'block' }]);
  // A warn-level finding never sends the turn back (a level set to warn here).
  const ai = settings.aiRoot;
  const warnOnly = stopGuard(store, { session_id: 's3' }, { settings: { ...settings, levels: { ...settings.levels, 'path-pair': 'warn' } }, turn: turnOf(['결과예요.', '```', path.join(ai, 'workspaces', 'a', 'R.md'), '```'].join('\n'), { startUuid: 'w1' }) });
  assert.equal(warnOnly.block, undefined);
  assert.deepEqual(store.turnTools({ sessionId: 's3' })[0].guard, [{ check: 'path-pair', level: 'warn' }]);
  // Levels: off drops a check; the feature off drops all (and records nothing).
  assert.equal(stopGuard(store, { session_id: 's4' }, { settings: { ...settings, levels: { ...settings.levels, english: 'off' } }, turn: turnOf('English.', { startUuid: 'x1' }) }).block, undefined);
  assert.equal(stopGuard(store, { session_id: 's5' }, { settings: { ...settings, on: false }, turn: turnOf('English.') }).block, undefined);
  assert.equal(store.turnTools({ sessionId: 's5' }).length, 0);
  // The app's own line (usage limit) is never checked.
  assert.equal(stopGuard(store, { session_id: 's6' }, { settings, turn: turnOf("You've hit your limit", { synthetic: true }) }).block, undefined);
});

// [늘 남김] 없으면 놓치는 실수: 다시 쓴 답이나 서브에이전트의 답을 또 막거나, 알리기만 할 단계(warn)에서 턴을 막는다(훅이 턴을 잘못 막음).
test('stop: the form checks send the turn back once (never again on the retry, never inside a subagent), and a level set to warn only tells', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const noEnd = ['테스트를 다 돌렸어요.', '```', path.join(settings.aiRoot, 'notes', 'r.md'), '```', '남은 일은 없어요.'].join('\n');
  const first = stopGuard(store, { session_id: 'f1' }, { settings, turn: turnOf(noEnd, { startUuid: 'g1' }) });
  assert.match(first.block ?? '', /^\[답변 검사·Stop 훅\][^]*다른 PC 경로 줄이 빠졌다/);
  // The retry still lacks it: it ends now and the next prompt is told.
  const retry = stopGuard(store, { session_id: 'f1', stop_hook_active: true }, { settings, turn: turnOf('그래도 빠졌어요.\n둘째 줄.\n셋째 줄.', { startUuid: 'g1' }) });
  assert.equal(retry.block, undefined);
  assert.deepEqual(retry.caught?.map((c) => `${c.check}:${c.level}`), ['path-pair:block']);
  assert.match(guardWarnNotice(store, 'f1'), /다른 PC 경로 줄이 빠졌다/);
  // Inside a subagent nothing is sent back.
  assert.equal(stopGuard(store, { session_id: 'f2', agent_id: 'sub1' }, { settings, turn: turnOf(noEnd, { startUuid: 'g2' }) }).block, undefined);
  // A result path without its link line (with a phone address set) is only told by default (path-link is warn).
  const phone = { ...settings, phoneRoot: 'https://pc.example.ts.net/share/results' };
  const at = path.join(settings.aiRoot, 'notes', 'a.md');
  const NOTE = 'https://pc.example.ts.net/share/results/notes/a.md';
  const paths = ['노트를 정리했어요.', '```', at, '```', '```', `${OTHER}\\notes\\a.md`, '```', '', '다음 행동 및 순서: 없음'].join('\n');
  const linkMissing = stopGuard(store, { session_id: 'f3' }, { settings: phone, turn: turnOf(paths, { startUuid: 'g3' }) });
  assert.equal(linkMissing.block, undefined);
  assert.deepEqual(linkMissing.caught?.map((c) => `${c.check}:${c.level}`), ['path-link:warn']);
  assert.equal(stopGuard(store, { session_id: 'f4' }, { settings: phone, turn: turnOf(paths.replace('```\n\n', `\`\`\`\n[${NOTE}](${NOTE})\n\n`), { startUuid: 'g4' }) }).block, undefined);
  // A level set to warn (levels in the mistake-guards key of this-secretary.local.json) only tells.
  const warned = stopGuard(store, { session_id: 'f5' }, { settings: { ...settings, levels: { ...settings.levels, 'path-pair': 'warn' } }, turn: turnOf(noEnd, { startUuid: 'g5' }) });
  assert.equal(warned.block, undefined);
  assert.deepEqual(warned.caught?.map((c) => `${c.check}:${c.level}`), ['path-pair:warn']);
});

test('recommend-basis: an option marked (추천) wants a "근거:" line right under it; code blocks, inline code and short answers aside', () => {
  const body = ['되풀이 점검 기록을 봤어요.', '', '이미지 알림 11건 중 8건이 모아보기 시트였어요.', ''];
  const end = ['', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'];
  const ask = (...options: string[]) => [...body, 'G. 이미지 읽기를 어떻게 셀까요?', ...options, ...end].join('\n');
  // With its basis line (indented or not, bold too): passes.
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   근거: 기록 517개 중 이미지 알림 11건, 8건이 시트(이 턴에 다시 셈)', '2. 그대로 센다', '3. 기타 (직접 입력)')), null);
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '**근거:** 확인할 자료 없음(짐작)', '2. 기타 (직접 입력)')), null);
  assert.equal(checkRecommendBasis(ask('- 1. 세지 않는다 (추천)', '  - 근거： 기억 #900120', '- 2. 기타 (직접 입력)')), null);
  // Without it, or with the basis under the wrong option: caught.
  const none = checkRecommendBasis(ask('1. 세지 않는다 (추천)', '2. 그대로 센다', '3. 기타 (직접 입력)'));
  assert.equal(none?.check, 'recommend-basis');
  assert.match(none?.reason ?? '', /G의 "1\. 세지 않는다 \(추천\)"[^]*바로 아래에 들여쓴 인용 줄 "> 근거:"[^]*자료 있음, 못 봄[^]*이유:[^]*확인할 자료 없음\(짐작\)/);
  assert.equal(none?.rewrite, undefined, 'a labelled question is fixed by writing its block again');
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다', '2. 그대로 센다 (추천)', '3. 기타 (직접 입력)', '   근거: 기록 확인'))?.check, 'recommend-basis');
  // 없으면 놓치는 실수: "(추천)" 선택지에 들여쓴 세부 목록을 달고 그 뒤에 근거를 붙인 바른 답을 막아 되돌린다(또는 반대로, 빈 줄·들여쓰지 않은 문단·다음 선택지 뒤의 근거를 인정해 근거 없는 추천을 놓친다).
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   시트가 많아요.', '   근거: 기록 확인', '2. 기타 (직접 입력)')), null);
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   - 시트 8건', '   - 낱장 3건', '   > 근거: 기록 517개 다시 셈', '2. 그대로 센다', '3. 기타 (직접 입력)')), null);
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   - 시트 8건', '시트가 많아요.', '   > 근거: 기록 확인', '2. 기타 (직접 입력)'))?.check, 'recommend-basis');
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   - 시트 8건', '', '   > 근거: 기록 확인', '2. 기타 (직접 입력)'))?.check, 'recommend-basis');
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   - 시트 8건', '2. 그대로 센다', '   > 근거: 기록 확인', '3. 기타 (직접 입력)'))?.check, 'recommend-basis');
  assert.match(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '2. 기타 (직접 입력)'))?.reason ?? '', /세부 줄[^]*다음 선택지 앞/);
  // A basis under another option too is allowed (not asked for).
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   근거: 8건이 시트', '2. 그대로 센다', '   근거: 낱장 3건도 눈으로 볼 일', '3. 기타 (직접 입력)')), null);
  // The basis as a quote line ("> 근거:"), the form the rule asks for, so it reads apart from the options.
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   > 근거: 8건이 시트', '2. 그대로 센다', '3. 기타 (직접 입력)')), null);
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '> **근거:** 8건이 시트', '2. 기타 (직접 입력)')), null);
  // Examples in a code block, "(추천)" in inline code, and "(추천)" in a sentence are not picks.
  assert.equal(checkRecommendBasis([...body, '```', 'G. …?', '1. 이미지 읽기는 세지 않는다 (추천)', '2. 그대로 센다', '```', ...end].join('\n')), null);
  assert.equal(checkRecommendBasis([...body, '1. 선택지에 `(추천)`을 달면 근거 줄을 붙여요.', '2. 둘째 줄', ...end].join('\n')), null);
  assert.equal(checkRecommendBasis([...body, '추천에는 (추천)을 달아요.', ...end].join('\n')), null);
  // A short answer is not checked.
  assert.equal(checkRecommendBasis('1. 예 (추천)\n2. 아니오'), null);
  // 없으면 놓치는 실수: 질문이 아닌 설명 속 번호 목록(검사 규칙을 설명하며 "(추천)"이라는 낱말을 쓴 줄)을 선택지로 읽어 답을 되돌린다.
  assert.equal(checkRecommendBasis([...body, '1. 지금 고친다 (추천)', '2. 나중에', ...end].join('\n')), null);
  // A label asked again further down counts by its last block.
  const again = [ask('1. 세지 않는다 (추천)', '2. 그대로 센다', '3. 기타 (직접 입력)'), 'G. 이미지 읽기를 어떻게 셀까요?', '1. 세지 않는다 (추천)', '   근거: 8건이 시트', '2. 그대로 센다', '3. 기타 (직접 입력)'].join('\n');
  assert.equal(checkRecommendBasis(again), null);
  assert.deepEqual(unbackedPicks([again, 'H. 알림은 몇 시에?', '1. 9시 (추천)', '2. 기타 (직접 입력)'].join('\n')).map((p) => p.label), ['H']);
  assert.ok(checkAnswer(ask('1. 세지 않는다 (추천)', '2. 기타 (직접 입력)'), roots('C:\\r')).some((f) => f.check === 'recommend-basis'));
});

// 없으면 놓치는 실수: 추천 근거에 "paths.ts 21·41줄(확인 안 함)"처럼 열어 볼 자료를 적고도 안 열고 넘긴다(2026-11-10 점검에서 7건 넘게). 자료가 원래 없는 짐작이나 확인한 근거는 알리지 않는다.
test('basis-unopened: a basis naming a file, line, report or command it did not open is told on the next prompt; a real guess and a checked basis are not', () => {
  const ask = (basis: string) => ['기록을 봤어요.', '', 'G. 어떻게 할까요?', '1. 고친다 (추천)', `   > 근거: ${basis}`, '2. 기타 (직접 입력)', '', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'].join('\n');
  for (const basis of ['paths.ts 21·41줄(확인 안 함)', '서브에이전트 보고 기준, 확인 안 함', '자료 있음, 안 봄(`git log` 출력)', '기억 #900675에 있음(안 봄)']) {
    const f = checkBasisUnopened(ask(basis));
    assert.equal(f?.check, 'basis-unopened', basis);
    assert.match(f?.reason ?? '', /열어 확인/);
  }
  for (const basis of ['확인할 자료 없음(짐작)', 'paths.ts 21줄을 열어 보니 두 곳에서 부름', '확인 안 함(짐작, 기록에 없음)', '자료 있음, 못 봄(폰 Remote Control 화면, 이유: 비서는 폰 화면을 볼 수 없음)']) assert.equal(checkBasisUnopened(ask(basis)), null, basis);
  // A basis line in a code block (a rule or an example quoted) is not one.
  assert.equal(checkBasisUnopened(['```', '> 근거: paths.ts 21줄(확인 안 함)', '```'].join('\n')), null);
  assert.ok(checkAnswer(ask('a.md(안 봄)'), roots('C:\\r')).some((f) => f.check === 'basis-unopened'));
});

// [늘 남김] 없으면 놓치는 실수: 되돌린 답 뒤에 이어 쓴 줄이 앞 답과 따로 저장되거나 빠져, 남은 질문과 실수 기록이 그 줄을 못 읽는다.
test('stop hook end to end: lines added after an answer sent back are logged with it as one row (open questions and mistakes read it)', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const dir = tempDir();
  const db = path.join(dir, 'hook.db');
  const transcript = path.join(dir, 't.jsonl');
  const env = { ...process.env, SECRETARY_DB: db, SECRETARY_SEMANTIC_SEARCH: 'off' };
  const hook = (input: object) => execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'hook', 'stop'], { input: JSON.stringify(input), encoding: 'utf8', env });
  const first = '알림을 고쳤어요.\n\n이제 9시에 와요.\n\nC. 주말에도 보낼까요?\n1. 예 (추천)\n2. 기타 (직접 입력)';
  fs.writeFileSync(transcript, [userSays('u1', '알림 고쳐 줘'), says('a1', first)].join('\n') + '\n');
  const out = JSON.parse(hook({ session_id: 's1', transcript_path: transcript }));
  assert.equal(out.decision, 'block');
  assert.ok(String(out.reason).startsWith(FILL_HEAD));
  const added = 'C. 주말에도 보낼까요?\n1. 예 (추천)\n   근거: 확인할 자료 없음(짐작)\n2. 기타 (직접 입력)\n\n다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: C(주말 알림)';
  fs.appendFileSync(transcript, [userSays('f1', `Stop hook feedback:\n${out.reason}`), says('a2', added)].join('\n') + '\n');
  assert.equal(hook({ session_id: 's1', transcript_path: transcript, stop_hook_active: true }), '');
  const store = testStore(db);
  assert.deepEqual(store.logAfter(0).map((e) => e.content), ['알림 고쳐 줘', `${first}\n\n${added}`], 'the hook\'s reason is not logged as the user\'s; the answer is one row');
  assert.deepEqual(openQuestionLines(store), ['- C. 주말에도 보낼까요? 1. 예 (추천) 근거: 확인할 자료 없음(짐작) 2. 기타 (직접 입력)']);
  assert.deepEqual(store.listMistakes().map((m) => [m.group_name, m.log_ids]).sort(), [['확인 없이 추천', '1,2']]);
});

// [늘 남김] 없으면 놓치는 실수: 실제 훅 프로세스가 막기 JSON을 잘못 내거나, 막힌 턴을 끝난 턴으로 대화에 저장한다(훅이 턴을 잘못 막음).
test('stop hook end to end: the block goes out as {decision: block} and the turn is logged only when it really ends', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const dir = tempDir();
  const db = path.join(dir, 'hook.db');
  const transcript = path.join(dir, 't.jsonl');
  const env = { ...process.env, SECRETARY_DB: db, SECRETARY_SEMANTIC_SEARCH: 'off' };
  const hook = (input: object) => execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'hook', 'stop'], { input: JSON.stringify(input), encoding: 'utf8', env });
  fs.writeFileSync(transcript, [userSays('u1', '상태 알려 줘'), says('a1', 'Everything is running fine.')].join('\n') + '\n');
  const out = JSON.parse(hook({ session_id: 's1', transcript_path: transcript }));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /한국어로 다시/);
  const store = testStore(db);
  assert.equal(store.logAfter(0).length, 0, 'not logged yet');
  fs.appendFileSync(transcript, `${says('a2', '모두 잘 돌고 있어요.')}\n`);
  assert.equal(hook({ session_id: 's1', transcript_path: transcript, stop_hook_active: true }), '');
  assert.deepEqual(store.logAfter(0).map((e) => e.content), ['상태 알려 줘', '모두 잘 돌고 있어요.'], 'the replaced English answer is not kept');
  assert.deepEqual(store.turnTools()[0].guard, [{ check: 'english', level: 'block' }]);
  assert.deepEqual(store.listMistakes().map((m) => [m.group_name, m.found_by, m.log_ids]), [['영어 답', '장치', '1,2']], 'the catch is in the mistakes record');
});

// ---- question labels ------------------------------------------------------------------------------------------------

test('question labels: a new session starts after the carried questions, its answers move the next label, a compaction keeps it', () => {
  const store = testStore();
  assert.equal(nextLabel(store, 's1'), 'A');
  noteAnswerLabels(store, 's1', '확인할 것:\n\nA. 알림 시각을 바꿀까요?\n1. 9시\n2. 기타 (직접 입력)\n\nB. 이름은요?\n1. 기타 (직접 입력)');
  assert.equal(nextLabel(store, 's1'), 'C');
  // Lines that only mention a label, or carry no question mark, do not count.
  noteAnswerLabels(store, 's1', 'F(알림 시각)는 정했어요.\n\nZ. 메모');
  assert.equal(nextLabel(store, 's1'), 'C');
  noteAnswerLabels(store, 's1', 'AL. 마지막 질문인가요?');
  assert.equal(nextLabel(store, 's1'), 'AM');
  // A compaction keeps the session id: the label goes on.
  assert.match(labelNotice(store, 's1'), /다음 질문 알파벳: AM/);
  // A new session (or /clear) with two carried questions: A and B are theirs, the next one is C.
  store.setJson('open_questions', {
    lastLogId: 0,
    open: ['G', 'AK'],
    defs: { G: { text: 'G. 알림 시각은요?', session: 's1', at: new Date().toISOString(), logId: 7 }, AK: { text: 'AK. 이름은요?', session: 's1', at: new Date().toISOString(), logId: 9 } },
  });
  const lines = carryOverQuestions(store, 's2');
  assert.match(lines.join('\n'), /- A \(옛 G, #7\)\. 알림 시각은요\?/);
  assert.equal(nextLabel(store, 's2'), 'C');
  assert.equal(nextLabel(store, 's1'), 'AM', 'the old session keeps its own');
  startLabelsAfter(store, 's2', 1);
  assert.equal(nextLabel(store, 's2'), 'C', 'never goes back');
});

// ---- where files may go ---------------------------------------------------------------------------------------------

test('folder place: nothing new at the top of the results folder, nothing written into its temp; what is there stays usable', () => {
  const ai = aiRootWith('workspaces', 'notes', 'inbox', 'secretary-1', 'temp');
  const ctx = { aiRoot: ai, cwd: path.join(ai, 'secretary-1') };
  // Write / Edit
  assert.equal(writePlaceProblem(path.join(ai, 'workspaces', '_run-job-home', 'output', 'r.md'), ctx), null);
  assert.equal(writePlaceProblem(path.join(ai, 'secretary-1', 'src', 'x.ts'), ctx), null);
  assert.match(writePlaceProblem(path.join(ai, 'whisperx-test', 'run.py'), ctx) ?? '', /바로 아래\(whisperx-test\)/);
  assert.match(writePlaceProblem(path.join(ai, 'notes.txt'), ctx) ?? '', /notes\.txt/);
  assert.match(writePlaceProblem(path.join(ai, 'temp', 'a.wav'), ctx) ?? '', /temp는 사용자의 임시 작업 폴더/);
  assert.match(writePlaceProblem('..\\temp\\a.wav', ctx) ?? '', /임시 작업 폴더/);
  assert.equal(writePlaceProblem(path.join(os.tmpdir(), 'elsewhere', 'x'), ctx), null);
  // Shell commands
  const bad = (cmd: string) => assert.ok(commandPlaceProblem(cmd, ctx), cmd);
  const fine = (cmd: string) => assert.equal(commandPlaceProblem(cmd, ctx), null, cmd);
  bad(`mkdir "${path.join(ai, 'rc-kit-test-20261102')}"`);
  bad(`New-Item -ItemType Directory -Path ${path.join(ai, '_sandbox')}`);
  bad(`python run.py --out ${path.join(ai, 'whisperx-test')}`);
  bad('Set-Content -Path ..\\temp\\x.txt -Value 1');
  bad(`cd ${['..', 'temp'].join('/')} && python make.py`);
  bad(`Copy-Item a.wav '${path.join(ai, 'temp', 'My Folder')}'`);
  bad(`mkdir ${ai.replace(/\\/g, '/')}/new-place`);
  fine(`Get-ChildItem ${path.join(ai, 'temp')}`);
  fine('Get-Content ..\\temp\\notes.md | Select-Object -First 5');
  fine(`Test-Path ${path.join(ai, 'not-there')}`);
  fine(`mkdir ${path.join(ai, 'workspaces', '_run-job-home', 'output', 'research', 'x')}`);
  fine(`Set-Content "${path.join(ai, 'notes', 'My Note.md')}" -Value 1`);
  fine(`mkdir ${ai}-other\\x`);
  fine('npm test 2>&1');
  // A quoted path with spaces is one path (a folder that is there).
  fs.mkdirSync(path.join(ai, 'workspaces', 'My Space'), { recursive: true });
  assert.ok(mentionedPaths(`ls "${path.join(ai, 'workspaces', 'My Space')}"`, ai, ai).some((p) => p.endsWith('My Space')));
});

// [늘 남김] 없으면 놓치는 실수: PreToolUse 훅이 다른 도구나 바른 자리에 쓰는 것까지 막아 일이 멈춘다(훅이 도구를 잘못 막음).
test('pre-tool hook: refuses with a deny reason through its own entry, lets other tools and good places through', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const ai = aiRootWith('workspaces');
  assert.match(preToolProblem({ tool_name: 'Write', tool_input: { file_path: path.join(ai, 'temp', 'x.md') }, cwd: ai }, ai) ?? '', /임시 작업 폴더/);
  assert.equal(preToolProblem({ tool_name: 'Read', tool_input: { file_path: path.join(ai, 'temp', 'x.md') } }, ai), null);
  assert.equal(preToolProblem({ tool_name: 'Bash', tool_input: { command: `ls ${ai}` } }, ai), null);
  // As Claude Code runs it: JSON in, a deny out (the results folder of this copy is its parent folder).
  const real = path.dirname(PROJECT_ROOT);
  const run = (input: object) => execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'mistake-guards', 'pre-tool-hook.ts')], { input: JSON.stringify(input), encoding: 'utf8' });
  const out = JSON.parse(run({ tool_name: 'Write', tool_input: { file_path: path.join(real, 'zz-guard-test-new', 'a.txt') }, cwd: PROJECT_ROOT }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^\[폴더 위치 규칙\] .*zz-guard-test-new/);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(PROJECT_ROOT, 'x.txt') }, cwd: PROJECT_ROOT }), '');
  assert.equal(run({}), '');
  assert.ok(!fs.existsSync(path.join(real, 'zz-guard-test-new')));
});

// 없으면 놓치는 실수: 비서가 서브에이전트에게 보고서 파일(REPORT.md)을 쓰라고 지시해, Claude Code가 그 쓰기를 막아 서브에이전트가 헛돈다.
// 또는 "비서가 REPORT.md로 저장한다"·"보고서 파일을 읽어라"처럼 쓰라는 지시가 아닌 글까지 막아 위임이 멈춘다.
test('pre-tool hook: a subagent brief asking for a report file is refused; one saying the secretary saves it passes', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const ai = aiRootWith('workspaces');
  const agent = (prompt: string) => preToolProblem({ tool_name: 'Agent', tool_input: { prompt } }, ai);
  assert.match(agent('조사하라.\n끝나면 결과를 C:/w/out/REPORT.md에 써라.') ?? '', /보고서 파일 쓰기.*마지막 답으로만/);
  assert.ok(agent('Write your findings to report.md and stop.'));
  assert.ok(agent('보고서 파일로 저장해 줘.'));
  // The delegate skill's own line, and a brief that only reads a report.
  const skillLine = fs.readFileSync(path.join(PROJECT_ROOT, '.agents', 'skills', 'delegate', 'references', 'who-and-brief.md'), 'utf8');
  assert.equal(agent(skillLine), null, 'the brief form of the delegate skill');
  assert.equal(agent('보고는 마지막 답으로만 하라. 마지막 답에 결과를 써라.'), null);
  assert.equal(agent('업무 세션의 REPORT.md를 읽고 맞는지 대조해 요약을 써라.'), null);
  assert.equal(agent('REPORT.md 파일은 쓰지 마라.'), null);
  // A brief handed over as a file is read too.
  const brief = path.join(ai, 'workspaces', 'BRIEF.md');
  fs.writeFileSync(brief, '일: 조사.\n결과는 같은 폴더 REPORT.md로도 저장해.\n');
  assert.match(agent(`먼저 ${brief} 를 읽고 그 지시를 따르라.`) ?? '', /BRIEF\.md: 서브에이전트 지시에 보고서 파일 쓰기/);
  fs.writeFileSync(brief, '일: 조사.\n보고는 마지막 답으로만 하라.\n');
  assert.equal(agent(`먼저 ${brief} 를 읽고 그 지시를 따르라.`), null);
  assert.equal(preToolProblem({ tool_name: 'Bash', tool_input: { command: 'node scripts/subagent-report/subagent-report.ts abc out/ > out/REPORT.md' }, cwd: path.join(ai, 'workspaces') }, ai), null, 'the secretary saving it');
  const settings = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.PreToolUse.some((h: { matcher?: string }) => /\bAgent\b/.test(h.matcher ?? '') && /pre-tool-hook/.test(JSON.stringify(h))), 'the hook sees Agent calls');
});

// ---- the mistakes record --------------------------------------------------------------------------------------------

test('mistakes: recorded with every column, a second of the same group counts as recurred, filled in later, grouped', () => {
  const store = testStore();
  const a = store.recordMistake({
    what: '백그라운드 대기 한 줄을 영어로 답함',
    group: '영어 답',
    madeBy: '비서',
    foundBy: '사용자',
    cause: '안 지킴',
    logIds: [900491],
    ruleRef: 'AGENTS.md 답 쓰는 법',
    happenedAt: '2026-11-06T10:00:00Z',
  });
  assert.equal(a.recurred, 0);
  assert.equal(a.log_ids, '900491');
  const b = store.recordMistake({ what: '보고를 영어로 씀', group: '영어 답', madeBy: '비서', foundBy: '장치', cause: '안 지킴', logIds: [3146, 3161] });
  assert.equal(b.recurred, 1);
  assert.throws(() => store.recordMistake({ what: 'x', group: 'g', madeBy: '비서', foundBy: '사용자', cause: '안 지킴', happenedAt: 'not a date' }), /not a date/);
  assert.throws(() => store.recordMistake({ what: 'x', group: 'g', madeBy: '비서', foundBy: '누군가' as '사용자', cause: '안 지킴' }), /CHECK/);
  const filled = store.updateMistake(a.id, { guard: 'Stop 훅 english' })!;
  assert.equal(filled.guard, 'Stop 훅 english');
  assert.match(formatMistake(filled), /^\[#1 2026-11-06 19:00\] \(영어 답\) 백그라운드 대기[^]*근거 #900491 · 규칙: AGENTS\.md[^]*장치: Stop 훅 english$/);
  assert.doesNotMatch(formatMistake(filled), /평가/);
  assert.deepEqual(store.mistakeGroups().map((g) => [g.group_name, g.n, g.recurred, g.guarded]), [['영어 답', 2, 1, 1]]);
  assert.deepEqual(store.listMistakes({ group: '영어 답' }).map((m) => m.id), [b.id, a.id]);
});

// ---- 2026-11-13 askback fixes: basis sources opened, made-up words, a question leaning on another, a report passed on --

const parsedLines = (...ls: string[]) => ls.map((l) => JSON.parse(l) as Line);
const toolWith = (uuid: string, id: string, name: string, input: object) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultOf = (uuid: string, id: string, text: string) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const pick = (...basis: string[]) => ['G. 어떻게 할까요?', '1. 고친다 (추천)', ...basis.map((b) => `   > 근거: ${b}`), '2. 기타 (직접 입력)'].join('\n');

const compactLine = (uuid: string) => line({ type: 'system', subtype: 'compact_boundary', uuid, compactMetadata: { trigger: 'manual' } });

// 없으면 놓치는 실수: 추천 근거에 파일·기억 번호를 적었지만 이 대화에서 열지 않았는데 아무도 모른다(사용자가 되물어 추천이 바뀐 일의 주 원인). 또는 연 자료를 안 연 것으로 잘못 알린다.
test('basis-source: a source the conversation never opened since its last compaction, or a basis with no source and no "not seen" form, is told; opened ones pass', () => {
  const seen = seenSinceCompaction(
    parsedLines(
      userSays('u0', '압축 전 질문'),
      toolWith('z0', 'z1', 'Read', { file_path: String.raw`C:\s\src\old\before-compact.ts` }),
      compactLine('c1'),
      userSays('u1', '옛 질문'),
      toolWith('a0', 'x0', 'Read', { file_path: String.raw`C:\s\src\old\four-turns-ago.ts` }),
      userSays('u2', '두 번째'),
      says('a1', '답'),
      userSays('u3', '세 번째'),
      says('a2', '답'),
      userSays('u4', '이번 질문'),
      toolWith('a3', 't1', 'Read', { file_path: String.raw`C:\s\src\hooks\run-hook.ts` }),
      resultOf('r1', 't1', '119 store.linkTurnMemories(input.session_id);'),
      toolWith('a4', 't2', 'mcp__secretary__recall', { ids: [900163] }),
      resultOf('r2', 't2', '#900163 decision: ...'),
      toolWith('a5', 't3', 'PowerShell', { command: 'git log --oneline -3' }),
      resultOf('r3', 't3', '1234567 커밋'),
    ),
  );
  assert.equal(checkBasisSource(pick('run-hook.ts 119줄을 열어 보니 Stop 훅이 잇는다. 기억 #900163, `git log --oneline -3`의 `1234567`'), seen), null);
  // Opened four turns ago in the same conversation: seen (the window was the last three turns until 2026-11-18).
  assert.equal(checkBasisSource(pick('four-turns-ago.ts 21줄'), seen), null);
  // Opened before the compaction: the summary is all that is left of it.
  const missed = checkBasisSource(pick('before-compact.ts 21줄과 기억 #900999'), seen);
  assert.equal(missed?.check, 'basis-source');
  assert.match(missed!.reason, /이 대화\(마지막 압축 뒤\)[^]*연 흔적이 없다[^]*before-compact\.ts[^]*#900999/);
  assert.match(checkBasisSource(pick('이 방식이 더 깔끔해 보인다'), seen)?.reason ?? '', /추론만 있다/);
  // The two forms for "not seen", the judge's line and the user's own words are no bare reasoning; a line reference or value in backticks is no command.
  for (const b of ['확인할 자료 없음(짐작)', '자료 있음, 못 봄(폰 화면, 이유: 볼 수 없음)', '사용자 말(이번 질문)대로', 'run-hook.ts의 `:119`와 `{"open":[]}`']) assert.equal(checkBasisSource(pick(b), seen), null, b);
  // No transcript read (a test turn, an unreadable file): nothing said.
  assert.equal(checkBasisSource(pick('어디에도 없는 a.ts'), null), null);
});

// 없으면 놓치는 실수: 서브에이전트·run-job 보고에 나온 경로를 열어 보지 않고 사용자에게 옮긴다.
test('report-relay: an answer passing on a report names its paths the secretary never opened', () => {
  const after = (...extra: string[]) =>
    seenSinceCompaction(parsedLines(userSays('u1', '조사해 줘'), toolWith('a1', 't1', 'Agent', { prompt: '조사' }), resultOf('r1', 't1', String.raw`보고: C:\w\out\REPORT.md 와 C:\w\out\scenes.jsonl 에 썼다`), ...extra));
  const answer = String.raw`조사가 끝났어요.

${'```'}
C:\w\out\REPORT.md
${'```'}`;
  assert.match(checkReportRelay(answer, after())?.reason ?? '', /열어 보지 않고 전했다[^]*REPORT\.md/);
  assert.equal(checkReportRelay(answer, after(toolWith('a2', 't2', 'Read', { file_path: String.raw`C:\w\out\REPORT.md` }))), null);
  // A path the report never named is not this check's.
  assert.equal(checkReportRelay(String.raw`${'```'}
C:\w\other\notes.md
${'```'}`, after()), null);
});

// 없으면 놓치는 실수: 서브에이전트·업무 세션 보고가 올린 질문을 비서 판단 없이 그대로 옮겨 묻는다(2026-11-18 사용자 결정: 질문마다 "비서 판단:" 줄). 또는 보고가 없는 턴이나 뒤에서 돈 명령이 끝난 알림에도 알린다.
test('report-judgment: questions in a turn that received a report each want a "비서 판단:" line; other turns are left alone', () => {
  const fromAgent = seenSinceCompaction(parsedLines(userSays('u1', '조사해 줘'), toolWith('a1', 't1', 'Agent', { prompt: '조사' }), resultOf('r1', 't1', '보고: 질문 둘')));
  // The rule's form: a quote line right under the question line, above the options (AGENTS.md 질문).
  const answer = [
    '조사가 끝났어요.',
    '',
    '배경 설명.',
    'A. 이대로 갈까요?',
    '> 비서 판단: 1번이 맞아 보여요(파일을 열어 봄).',
    '1. 예 (추천)',
    '   > 근거: 확인할 자료 없음(짐작)',
    '2. 기타 (직접 입력)',
    '',
    '두 번째 배경.',
    'B. 알림도 바꿀까요?',
    '1. 예',
    '2. 기타 (직접 입력)',
  ].join('\n');
  assert.deepEqual(questionsWithoutJudgment(answer), ['B']);
  const f = checkReportJudgment(answer, fromAgent);
  assert.equal(f?.check, 'report-judgment');
  assert.match(f!.reason, /"비서 판단:" 줄이 없다: B\./);
  assert.match(f!.reason, /질문 줄 바로 아래\(선택지 위\)에 인용 줄 "> 비서 판단: …"/, 'the reason says where and in what form');
  assert.equal(checkReportJudgment(answer.replace('B. 알림도 바꿀까요?', 'B. 알림도 바꿀까요?\n> 비서 판단: 바꾸지 않는 게 나아요.'), fromAgent), null);
  // The quote line stays in its question's block: its options are still that question's, so a pick under it with no
  // basis is still told, and its question is still read whole for the next session.
  assert.deepEqual(questionBlocks(answer)[0].lines.slice(0, 3), ['A. 이대로 갈까요?', '> 비서 판단: 1번이 맞아 보여요(파일을 열어 봄).', '1. 예 (추천)']);
  assert.deepEqual(unbackedPicks(answer.replace('   > 근거: 확인할 자료 없음(짐작)\n', '')).map((p) => p.label), ['A']);
  assert.match(parseQuestions(answer).A, /^A\. 이대로 갈까요\? > 비서 판단: .* 2\. 기타 \(직접 입력\)$/);
  // The older form, an indented line between the question and its options, is read too.
  assert.deepEqual(questionsWithoutJudgment(answer.replace('> 비서 판단:', '   비서 판단:')), ['B']);
  // No report this turn, or only a background command's end: nothing.
  assert.equal(checkReportJudgment(answer, seenSinceCompaction(parsedLines(userSays('u1', '어때?'), says('a1', '답')))), null);
  const bgDone = seenSinceCompaction(parsedLines(userSays('n1', '<task-notification><summary>Background command "npm test" completed</summary></task-notification>')));
  assert.equal(bgDone.reports.length, 1);
  assert.equal(checkReportJudgment(answer, bgDone), null);
  assert.equal(DEFAULT_LEVELS['report-judgment'], 'warn');
});

// 없으면 놓치는 실수: 사용자가 되물은 지어낸 말("칸", "두 꼴")을 질문·선택지에 또 쓴다(한 번 지적받은 "칸"이 다시 나온 적이 있다). 또는 "틀린"처럼 다른 낱말 속 글자나 괄호로 푼 말에 걸린다.
test('invented-word: a listed word in a question, option or basis without an explanation is told; inside other words, explained or in code it is not', () => {
  const words = ['목적 칸', '두 꼴', '옛 틀', '칸'];
  assert.deepEqual(inventedWordsIn(pick('지시서에 목적 칸을 둔다'), words).map((w) => w.word), ['목적 칸']);
  assert.deepEqual(inventedWordsIn('A. 두  꼴을 하나로 합칠까요?\n1. 예 (추천)', words).map((w) => w.word), ['두 꼴']);
  for (const ok of ['A. 옛 틀린 곳을 고칠까요?', 'A. 목적 칸(항목)을 더할까요?', 'A. `목적 칸` 이름을 바꿀까요?', '설명 문단에 나온 목적 칸은 보지 않는다', 'A. 공간을 쓸까요?']) assert.deepEqual(inventedWordsIn(ok, words), [], ok);
  // 2026-11-18: a one-letter word in its plain sense, and words named in a list joined by '·', are not caught.
  for (const ok of ['1. 그림을 두 칸으로 나눈다 (추천)', '> 근거: 목록에 옛 틀·두 꼴·목적 칸이 든 것을 확인했다', 'A. 손이 심심할 때 볼까요?']) assert.deepEqual(inventedWordsIn(ok, [...words, '손']), [], ok);
  assert.equal(checkInventedWords(pick('목적 칸'), [])?.check, undefined);
  // The list in git carries the user's first words, and record_mistake adds more for this database only.
  // The vague who-does-it phrase is spelled from code points (test/wording.test.ts keeps it out of every file).
  for (const w of ['목적 칸', '입구', '옛 틀', String.fromCodePoint(0xc190, 0xc73c, 0xb85c), '머리 글', '두 꼴']) assert.ok(baseInventedWords().includes(w), w);
  const store = testStore();
  assert.deepEqual(addInventedWords(store, ['  자리표 ', '목적 칸', '자리표', '꼴']), ['자리표']);
  assert.ok(inventedWords(store).includes('자리표'));
  assert.deepEqual(addInventedWords(store, ['자리표']), []);
});

// 없으면 놓치는 실수: 다른 질문의 답("SF1이면")에 기대는 질문을 같은 답에서 같이 물어, 앞 질문이 정해지기 전에 뒤 질문을 읽게 한다(사용자 결정 2026-11-13).
test('dependent-question: a question or option leaning on another question of the same answer is told to wait for the next turn', () => {
  const answer = ['SF. 설정을 어디에 둘까요?', '1. 담당자 폴더 (추천)', '2. 기타 (직접 입력)', '', 'SH. 다른 쪽은 어떻게 할까요?', '1. 담당자 설정 파일(SF1이면)에서 읽는다 (추천)', '2. 기타 (직접 입력)'].join('\n');
  const f = checkDependentQuestions(answer);
  assert.equal(f?.check, 'dependent-question');
  assert.match(f!.reason, /SH가 SF의 답에 기댐[^]*다음 턴에 묻는다/);
  // Two questions on their own, or a label from an earlier answer: nothing.
  assert.equal(checkDependentQuestions(['A. 알림 시각은?', '1. 9시 (추천)', '', 'B. 주말에도?', '1. 예 (추천)'].join('\n')), null);
  assert.equal(checkDependentQuestions(['B. 주말에도?', '1. 지난번 A1이면 예 (추천)'].join('\n')), null);
});
