import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, testStore, write } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { isShieldedLocal, writeLocalJson } from '../src/core/local-settings.ts';
import { readFeatures } from '../src/core/features.ts';
import { readResultPaths } from '../src/core/result-paths.ts';
import { BASIS_GUESS, BASIS_UNABLE } from '../src/core/basis-forms.ts';
import { QUESTION_BASIS_RULE } from '../src/workspace/rules-text.ts';
import { resultPathsBlock } from '../src/hooks/session-start.ts';
import { carryOverQuestions, openQuestionLines } from '../src/session-continuity/open-questions.ts';
import { checkAnswer, checkBasisOldForm, checkBasisSource, checkDependentQuestions, checkInventedWords, checkReportRelay, inventedWordsIn, checkBasisUnopened, checkEnglish, checkPaths, checkRecommendBasis, hangulRatio, isResultPath, unbackedPicks } from '../src/mistake-guards/answer-checks.ts';
import { commandPlaceProblem, mentionedPaths, writePlaceProblem } from '../src/mistake-guards/folder-place.ts';
import { labelNotice, nextLabel, noteAnswerLabels, startLabelsAfter, usedLabels } from '../src/mistake-guards/question-labels.ts';
import { preToolProblem } from '../src/mistake-guards/pre-tool-hook.ts';
import { DEFAULT_LEVELS, guardsOn, readGuardSettings, type GuardSettings } from '../src/mistake-guards/mistake-guard-settings.ts';
import { FILL_HEAD, guardWarnNotice, recordGuardMistakes, stopGuard } from '../src/mistake-guards/stop-guard.ts';
import { firstLine } from '../src/phone-push/ntfy.ts';
import { lastTurn, type Line, type Turn } from '../src/mistake-guards/last-turn.ts';
import { seenInTurns } from '../src/mistake-guards/seen-sources.ts';
import { addInventedWords, baseInventedWords, inventedWords } from '../src/mistake-guards/invented-words.ts';
import { formatGuardHits, formatMistake, similarGroups } from '../src/mcp/mistake-tools.ts';
// @ts-expect-error plain .mjs script without types
import { check as workerCheck } from '../scripts/worker/worker-folder-guard.mjs';

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

test('paths: a results path inside a sentence, and a code path without its pair', () => {
  const ai = path.join(os.tmpdir(), 'results');
  const s = roots(ai);
  const at = (rel: string) => path.join(ai, rel);
  // In a sentence (inline code too).
  assert.deepEqual(checkPaths(`보고서는 \`${at('workspaces\\a\\REPORT.md')}\`에 있어요.`, s).map((f) => f.check), ['path-prose']);
  // On its own code line with the other PC's line: fine, either slash, any case.
  const paired = ['보고서:', '```', at('workspaces\\a\\REPORT.md'), '```', '```', `${OTHER}\\workspaces\\a\\REPORT.md`, '```'].join('\n');
  assert.deepEqual(checkPaths(paired, s), []);
  assert.deepEqual(checkPaths(paired.replace(`${OTHER}\\workspaces\\a\\REPORT.md`, 'y:/RESULTS/workspaces/a/REPORT.md'), s), []);
  // Without it: told which one lacks what.
  const lone = ['```', at('workspaces\\a\\REPORT.md'), '```'].join('\n');
  const f = checkPaths(lone, s);
  assert.deepEqual(f.map((x) => x.check), ['path-pair']);
  assert.match(f[0].reason, /다른 PC 경로 줄이 빠졌다: workspaces\/a\/REPORT\.md\./);
  // With a phone address set, a tap-to-open link to it is wanted too (outside the code blocks; spaces as %20). Three
  // lines: this PC, the other PC, the link.
  const phone = roots(ai, { phoneRoot: 'https://pc.example.ts.net/share/results' });
  const spaced = ['```', at('notes\\My Note.md'), '```', '```', `${OTHER}\\notes\\My Note.md`, '```'].join('\n');
  const noLink = checkPaths(spaced, phone);
  assert.deepEqual(noLink.map((f) => f.check), ['path-link']);
  assert.match(noLink[0].reason, /링크 줄이 빠졌다: notes\/My Note\.md[^]*주소 자체를 링크 이름으로[^]*링크 줄로만/);
  const NOTE = 'https://pc.example.ts.net/share/results/notes/My%20Note.md';
  const linkTo = (a: string) => `[${a}](${a})`;
  assert.deepEqual(checkPaths(`${spaced}\n${linkTo(NOTE)}`, phone), []);
  // Both missing: each check says its own.
  const bothMissing = checkPaths(['```', at('notes\\My Note.md'), '```'].join('\n'), phone);
  assert.deepEqual(bothMissing.map((f) => f.check), ['path-pair', 'path-link']);
  assert.match(bothMissing[0].reason, /다른 PC 경로 줄이 빠졌다/);
  // The tap-to-open link is not a path in a sentence, nor a local path with "?", whatever the other PC's folder looks like.
  const tapped = (link: string, x = phone, code = '') => checkAnswer(`보고서가 끝났어요.\n${spaced}${code ? `\n\`\`\`\n${code}\n\`\`\`` : ''}\n${link}\n\n다음 행동 및 순서: 없음`, x);
  assert.deepEqual(tapped(linkTo(NOTE)), []);
  assert.deepEqual(tapped(linkTo(NOTE), { ...phone, otherPcRoot: '\\\\pc.example.ts.net\\share\\results' }).map((f) => f.check).filter((c) => c !== 'path-pair'), []);
  assert.deepEqual(tapped(linkTo(NOTE), { ...phone, aiRoot: '/share/results' }).map((f) => f.check).filter((c) => c !== 'path-pair'), []);
  // The older form (the phone address also on a code line) is let be: not caught, and the code line is not the link.
  assert.deepEqual(tapped(linkTo(NOTE), phone, NOTE), []);
  assert.deepEqual(tapped('', phone, NOTE).map((f) => f.check), ['path-link']);
  // Parentheses and Korean written either way still match; a query string is left out of the match.
  const prev = at('workspaces\\a\\output\\업무(12)\\preview.html');
  const PREVIEW = 'https://pc.example.ts.net/share/results/workspaces/a/output/%EC%97%85%EB%AC%B4%2812%29/preview.html?still';
  const prevPaths = ['```', prev, '```', '```', `${OTHER}\\workspaces\\a\\output\\업무(12)\\preview.html`, '```'].join('\n');
  assert.deepEqual(checkPaths(`${prevPaths}\n${linkTo(PREVIEW)}`, phone), []);
  assert.deepEqual(checkPaths(`${prevPaths}\n${linkTo(PREVIEW.replace('%2812%29', '(12)').replace('(12)', '%2812%29'))}`, phone), []);
  // Without it a phone link named other than its address ([폰에서 열기](https://…)) passes as the link (decided
  // 2026-11-07: the name is the address itself). Caught as path-link, saying the name is wrong; the name written decoded
  // (spaces, Korean, parentheses as read) is still the address.
  const misnamed = checkPaths(`${spaced}\n[폰에서 열기](${NOTE})`, phone);
  assert.deepEqual(misnamed.map((f) => f.check), ['path-link']);
  assert.match(misnamed[0].reason, /링크 이름이 주소가 아니다: notes\/My Note\.md[^]*링크 주소를 그대로/);
  assert.doesNotMatch(misnamed[0].reason, /링크 줄이 빠졌다/);
  assert.deepEqual(checkPaths(`${spaced}\n[${NOTE.replace('%20', ' ')}](${NOTE})`, phone), []);
  assert.deepEqual(checkPaths(`${prevPaths}\n[https://pc.example.ts.net/share/results/workspaces/a/output/업무(12)/preview.html?still](${PREVIEW})`, phone), []);
  // A misnamed link next to a rightly named one to the same path is let be (the lines added after a send-back count).
  assert.deepEqual(checkPaths(`${spaced}\n[열기](${NOTE})\n${linkTo(NOTE)}`, phone), []);
  // A link to another address, or a link inside a code block, does not count.
  assert.deepEqual(checkPaths(`${spaced}\n${linkTo(PREVIEW)}`, phone).map((f) => f.check), ['path-link']);
  assert.deepEqual(checkPaths(`${spaced}\n\`\`\`\n${linkTo(NOTE)}\n\`\`\``, phone).map((f) => f.check), ['path-link']);
  // A local path is still caught in a link: its label, or a file:/// target (which is not the phone address's link).
  // A local path as the name is also not the address, so the link does not count (path-link).
  assert.deepEqual(tapped(`[${at('notes\\My Note.md')}](${NOTE})`).map((f) => f.check), ['path-prose', 'path-link']);
  assert.deepEqual(tapped(`[열기](file:///${at('notes\\x.html').replace(/\\/g, '/')}?still)`).map((f) => f.check), ['path-prose', 'path-link']);
  // With no phone address set, no link is wanted, and a phone address alone wants nothing.
  assert.deepEqual(checkPaths(spaced, s), []);
  assert.deepEqual(checkPaths(['```', NOTE, '```'].join('\n'), phone), []);
  // Only result paths want their pair: not the secretary's own files, nor code or settings files (unless under output).
  const own = roots(ai, { secretaryDir: at('secretary-1') });
  const single = (p: string, x = own) => checkPaths(['```', p, '```'].join('\n'), x).map((f) => f.check);
  assert.deepEqual(single(at('secretary-1\\scripts\\mistake-guards.local.json')), []);
  assert.deepEqual(single(at('secretary-1\\AGENTS.md')), []);
  assert.deepEqual(single(at('workspaces\\a\\scripts\\make.py')), []);
  assert.deepEqual(single(at('workspaces\\a\\tool.config.json')), []);
  assert.deepEqual(single(at('workspaces\\a\\src\\README.md')), []);
  assert.deepEqual(single(at('workspaces\\a\\output\\data\\table.json')), ['path-pair']);
  assert.deepEqual(single(at('workspaces\\a\\output\\research\\x')), ['path-pair']);
  assert.deepEqual(single(at('notes\\Projects\\plan.md')), ['path-pair']);
  assert.deepEqual(isResultPath('workspaces/a/REPORT.md'), true);
  assert.deepEqual(isResultPath('secretary-1/output/x.md', 'secretary-1'), false);
  // A command line, a path outside the results folder, the folder itself: not result lines.
  assert.deepEqual(checkPaths(['```', `node ${at('secretary\\src\\cli.ts')} hook stop`, 'C:\\Windows\\System32\\drivers\\etc\\hosts', ai, '```'].join('\n'), s), []);
  // Without the other PC's path set here, only the sentence check runs.
  assert.deepEqual(checkPaths(lone, roots(ai, { otherPcRoot: null })), []);
  // Another folder that only starts the same is not the results folder.
  assert.deepEqual(checkPaths(`${ai}-old\\x 를 봤어요.`, s), []);
  assert.deepEqual(checkAnswer('', s), []);
});

test('settings: the parent folder, the other PC path from the local file, levels overridable, the phone address from the dashboard', () => {
  const ai = tempDir('guards-set-');
  const root = path.join(ai, 'secretary');
  const withGuards = (enabled: boolean) => JSON.stringify({ features: readFeatures(PROJECT_ROOT)!.map((f) => (f.id === 'mistake-guards' ? { ...f, enabled } : f.id === 'dashboard' ? { ...f, enabled: true } : f)) });
  write(path.join(root, 'features.json'), withGuards(true));
  let s = readGuardSettings(root);
  assert.equal(s.aiRoot, ai);
  assert.equal(s.otherPcRoot, null);
  assert.equal(s.on, true);
  const thisSecretary = path.join(root, 'this-secretary.local.json');
  write(
    thisSecretary,
    JSON.stringify({
      paths: { otherPcRoot: 'Y:\\results\\' },
      'mistake-guards': { levels: { english: 'warn', nope: 'block', 'path-pair': 'loud' } },
      dashboard: { publicUrl: 'https://pc.example.ts.net/' },
    }),
  );
  s = readGuardSettings(root);
  assert.equal(s.otherPcRoot, 'Y:\\results');
  assert.equal(s.levels.english, 'warn');
  assert.equal(s.levels['path-pair'], DEFAULT_LEVELS['path-pair']);
  assert.ok(!('nope' in s.levels));
  assert.equal(s.phoneRoot, `https://pc.example.ts.net/share/${path.basename(ai)}`);
  assert.equal(s.secretaryDir, root);
  // 없으면 놓치는 실수: 규칙에서 뺀 이 PC·다른 PC 경로와 폰 주소를 SessionStart 훅이 실수 막기 검사와 다른 값으로 알려 준다(두 곳에서 따로 읽음).
  const told = readResultPaths(root);
  assert.deepEqual(told, { aiRoot: s.aiRoot, otherPcRoot: s.otherPcRoot, phoneRoot: s.phoneRoot }, 'the session-start notice and the checks read one place');
  assert.equal(
    resultPathsBlock(told),
    `<secretary-paths>\n결과물 상위 폴더(이 PC 전용 설정에서 읽음, 그 안 경로는 이 셋을 앞에 붙여 바꿔 쓴다): 이 PC: ${ai} · 다른 PC: Y:\\results · 폰 주소: https://pc.example.ts.net/share/${path.basename(ai)}\n</secretary-paths>`,
  );
  assert.match(resultPathsBlock({ ...told, phoneRoot: null }), /다른 PC: Y:\\results\n/, 'only the values set');
  assert.equal(resultPathsBlock({ aiRoot: ai, otherPcRoot: null, phoneRoot: null }), '', 'neither set (a release as installed): no block, this PC path only');
  // Written by PowerShell with a BOM: read the same.
  write(thisSecretary, `\uFEFF${JSON.stringify({ paths: { otherPcRoot: 'W:\\r' }, 'mistake-guards': { levels: { english: 'warn' } } })}`);
  assert.equal(readGuardSettings(root).otherPcRoot, 'W:\\r');
  // The feature off: nothing runs, its section is not read, and the other PC path (no feature) still is.
  write(path.join(root, 'features.json'), withGuards(false));
  assert.equal(guardsOn(root), false);
  assert.equal(readGuardSettings(root).on, false);
  assert.equal(readGuardSettings(root).levels.english, DEFAULT_LEVELS.english);
  assert.equal(readGuardSettings(root).otherPcRoot, 'W:\\r');
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
const toolUse = (uuid: string, name: string, input: object = {}) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${uuid}`, name, input }] } });
const toolResult = (uuid: string) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const says = (uuid: string, text: string, extra: object = {}) => line({ type: 'assistant', uuid, message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] }, ...extra });

test('the last turn: its start, tools in order (a skill by name), and the answer after the last tool call', () => {
  const t = lastTurn([
    userSays('u1', '옛 질문'),
    says('a1', '옛 답'),
    userSays('u2', '테스트 돌려 줘'),
    says('a2', '돌려 볼게요.'),
    toolUse('a3', 'PowerShell', { command: 'npm test' }),
    toolResult('r1'),
    line({ type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: 'skill text' } }),
    toolUse('a4', 'Skill', { skill: 'delegate' }),
    toolResult('r2'),
    says('a5', '다 통과했어요.'),
    says('a6', '다음 행동 및 순서: 없음'),
  ]);
  assert.equal(t.startUuid, 'u2');
  assert.equal(t.startText, '테스트 돌려 줘');
  assert.deepEqual(t.tools, ['PowerShell', 'Skill:delegate']);
  assert.equal(t.answer, '다 통과했어요.\n\n다음 행동 및 순서: 없음');
  assert.equal(t.synthetic, false);
  // A usage-limit line the app wrote ends the turn as synthetic.
  assert.equal(lastTurn([userSays('u1', 'x'), line({ type: 'assistant', uuid: 'a1', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] } })]).synthetic, true);
  // Going on after a Stop hook sent the answer back: its reason does not start a turn, only the new answer counts.
  const again = [userSays('u1', '상태?'), toolUse('a1', 'Read'), toolResult('r1'), says('a2', 'All good.'), userSays('f1', 'Stop hook feedback:\n[답 검사] 다시 써라'), says('a3', '모두 괜찮아요.')];
  assert.equal(lastTurn(again).startUuid, 'u1');
  assert.deepEqual(lastTurn(again).tools, ['Read']);
  assert.equal(lastTurn(again, 'a2').answer, '모두 괜찮아요.');
  assert.equal(lastTurn(again).lastUuid, 'a3');
  // 없으면 놓치는 실수: 머리를 바꾸기 전에 열린 세션의 대화 기록에 남은 옛 머리([답 검사], [답변 검사])를 새 질문으로 읽어 턴을 잘못 나눈다.
  for (const head of ['[답 검사]', '[답변 검사]', '[답변 검사·Stop 훅]']) {
    const back = [userSays('u1', '상태?'), says('a2', 'All good.'), userSays('f1', `${head} 다시 써라`), says('a3', '모두 괜찮아요.')];
    assert.equal(lastTurn(back).startUuid, 'u1', head);
  }
  // A background notification starts a turn as well.
  assert.equal(lastTurn([userSays('u1', 'x'), says('a1', 'y'), userSays('n1', '<task-notification>done</task-notification>'), says('a2', 'z')]).startUuid, 'n1');
});

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

test('levels: a path in a sentence is told on the next prompt, fixed first at the top', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const v = stopGuard(store, { session_id: 'p1' }, { settings, turn: turnOf(`보고서는 ${path.join(settings.aiRoot, 'notes', 'a.md')}에 있어요.`) });
  assert.equal(v.block, undefined);
  assert.deepEqual(v.caught?.map((c) => [c.check, c.level]), [['path-prose', 'warn']]);
  assert.match(guardWarnNotice(store, 'p1'), /이번 답 맨 위에서 먼저 바로잡고[^]*문장 속에/);
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
  // A result path without its link line (with a phone address set) sends it back too.
  const phone = { ...settings, phoneRoot: 'https://pc.example.ts.net/share/results' };
  const at = path.join(settings.aiRoot, 'notes', 'a.md');
  const NOTE = 'https://pc.example.ts.net/share/results/notes/a.md';
  const paths = ['노트를 정리했어요.', '```', at, '```', '```', `${OTHER}\\notes\\a.md`, '```', '', '다음 행동 및 순서: 없음'].join('\n');
  assert.match(stopGuard(store, { session_id: 'f3' }, { settings: phone, turn: turnOf(paths, { startUuid: 'g3' }) }).block ?? '', /링크 줄이 빠졌다/);
  assert.equal(stopGuard(store, { session_id: 'f4' }, { settings: phone, turn: turnOf(paths.replace('```\n\n', `\`\`\`\n[${NOTE}](${NOTE})\n\n`), { startUuid: 'g4' }) }).block, undefined);
  // A level set to warn (levels in the mistake-guards key of this-secretary.local.json) only tells.
  const warned = stopGuard(store, { session_id: 'f5' }, { settings: { ...settings, levels: { ...settings.levels, 'path-pair': 'warn' } }, turn: turnOf(noEnd, { startUuid: 'g5' }) });
  assert.equal(warned.block, undefined);
  assert.deepEqual(warned.caught?.map((c) => `${c.check}:${c.level}`), ['path-pair:warn']);
});

test('stop: only lines missing → the answer stays and only those lines are added; the retry checks, notifies and records both together', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const at = path.join(settings.aiRoot, 'notes', 'a.md');
  const first = `테스트를 다 돌렸어요.\n\n316개 모두 통과했어요.\n\`\`\`\n${at}\n\`\`\`\n\nC. 알림 시각은 언제로 할까요?\n1. 9시 (추천)\n   근거: 지난주 알림 기록 7건 모두 9시 전후에 열람\n2. 기타 (직접 입력)`;
  const sent = stopGuard(store, { session_id: 'l1' }, { settings, turn: turnOf(first, { startUuid: 'h1', lastUuid: 'b1' }) });
  assert.ok(sent.block?.startsWith(FILL_HEAD), String(sent.block));
  assert.match(sent.block ?? '', /빠진 줄만 이어서 쓰고[^]*다른 PC 경로 줄이 빠졌다/);
  assert.doesNotMatch(sent.block ?? '', /다시 써서/);
  // The retry has only the added lines (what came after the answer sent back); checked with the answer, it passes.
  const added = `\`\`\`\n${OTHER}\\notes\\a.md\n\`\`\`\n\n다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: C(알림 시각)`;
  const v = stopGuard(store, { session_id: 'l1', stop_hook_active: true }, { settings, turn: turnOf(added, { startUuid: 'h1', lastUuid: 'b2' }) });
  assert.equal(v.block, undefined);
  assert.equal(v.filled, true);
  assert.equal(v.answer, `${first}\n\n${added}`);
  assert.deepEqual(v.caught?.map((c) => `${c.check}:${c.level}`), ['path-pair:block']);
  assert.equal(guardWarnNotice(store, 'l1'), '', 'nothing left to tell');
  // The phone gets the first answer's conclusion line, not the added lines.
  assert.equal(firstLine(v.answer ?? ''), '테스트를 다 돌렸어요.');
  // Its question labels are counted from the whole answer.
  assert.equal(nextLabel(store, 'l1'), 'D');
  // Still missing after the lines were added: it ends (no loop) and the next prompt is told.
  stopGuard(store, { session_id: 'l2' }, { settings, turn: turnOf(first, { startUuid: 'h2' }) });
  const still = stopGuard(store, { session_id: 'l2', stop_hook_active: true }, { settings, turn: turnOf('다음 행동 및 순서: 없음', { startUuid: 'h2' }) });
  assert.equal(still.block, undefined);
  assert.match(guardWarnNotice(store, 'l2'), /다른 PC 경로 줄이 빠졌다/);
});

test('stop: English with a line missing is written again whole (the rewrite wins); the retry is only the new answer', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const english = `All tests passed.\n\nThe report is here:\n\`\`\`\n${path.join(settings.aiRoot, 'notes', 'a.md')}\n\`\`\`\nI will wait.`;
  const sent = stopGuard(store, { session_id: 'e1' }, { settings, turn: turnOf(english, { startUuid: 'k1' }) });
  assert.match(sent.block ?? '', /^\[답변 검사·Stop 훅\] 답을 끝내기 전에 바로잡는다\.[^]*한국어로 다시 써서[^]*다른 PC 경로 줄이 빠졌다/);
  assert.ok(!sent.block?.startsWith(FILL_HEAD));
  const korean = '테스트가 모두 통과했어요.\n\n남은 일은 없어요.\n\n다음 행동 및 순서: 없음';
  const v = stopGuard(store, { session_id: 'e1', stop_hook_active: true }, { settings, turn: turnOf(korean, { startUuid: 'k1' }) });
  assert.equal(v.block, undefined);
  assert.equal(v.filled, undefined);
  assert.equal(v.answer, korean);
  assert.equal(firstLine(v.answer ?? ''), '테스트가 모두 통과했어요.');
  // A form check only, but set to block a check that is not fixed by added lines (path-prose): written again whole.
  const prose = { ...settings, levels: { ...settings.levels, 'path-prose': 'block' as const } };
  const inProse = `보고서는 ${path.join(settings.aiRoot, 'notes', 'a.md')}에 있어요.\n둘째 줄.\n다음 행동 및 순서: 없음`;
  assert.match(stopGuard(store, { session_id: 'e2' }, { settings: prose, turn: turnOf(inProse, { startUuid: 'k2' }) }).block ?? '', /^\[답변 검사·Stop 훅\] 답을 끝내기 전에/);
});

test('stop: a missing link or other-PC line is fixed by adding only that line after the answer (the paths already there are not repeated)', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'), { phoneRoot: 'https://pc.example.ts.net/share/results' });
  const at = path.join(settings.aiRoot, 'notes', 'a.md');
  const NOTE = 'https://pc.example.ts.net/share/results/notes/a.md';
  const first = ['노트를 정리했어요.', '```', at, '```', '```', `${OTHER}\\notes\\a.md`, '```', '', '나머지 설명이에요.', '', '다음 행동 및 순서: 없음'].join('\n');
  const sent = stopGuard(store, { session_id: 'k1' }, { settings, turn: turnOf(first, { startUuid: 'j1' }) });
  assert.ok(sent.block?.startsWith(FILL_HEAD), String(sent.block));
  assert.match(sent.block ?? '', /링크 줄이 빠졌다[^]*빠진 링크 줄만 이어 쓴다/);
  const v = stopGuard(store, { session_id: 'k1', stop_hook_active: true }, { settings, turn: turnOf(`[${NOTE}](${NOTE})`, { startUuid: 'j1' }) });
  assert.equal(v.block, undefined);
  assert.deepEqual(v.findings, []);
  // The other PC's line missing too: only it (in a code block) and the link are added.
  const lone = ['노트를 정리했어요.', '```', at, '```', '', '나머지 설명이에요.', '', '다음 행동 및 순서: 없음'].join('\n');
  const sent2 = stopGuard(store, { session_id: 'k2' }, { settings, turn: turnOf(lone, { startUuid: 'j2' }) });
  assert.match(sent2.block ?? '', /다른 PC 경로 줄이 빠졌다[^]*빠진 다른 PC 경로 줄만 자기 코드 블록으로/);
  const added = ['```', `${OTHER}\\notes\\a.md`, '```', `[${NOTE}](${NOTE})`].join('\n');
  const v2 = stopGuard(store, { session_id: 'k2', stop_hook_active: true }, { settings, turn: turnOf(added, { startUuid: 'j2' }) });
  assert.equal(v2.block, undefined);
  assert.deepEqual(v2.findings, []);
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
  // Options under no labelled question cannot be fixed by writing a question block again: the answer is written whole.
  assert.equal(checkRecommendBasis([...body, '1. 지금 고친다 (추천)', '2. 나중에', ...end].join('\n'))?.rewrite, true);
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

// 없으면 놓치는 실수: 2026-11-10 실제 답 두 개. 확인한 규칙 글을 따옴표로 옮긴 근거가 그 안의 "확인 안 됨" 때문에 안 봄으로 걸리고, 새 형식 "자료 있음, 못 봄(화면, 이유: …)" 뒤에 이은 문장이 그 "못 봄" 때문에 같이 걸린다.
test('basis-unopened: words inside quotes are not the basis\'s own, and the new form is judged by its parentheses, the rest of the line by itself', () => {
  const ask = (basis: string) => ['기록을 봤어요.', '', 'G. 어떻게 할까요?', '1. 고친다 (추천)', `   > 근거: ${basis}`, '2. 기타 (직접 입력)', '', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'].join('\n');
  const quoted = 'AGENTS.md의 정확성 항목에 "화면처럼 비서가 볼 수 없는 것은 확인 안 됨으로 말하고 사용자에게 봐 달라고 한다"고 되어 있습니다.';
  const after = '자료 있음, 못 봄(폰 Remote Control 화면, 이유: 비서가 볼 수 없음). 서브에이전트가 연 공식 hooks 문서에는 systemMessage가 사용자에게 보인다고 되어 있습니다.';
  for (const basis of [quoted, quoted.replace(/"/g, '「').replace(/「([^「]*)「/, '「$1」'), after]) {
    assert.deepEqual(checkAnswer(ask(basis), roots('C:\\r')).filter((f) => f.check.startsWith('basis-')), [], basis);
  }
  // Outside the quotes the basis still says it: caught. And a thing one could open inside the new form's parentheses is too.
  assert.equal(checkBasisUnopened(ask(`${quoted} 그 줄 번호는 확인 안 함`))?.check, 'basis-unopened');
  assert.equal(checkBasisUnopened(ask(`${after} 그 문서 보고는 안 봄`))?.check, 'basis-unopened');
  assert.equal(checkBasisUnopened(ask('자료 있음, 안 봄(paths.ts 21줄)'))?.check, 'basis-unopened');
});

// 없으면 놓치는 실수: "자료 있음, 못 봄(…)"을 못 연 까닭 없이 써서 안 본 것을 못 본 것처럼 넘긴다(2026-11-12 결정: 못 보는 것은 이유가 있어야 한다). 또는 까닭을 적었는데 괄호 안의 파일·줄 번호 때문에 걸린다.
test('basis-unopened: "자료 있음, 못 봄(<무엇>, 이유: <못 연 이유>)" passes only with a reason after "이유:", whatever it names', () => {
  const ask = (basis: string) => ['기록을 봤어요.', '', 'G. 어떻게 할까요?', '1. 고친다 (추천)', `   > 근거: ${basis}`, '2. 기타 (직접 입력)', '', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'].join('\n');
  const basisChecks = (basis: string) => checkAnswer(ask(basis), roots('C:\\r')).map((f) => f.check).filter((c) => c.startsWith('basis-'));
  for (const basis of [
    '자료 있음, 못 봄(paths.ts 21줄, 이유: 다른 PC에만 있는 파일이라 이 PC에서 열 수 없음)',
    '자료 있음, 못 봄(`git log` 출력, 이유: 저장소가 잠겨 명령이 실패함)',
    '자료 있음, 못 봄(다른 기기의 기록, 이유：그 기기가 꺼져 있음)',
    '자료 있음, 못 봄(이유: 서브에이전트 보고가 아직 오지 않음)',
    '자료 있음, 못 봄(업무 세션 보고, 이유: "아직 쓰는 중"이라 파일이 없음)',
  ]) assert.deepEqual(basisChecks(basis), [], basis);
  for (const basis of ['자료 있음, 못 봄(paths.ts 21줄)', '자료 있음, 못 봄(폰 화면)', '자료 있음, 못 봄', '자료 있음, 못 봄(폰 화면, 이유: )', '자료 있음, 못 봄(폰 화면, 이유:)']) {
    assert.deepEqual(basisChecks(basis), ['basis-unopened'], basis);
    assert.match(checkBasisUnopened(ask(basis))?.reason ?? '', /못 연 이유를 적지 않았다[^]*이유: <못 연 이유>/, basis);
  }
  // A reason does not cover the old words outside the form.
  assert.deepEqual(basisChecks('자료 있음, 못 봄(화면, 이유: 볼 수 없음). a.md도 안 봄'), ['basis-unopened']);
});

// 없으면 놓치는 실수: 근거 형식을 바꿀 때 답변 검사·업무 공간 규칙 글·AGENTS.md 중 한 곳만 고쳐, 규칙이 가르치는 형식과 검사가 받는 형식이 어긋난다(2026-11-12 "안 봄"→"못 봄" 때 grep으로 모두 찾아야 했다).
test('basis forms: the answer check, the workspace charter and AGENTS.md (and the release copy) say the same two forms', () => {
  const ask = (basis: string) => ['기록을 봤어요.', '', 'G. 어떻게 할까요?', '1. 고친다 (추천)', `   > 근거: ${basis}`, '2. 기타 (직접 입력)', '', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'].join('\n');
  const rules = [path.join(PROJECT_ROOT, 'AGENTS.md'), path.join(PROJECT_ROOT, 'release-src', 'overlay', 'AGENTS.md')].filter((f) => fs.existsSync(f));
  assert.ok(rules.length >= 1);
  for (const f of rules) {
    const text = fs.readFileSync(f, 'utf8');
    for (const form of [BASIS_UNABLE, BASIS_GUESS]) assert.ok(text.includes(`근거: ${form}`), `${f}: "근거: ${form}"`);
  }
  for (const form of [BASIS_UNABLE, BASIS_GUESS]) assert.ok(QUESTION_BASIS_RULE.includes(`"근거: ${form}"`), form);
  assert.ok(checkBasisOldForm(ask('확인 안 함(짐작)'))?.reason.includes(`"근거: ${BASIS_UNABLE}"`));
  // The form as written passes the check, filled in.
  assert.deepEqual(checkAnswer(ask(BASIS_UNABLE.replace('<무엇>', 'paths.ts 21줄').replace('<못 연 이유>', '다른 기기에만 있음')), roots('C:\\r')).filter((x) => x.check.startsWith('basis-')), []);
});

// 없으면 놓치는 실수: 추천 근거를 두 형식으로 나눈 뒤(2026-11-10)에도 옛 형식 "근거: 확인 안 함(짐작)"을 쓰고, 자료가 있는지 없는지 가르지 않고 넘어간다.
test('basis-old-form: a basis saying "확인 안 함" with nothing to open is told to use the two forms; with something to open it is basis-unopened\'s, never both', () => {
  const ask = (basis: string) => ['기록을 봤어요.', '', 'G. 어떻게 할까요?', '1. 고친다 (추천)', `   > 근거: ${basis}`, '2. 기타 (직접 입력)', '', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'].join('\n');
  const basisChecks = (basis: string) => checkAnswer(ask(basis), roots('C:\\r')).map((f) => f.check).filter((c) => c.startsWith('basis-'));
  for (const basis of ['확인 안 함(짐작)', '확인 안 함(짐작, 기록에 없음)', '미확인', '화면은 확인 안 됨', '**확인 안 함**']) {
    assert.deepEqual(basisChecks(basis), ['basis-old-form'], basis);
    assert.match(checkBasisOldForm(ask(basis))?.reason ?? '', /자료 있음, 못 봄[^]*이유:[^]*확인할 자료 없음\(짐작\)/);
  }
  // The two forms, a checked basis, and a basis naming something to open (basis-unopened only).
  for (const basis of ['확인할 자료 없음(짐작)', '자료 있음, 못 봄(꺼진 다른 기기의 기록, 이유: 그 기기가 꺼져 있음)', 'paths.ts 21줄을 열어 보니 두 곳에서 부름']) assert.deepEqual(basisChecks(basis), [], basis);
  // The form before 2026-11-12 ("자료 있음, 안 봄(<무엇>)"): the old form when it names nothing to open, basis-unopened when it does.
  assert.deepEqual(basisChecks('자료 있음, 안 봄(꺼진 다른 기기의 기록)'), ['basis-old-form']);
  assert.deepEqual(basisChecks('자료 있음, 안 봄(`git log` 출력)'), ['basis-unopened']);
  assert.deepEqual(basisChecks('paths.ts 21줄(확인 안 함)'), ['basis-unopened']);
  // A rule quoted: not the basis's own words.
  assert.deepEqual(basisChecks('옛 규칙의 "근거: 확인 안 함(짐작)" 꼴은 쓰지 않기로 함(AGENTS.md 11줄을 열어 봄)'), []);
  assert.equal(checkBasisOldForm(['```', '> 근거: 확인 안 함(짐작)', '```'].join('\n')), null);
});
test('stop: a pick without its basis sends the answer back to write that question block again; the retry reads the block written again', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const first = ['되풀이 점검 기록을 봤어요.', '', '이미지 알림 11건이 있었어요.', '', 'G. 이미지 읽기를 어떻게 셀까요?', '1. 그대로 센다. 2~3주 지켜본다 (추천)', '2. 세지 않는다', '3. 기타 (직접 입력)', '', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'].join('\n');
  const sent = stopGuard(store, { session_id: 'r1' }, { settings, turn: turnOf(first, { startUuid: 'q1' }) });
  assert.ok(sent.block?.startsWith(FILL_HEAD), String(sent.block));
  assert.match(sent.block ?? '', /추천 근거\("> 근거:" 줄\)가 없다[^]*그 질문 블록\(질문 줄과 선택지 전체\)을 같은 질문 알파벳으로 다시 적고/);
  const block = ['G. 이미지 읽기를 어떻게 셀까요?', '1. 세지 않는다 (추천)', '   근거: image-hits.md를 열어 보니 11건 중 8건이 모아보기 시트', '2. 그대로 센다', '3. 기타 (직접 입력)'].join('\n');
  const v = stopGuard(store, { session_id: 'r1', stop_hook_active: true }, { settings, turn: turnOf(block, { startUuid: 'q1' }) });
  assert.equal(v.block, undefined);
  assert.equal(v.filled, true);
  assert.deepEqual(v.findings, [], 'the block written again counts, not the first one');
  assert.deepEqual(v.caught?.map((c) => `${c.check}:${c.level}`), ['recommend-basis:block']);
  assert.equal(guardWarnNotice(store, 'r1'), '');
  // Its mistakes-record group is the one merged group for recommending without checking (migration 18).
  store.appendLog([{ session_id: 'r1', message_uuid: 'q1', role: 'user', content: '어떻게 할까?', created_at: new Date().toISOString() }]);
  assert.equal(recordGuardMistakes(store, 'r1', v), 1);
  assert.deepEqual(store.listMistakes().map((m) => [m.group_name, m.found_by]), [['확인 없이 추천', '장치']]);
  assert.match(store.listMistakes()[0].what, /^근거 없는 추천\(막음/);
  // Inside a subagent nothing is sent back; a pick under no labelled question has the answer written whole.
  assert.equal(stopGuard(store, { session_id: 'r2', agent_id: 'sub' }, { settings, turn: turnOf(first, { startUuid: 'q2' }) }).block, undefined);
  const unlabelled = first.replace('G. 이미지 읽기를 어떻게 셀까요?', '이미지 읽기는 이렇게 할 수 있어요.');
  assert.match(stopGuard(store, { session_id: 'r3' }, { settings, turn: turnOf(unlabelled, { startUuid: 'q3' }) }).block ?? '', /^\[답변 검사·Stop 훅\] 답을 끝내기 전에/);
});

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

test('mistakes: what the checks caught is recorded once per turn and check, found by the guard, with the turn as evidence', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  store.appendLog([
    { session_id: 'm1', message_uuid: 'u9', role: 'user', content: '상태?', created_at: new Date().toISOString() },
    { session_id: 'm1', message_uuid: 'a9', role: 'assistant', content: '모두 괜찮아요.', created_at: new Date().toISOString() },
  ]);
  // Blocked for English, then written again in Korean with a path in a sentence: two catches, one row each.
  stopGuard(store, { session_id: 'm1' }, { settings, turn: turnOf('All good.', { lastUuid: 'a8' }) });
  const v = stopGuard(store, { session_id: 'm1', stop_hook_active: true }, { settings, turn: turnOf(`모두 괜찮아요. ${path.join(settings.aiRoot, 'notes', 'a.md')} 참고.`) });
  assert.deepEqual(v.caught?.map((c) => `${c.check}:${c.level}`), ['english:block', 'path-prose:warn']);
  assert.equal(recordGuardMistakes(store, 'm1', v), 2);
  const rows = store.listMistakes();
  assert.deepEqual(rows.map((m) => [m.group_name, m.found_by, m.made_by, m.cause, m.log_ids]).sort(), [
    ['english', '장치', '비서', '안 지킴', '1,2'],
    ['path-prose', '장치', '비서', '안 지킴', '1,2'],
  ]);
  assert.match(rows.find((m) => m.group_name === 'english')!.what, /^영어로 쓴 답\(막음: 되돌려 고쳐 씀\): 방금 답이 영어로 쓰였다/);
  assert.equal(recordGuardMistakes(store, 'm1', v), 0, 'the same turn again adds nothing');
  // A turn with nothing caught records nothing.
  assert.equal(recordGuardMistakes(store, 'm1', stopGuard(store, { session_id: 'm1' }, { settings, turn: turnOf('괜찮아요.', { startUuid: 'u10' }) })), 0);
  assert.equal(store.listMistakes().length, 2);
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
  assert.deepEqual(store.listMistakes().map((m) => [m.group_name, m.found_by, m.log_ids]), [['english', '장치', '1,2']], 'the catch is in the mistakes record');
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

test('question labels: a label with a note in brackets counts; the remaining line does not move the next label', () => {
  const store = testStore();
  startLabelsAfter(store, 'r1', 19); // next is T
  // "T(S 다시). …?": the label with a note before its dot.
  noteAnswerLabels(store, 'r1', 'S를 자세히 봤어요.\n\nT(S 다시). 첫 판 수준을 어떻게 할까요?\n1. 이대로\n2. 기타 (직접 입력)\n\n남은 질문: T');
  assert.equal(nextLabel(store, 'r1'), 'U');
  noteAnswerLabels(store, 'r1', 'U. 어떻게 띄울까요?\n1. 도우미\n2. 기타 (직접 입력)\n\n**W(인증).** 비밀번호를 걸까요?\n1. 아니요\n2. 기타 (직접 입력)');
  assert.equal(nextLabel(store, 'r1'), 'X');
  // 없으면 놓치는 실수: "남은 질문:" 줄의 뜻 속 대문자("F(새PC UAC 단계)"의 PC)를 기호로 세어 다음 기호가 F에서 PD로 건너뛴다.
  // The next label counts question lines only ("X. …?"): the remaining line, its notes and its labels move nothing.
  noteAnswerLabels(store, 'r1', '결과예요.\n\n남은 질문: U, W(인증), F(새PC UAC 단계)\n\n다음 행동 및 순서: 없음');
  assert.equal(nextLabel(store, 'r1'), 'X');
  // A carried question shown again in a new session's first answer ("A(옛 G, #1234). …?") is a question line.
  assert.deepEqual(usedLabels('A(옛 G, #1234). 알림 시각은요?\n1. 9시\n\n남은 질문: A, B'), ['A']);
  // A label mentioned in a sentence is not a question.
  assert.deepEqual(usedLabels('F(알림 시각)는 정했어요.'), []);
  // The whole turn is read: a question asked before the last tool call counts too.
  const t = lastTurn([userSays('u1', 'q'), says('a1', 'Y. 이름은요?\n1. 기타 (직접 입력)'), toolUse('a2', 'PushNotification'), toolResult('r1'), says('a3', '보냈어요.')]);
  assert.equal(t.answer, '보냈어요.');
  stopGuard(store, { session_id: 'r1' }, { settings: roots(path.join(os.tmpdir(), 'results')), turn: t });
  assert.equal(nextLabel(store, 'r1'), 'Z');
  // The question line with a note that has capitals in it counts its own label only.
  noteAnswerLabels(store, 'r1', 'Z(새PC UAC 단계). 지금 할까요?\n1. 예\n2. 기타 (직접 입력)');
  assert.equal(nextLabel(store, 'r1'), 'AA');
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

test('folder place: home-folder variables and the Git Bash form are read', () => {
  const home = os.homedir();
  const ai = path.join(home, 'results-guard-test-not-there');
  const ctx = { aiRoot: ai, cwd: home, existing: new Set(['workspaces']) };
  assert.ok(commandPlaceProblem(`mkdir $env:USERPROFILE\\${path.basename(ai)}\\newdir`, ctx));
  assert.ok(commandPlaceProblem(`mkdir ~/${path.basename(ai)}/newdir`, ctx));
  const drive = /^([A-Za-z]):\\(.*)$/.exec(ai);
  if (drive) assert.ok(commandPlaceProblem(`mkdir /${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}/newdir`, ctx));
  assert.equal(commandPlaceProblem(`mkdir ~/${path.basename(ai)}/workspaces/x`, ctx), null);
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

// 없으면 놓치는 실수: PreToolUse·PostToolUse 훅이 막거나 알린 것이 어디에도 남지 않아, 장치가 실제로 걸렸는지 셀 수 없다(2026-11-12 조사 2장).
test('a tool hook catch in the secretary session goes into the turn record and list_mistakes counts it; a work session notes none', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const bad = { tool_name: 'Write', tool_input: { file_path: path.join(path.dirname(PROJECT_ROOT), 'zz-guard-test-new', 'a.txt') }, cwd: PROJECT_ROOT };
  const run = (input: object, projectDir: string) =>
    execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'mistake-guards', 'pre-tool-hook.ts')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir } });
  assert.match(run({ ...bad, session_id: 'hk1' }, PROJECT_ROOT), /"deny"/);
  assert.match(run({ ...bad, session_id: 'hk2' }, tempDir()), /"deny"/, 'still refused in a work session');
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  stopGuard(store, { session_id: 'hk1' }, { settings, turn: turnOf('끝났어요.', { startUuid: 'h1' }) });
  stopGuard(store, { session_id: 'hk2' }, { settings, turn: turnOf('끝났어요.', { startUuid: 'h2' }) });
  const [hit] = store.turnTools({ sessionId: 'hk1' })[0].guard;
  assert.deepEqual({ ...hit, at: typeof hit.at }, { check: 'folder-place', level: 'block', hook: 'PreToolUse', tool: 'Write', at: 'string' });
  assert.deepEqual(store.turnTools({ sessionId: 'hk2' })[0].guard, []);
  // Taken once: the next turn has none.
  stopGuard(store, { session_id: 'hk1' }, { settings, turn: turnOf('또 끝.', { startUuid: 'h3' }) });
  assert.deepEqual(store.turnTools({ sessionId: 'hk1' })[0].guard, []);
  assert.match(formatGuardHits(store.guardHitSummary('2000-01-01T00:00:00Z')).join('\n'), /^- PreToolUse 폴더 쓰기 막기\(folder-place, 막음\): 1번 · 마지막 /);
});

test('worker-folder-guard: a work session command that makes a top-level folder or writes into temp is refused', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const ai = aiRootWith('workspaces', 'temp');
  const ws = path.join(ai, 'workspaces', 'space');
  fs.mkdirSync(ws, { recursive: true });
  const run = (command: string) => workerCheck('PowerShell', { command }, ws, { cwd: ws, aiRoot: ai });
  assert.match(run(`mkdir ${path.join(ai, '_sandbox')}`) ?? '', /새 폴더·파일은[^]*바로 아래[^]*\[질문\]/);
  assert.match(run('Set-Content ..\\..\\temp\\x.txt 1') ?? '', /임시 작업 폴더/);
  assert.equal(run('mkdir output\\research\\x'), null);
  assert.equal(run(`Get-ChildItem ${path.join(ai, 'temp')}`), null);
  // Writes outside the workspace stay refused as before.
  assert.match(workerCheck('Write', { file_path: path.join(ai, 'temp', 'x') }, ws) ?? '', /공간 폴더 안에만/);
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

// 없으면 놓치는 실수: 추천 근거에 파일·기억 번호를 적었지만 그 턴에 열지 않았는데 아무도 모른다(사용자가 되물어 추천이 바뀐 일의 주 원인). 또는 연 자료를 안 연 것으로 잘못 알린다.
test('basis-source: a source the window never opened, or a basis with no source and no "not seen" form, is told; opened ones pass', () => {
  const seen = seenInTurns(
    parsedLines(
      userSays('u1', '옛 질문'),
      toolWith('a0', 'x0', 'Read', { file_path: 'C:\s\src\old\three-turns-ago.ts' }),
      userSays('u2', '두 번째'),
      says('a1', '답'),
      userSays('u3', '세 번째'),
      says('a2', '답'),
      userSays('u4', '이번 질문'),
      toolWith('a3', 't1', 'Read', { file_path: 'C:\s\src\hooks\run-hook.ts' }),
      resultOf('r1', 't1', '119 store.linkTurnMemories(input.session_id);'),
      toolWith('a4', 't2', 'mcp__secretary__recall', { ids: [900163] }),
      resultOf('r2', 't2', '#900163 decision: ...'),
      toolWith('a5', 't3', 'PowerShell', { command: 'git log --oneline -3' }),
      resultOf('r3', 't3', '1234567 커밋'),
    ),
  );
  assert.equal(checkBasisSource(pick('run-hook.ts 119줄을 열어 보니 Stop 훅이 잇는다. 기억 #900163, `git log --oneline -3`의 `1234567`'), seen), null);
  const missed = checkBasisSource(pick('three-turns-ago.ts 21줄과 기억 #900999'), seen);
  assert.equal(missed?.check, 'basis-source');
  assert.match(missed!.reason, /연 흔적이 없다[^]*three-turns-ago\.ts[^]*#900999/);
  assert.match(checkBasisSource(pick('이 방식이 더 깔끔해 보인다'), seen)?.reason ?? '', /추론만 있다/);
  // The two forms for "not seen", the judge's line and the user's own words are no bare reasoning; a line reference or value in backticks is no command.
  for (const b of ['확인할 자료 없음(짐작)', '자료 있음, 못 봄(폰 화면, 이유: 볼 수 없음)', '사용자 말(이번 질문)대로', 'run-hook.ts의 `:119`와 `{"open":[]}`']) assert.equal(checkBasisSource(pick(b), seen), null, b);
  // No transcript read (a test turn, an unreadable file): nothing said.
  assert.equal(checkBasisSource(pick('어디에도 없는 a.ts'), null), null);
});

// 없으면 놓치는 실수: 서브에이전트·run-job 보고에 나온 경로를 열어 보지 않고 사용자에게 옮긴다.
test('report-relay: an answer passing on a report names its paths the secretary never opened', () => {
  const after = (...extra: string[]) =>
    seenInTurns(parsedLines(userSays('u1', '조사해 줘'), toolWith('a1', 't1', 'Agent', { prompt: '조사' }), resultOf('r1', 't1', '보고: C:\w\out\REPORT.md 와 C:\w\out\scenes.jsonl 에 썼다'), ...extra));
  const answer = '조사가 끝났어요.\n\n```\nC:\w\out\REPORT.md\n```';
  assert.match(checkReportRelay(answer, after())?.reason ?? '', /열어 보지 않고 전했다[^]*REPORT\.md/);
  assert.equal(checkReportRelay(answer, after(toolWith('a2', 't2', 'Read', { file_path: 'C:\w\out\REPORT.md' }))), null);
  // A path the report never named is not this check's.
  assert.equal(checkReportRelay('```\nC:\w\other\notes.md\n```', after()), null);
});

// 없으면 놓치는 실수: 사용자가 되물은 지어낸 말("칸", "두 꼴")을 질문·선택지에 또 쓴다(한 번 지적받은 "칸"이 다시 나온 적이 있다). 또는 "틀린"처럼 다른 낱말 속 글자나 괄호로 푼 말에 걸린다.
test('invented-word: a listed word in a question, option or basis without an explanation is told; inside other words, explained or in code it is not', () => {
  const words = ['칸', '두 꼴', '틀'];
  assert.deepEqual(inventedWordsIn(pick('기억 표에 새 칸을 둔다'), words).map((w) => w.word), ['칸']);
  assert.deepEqual(inventedWordsIn('A. 두  꼴을 하나로 합칠까요?\n1. 예 (추천)', words).map((w) => w.word), ['두 꼴']);
  for (const ok of ['A. 틀린 곳을 고칠까요?', 'A. 칸(컬럼)을 더할까요?', 'A. `칸` 이름을 바꿀까요?', '설명 문단에 나온 칸은 보지 않는다', 'A. 공간을 쓸까요?']) assert.deepEqual(inventedWordsIn(ok, words), [], ok);
  assert.equal(checkInventedWords(pick('새 칸'), [])?.check, undefined);
  // The list in git carries the user's first words, and record_mistake adds more for this database only.
  for (const w of ['칸', '꼴', '입구', '틀', '손', '머리 글', '두 꼴']) assert.ok(baseInventedWords().includes(w), w);
  const store = testStore();
  assert.deepEqual(addInventedWords(store, ['  자리표 ', '칸', '자리표']), ['자리표']);
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

// 없으면 놓치는 실수: 같은 실수를 새 분류 이름으로 적어 재발로 세지 못한다(네 이름으로 갈라졌던 "확인 없이 추천", 옮기기 18).
test('record_mistake: a new group name is shown the existing ones sharing its words; update_mistake can move a record into one', () => {
  const names = ['확인 없이 추천', '지어낸 말', '보고 검수 없이 전함', '영어 답'];
  assert.deepEqual(similarGroups('추천 근거 확인 안 함', names).slice(0, 1), ['확인 없이 추천']);
  assert.deepEqual(similarGroups('확인 없이 추천', names), []);
  assert.deepEqual(similarGroups('경로 표기', names), []);
  const store = testStore();
  const m = store.recordMistake({ what: 'x', group: '추천 근거 확인 안 함', madeBy: '비서', foundBy: '사용자', cause: '안 지킴' });
  assert.equal(store.updateMistake(m.id, { group: '확인 없이 추천' })?.group_name, '확인 없이 추천');
});
