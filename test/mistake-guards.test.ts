import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, testStore, write } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { isShieldedLocal, writeLocalJson } from '../src/core/local-settings.ts';
import { readFeatures } from '../src/setup/features.ts';
import { readResultPaths } from '../src/core/result-paths.ts';
import { resultPathsBlock } from '../src/hooks/session-start.ts';
import { carryOverQuestions, openQuestionLines } from '../src/session-continuity/open-questions.ts';
import { checkAnswer, checkClosing, checkEnglish, checkPaths, checkRecommendBasis, hangulRatio, isResultPath, SHORT_ANSWER_LINES, unbackedPicks } from '../src/mistake-guards/answer-checks.ts';
import { commandPlaceProblem, mentionedPaths, writePlaceProblem } from '../src/mistake-guards/folder-place.ts';
import { labelNotice, nextLabel, noteAnswerLabels, startLabelsAfter, usedLabels } from '../src/mistake-guards/question-labels.ts';
import { preToolProblem } from '../src/mistake-guards/pre-tool-hook.ts';
import { DEFAULT_LEVELS, guardsOn, readGuardSettings, type GuardSettings } from '../src/mistake-guards/mistake-guard-settings.ts';
import { FILL_HEAD, guardWarnNotice, recordGuardMistakes, stopGuard } from '../src/mistake-guards/stop-guard.ts';
import { firstLine } from '../src/phone-push/ntfy.ts';
import { lastTurn, type Turn } from '../src/mistake-guards/last-turn.ts';
import { formatMistake } from '../src/mcp/mistake-tools.ts';
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

test('paths: a results path inside a sentence, the preview with ? in the drive form, and a code path without its pair', () => {
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
  assert.match(noLink[0].reason, /링크 줄이 빠졌다: notes\/My Note\.md[^]*주소 자체를 링크 이름으로[^]*코드 줄로 따로 쓰지 않는다/);
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
  // A link to another address, or a link inside a code block, does not count.
  assert.deepEqual(checkPaths(`${spaced}\n${linkTo(PREVIEW)}`, phone).map((f) => f.check), ['path-link']);
  assert.deepEqual(checkPaths(`${spaced}\n\`\`\`\n${linkTo(NOTE)}\n\`\`\``, phone).map((f) => f.check), ['path-link']);
  // A local path is still caught in a link: its label, or a file:/// target (which is not the phone address's link).
  assert.deepEqual(tapped(`[${at('notes\\My Note.md')}](${NOTE})`).map((f) => f.check), ['path-prose']);
  assert.deepEqual(tapped(`[열기](file:///${at('notes\\x.html').replace(/\\/g, '/')}?still)`).map((f) => f.check), ['path-prose', 'path-preview', 'path-link']);
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
  // A local path with a query string, in any form (drive, file:///, share, this PC): a local preview takes none.
  const preview = (l: string, x = s) => checkPaths(['```', l, '```'].join('\n'), x).map((f) => f.check);
  assert.deepEqual(preview(`${OTHER}\\workspaces\\a\\preview.html?still&only=7c`), ['path-preview']);
  assert.deepEqual(preview('file:///Y:/results/workspaces/a/preview.html?still'), ['path-preview']);
  assert.deepEqual(preview('file:///C:/Users/x/page.html?scene=3', roots(ai, { otherPcRoot: null })), ['path-preview']);
  assert.deepEqual(preview('\\\\otherhost\\results\\page.html?still', roots(ai, { otherPcRoot: null })), ['path-preview']);
  assert.match(checkPaths(`${at('workspaces\\a\\p.html')}?still`, roots(ai, { otherPcRoot: null })).find((f) => f.check === 'path-preview')?.reason ?? '', /쿼리스트링 없는 주소[^]*페이지 안 버튼/);
  // Web addresses keep their query strings; a local path without one, or a question mark ending a sentence, is fine.
  assert.deepEqual(preview('https://pc.example.ts.net/share/results/workspaces/a/preview.html?still', roots(ai, { otherPcRoot: null })), []);
  assert.deepEqual(preview('http://127.0.0.1:2586/x?y=1', roots(ai, { otherPcRoot: null })), []);
  assert.deepEqual(preview('file:///Y:/results/workspaces/a/preview.html'), []);
  assert.deepEqual(checkPaths('C:\\Windows\\notepad.exe? 그건 아니에요.', roots(ai, { otherPcRoot: null })), []);
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
  // 없으면 놓치는 실수: 규칙에서 뺀 이 PC·다른 PC 경로와 폰 주소를 세션 시작 훅이 실수 막기 검사와 다른 값으로 알려 준다(두 곳에서 따로 읽음).
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
  // A background notification starts a turn as well.
  assert.equal(lastTurn([userSays('u1', 'x'), says('a1', 'y'), userSays('n1', '<task-notification>done</task-notification>'), says('a2', 'z')]).startUuid, 'n1');
});

// ---- the Stop hook's verdict ----------------------------------------------------------------------------------------

const turnOf = (answer: string, extra: Partial<Turn> = {}): Turn => ({ startUuid: 'u9', startText: 'q', tools: ['Read', 'mcp__secretary__recall'], answer, synthetic: false, lastUuid: 'a9', ...extra });

test('stop: an English answer is sent back once; the second stop lets it end, records the turn and tells the next prompt', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const first = stopGuard(store, { session_id: 's1' }, { settings, turn: turnOf("I'll wait for the background notification.") });
  assert.match(first.block ?? '', /^\[답 검사\][^]*한국어로 다시 써서/);
  assert.equal(store.turnTools().length, 0, 'nothing recorded while the turn goes on');
  // Still English after being sent back: it ends now (no loop), and the next prompt is told.
  const second = stopGuard(store, { session_id: 's1', stop_hook_active: true }, { settings, turn: turnOf('Still English, sorry.') });
  assert.equal(second.block, undefined);
  const [row] = store.turnTools();
  assert.deepEqual(row.tools, ['Read', 'mcp__secretary__recall']);
  assert.deepEqual(row.guard, [{ check: 'english', level: 'block' }, { check: 'english', level: 'warn' }]);
  assert.match(guardWarnNotice(store, 's1'), /^<secretary-answer-check>\n지난 답 검사[^]*영어로 쓰였다/);
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

test('levels: English and the form of the answer block; a path in a sentence or a local ? is told on the next prompt, fixed first at the top', () => {
  assert.deepEqual(DEFAULT_LEVELS, {
    english: 'block',
    'path-prose': 'warn',
    'path-preview': 'warn',
    'path-pair': 'block',
    'path-link': 'block',
    'path-block': 'block',
    'next-action': 'block',
    'open-questions': 'block',
    'recommend-basis': 'block',
  });
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const v = stopGuard(store, { session_id: 'p1' }, { settings, turn: turnOf(`보고서는 ${path.join(settings.aiRoot, 'notes', 'a.md')}에 있어요.`) });
  assert.equal(v.block, undefined);
  assert.deepEqual(v.caught?.map((c) => [c.check, c.level]), [['path-prose', 'warn']]);
  assert.match(guardWarnNotice(store, 'p1'), /이번 답 맨 위에서 먼저 바로잡는다\(무엇이 틀렸고 바른 것이 무엇인지 한두 줄\)[^]*문장 속에/);
});

test('closing lines: "다음 행동 및 순서:" at the end, "남은 질문:" under labelled questions; short answers are not asked for them', () => {
  const body = ['테스트를 다 돌렸어요.', '', '316개 모두 통과했어요.', '흔적도 없어요.'];
  assert.deepEqual(checkClosing([...body, '', '다음 행동 및 순서: 없음'].join('\n')), []);
  assert.deepEqual(checkClosing([...body, '', '**다음 행동 및 순서:**', '1. 새 세션 열기'].join('\n')), []);
  const none = checkClosing(body.join('\n'));
  assert.deepEqual(none.map((f) => f.check), ['next-action']);
  assert.match(none[0].reason, /다음 행동 및 순서: 없음/);
  // A closing line inside a code block does not count.
  assert.deepEqual(checkClosing([...body, '```', '다음 행동 및 순서: 없음', '```'].join('\n')).map((f) => f.check), ['next-action']);
  // Labelled questions want the "남은 질문:" line; "없음" or the labels both do.
  const asking = [...body, '', 'C. 알림 시각은 언제로 할까요?', '1. 9시 (추천)', '2. 기타 (직접 입력)', ''];
  const q = checkClosing([...asking, '다음 행동 및 순서: C에 답해 주세요.'].join('\n'));
  assert.deepEqual(q.map((f) => f.check), ['open-questions']);
  assert.match(q[0].reason, /남은 질문: C/);
  assert.deepEqual(checkClosing([...asking, '남은 질문: C', '', '다음 행동 및 순서: C에 답해 주세요.'].join('\n')), []);
  // Short answers (two lines or fewer) are quick replies.
  assert.deepEqual(checkClosing('기다릴게요.'), []);
  assert.deepEqual(checkClosing('알겠어요.\n끝나면 알려 드릴게요.'), []);
  assert.equal(SHORT_ANSWER_LINES, 2);
});

test('stop: the form checks send the turn back once (never again on the retry, never inside a subagent), and a level set to warn only tells', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const noEnd = '테스트를 다 돌렸어요.\n\n316개 모두 통과했어요.\n남은 일은 없어요.';
  const first = stopGuard(store, { session_id: 'f1' }, { settings, turn: turnOf(noEnd, { startUuid: 'g1' }) });
  assert.match(first.block ?? '', /^\[답 검사\][^]*다음 행동 및 순서/);
  // The retry still lacks it: it ends now and the next prompt is told.
  const retry = stopGuard(store, { session_id: 'f1', stop_hook_active: true }, { settings, turn: turnOf('그래도 빠졌어요.\n둘째 줄.\n셋째 줄.', { startUuid: 'g1' }) });
  assert.equal(retry.block, undefined);
  assert.deepEqual(retry.caught?.map((c) => `${c.check}:${c.level}`), ['next-action:block']);
  assert.match(guardWarnNotice(store, 'f1'), /다음 행동 및 순서/);
  // Inside a subagent nothing is sent back.
  assert.equal(stopGuard(store, { session_id: 'f2', agent_id: 'sub1' }, { settings, turn: turnOf(noEnd, { startUuid: 'g2' }) }).block, undefined);
  // A result path without its link line (with a phone address set) sends it back too.
  const phone = { ...settings, phoneRoot: 'https://pc.example.ts.net/share/results' };
  const at = path.join(settings.aiRoot, 'notes', 'a.md');
  const NOTE = 'https://pc.example.ts.net/share/results/notes/a.md';
  const paths = ['노트를 정리했어요.', '```', at, '```', '```', `${OTHER}\\notes\\a.md`, '```', '', '다음 행동 및 순서: 없음'].join('\n');
  assert.match(stopGuard(store, { session_id: 'f3' }, { settings: phone, turn: turnOf(paths, { startUuid: 'g3' }) }).block ?? '', /링크 줄이 빠졌다/);
  assert.equal(stopGuard(store, { session_id: 'f4' }, { settings: phone, turn: turnOf(paths.replace('```\n\n', `\`\`\`\n[${NOTE}](${NOTE})\n\n`), { startUuid: 'g4' }) }).block, undefined);
  // A level set to warn (scripts/mistake-guards.local.json levels) only tells.
  const warned = stopGuard(store, { session_id: 'f5' }, { settings: { ...settings, levels: { ...settings.levels, 'next-action': 'warn' } }, turn: turnOf(noEnd, { startUuid: 'g5' }) });
  assert.equal(warned.block, undefined);
  assert.deepEqual(warned.caught?.map((c) => `${c.check}:${c.level}`), ['next-action:warn']);
});

test('stop: only lines missing → the answer stays and only those lines are added; the retry checks, notifies and records both together', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const first = '테스트를 다 돌렸어요.\n\n316개 모두 통과했어요.\n\nC. 알림 시각은 언제로 할까요?\n1. 9시 (추천)\n   근거: 지난주 알림 기록 7건 모두 9시 전후에 열람\n2. 기타 (직접 입력)';
  const sent = stopGuard(store, { session_id: 'l1' }, { settings, turn: turnOf(first, { startUuid: 'h1', lastUuid: 'b1' }) });
  assert.ok(sent.block?.startsWith(FILL_HEAD), String(sent.block));
  assert.match(sent.block ?? '', /빠진 줄만 이어서 쓰고[^]*남은 질문: C[^]*다음 행동 및 순서/);
  assert.doesNotMatch(sent.block ?? '', /다시 써서/);
  // The retry has only the added lines (what came after the answer sent back); checked with the answer, it passes.
  const added = '남은 질문: C\n\n다음 행동 및 순서: C에 답해 주세요.';
  const v = stopGuard(store, { session_id: 'l1', stop_hook_active: true }, { settings, turn: turnOf(added, { startUuid: 'h1', lastUuid: 'b2' }) });
  assert.equal(v.block, undefined);
  assert.equal(v.filled, true);
  assert.equal(v.answer, `${first}\n\n${added}`);
  assert.deepEqual(v.caught?.map((c) => `${c.check}:${c.level}`), ['open-questions:block', 'next-action:block']);
  assert.equal(guardWarnNotice(store, 'l1'), '', 'nothing left to tell');
  // The phone gets the first answer's conclusion line, not the added lines.
  assert.equal(firstLine(v.answer ?? ''), '테스트를 다 돌렸어요.');
  // Its question labels are counted from the whole answer.
  assert.equal(nextLabel(store, 'l1'), 'D');
  // Still missing after the lines were added: it ends (no loop) and the next prompt is told.
  stopGuard(store, { session_id: 'l2' }, { settings, turn: turnOf(first, { startUuid: 'h2' }) });
  const still = stopGuard(store, { session_id: 'l2', stop_hook_active: true }, { settings, turn: turnOf('다음 행동 및 순서: 없음', { startUuid: 'h2' }) });
  assert.equal(still.block, undefined);
  assert.match(guardWarnNotice(store, 'l2'), /남은 질문/);
});

test('stop: English with a line missing is written again whole (the rewrite wins); the retry is only the new answer', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const english = 'All tests passed.\n\nNothing else is left.\nI will wait.';
  const sent = stopGuard(store, { session_id: 'e1' }, { settings, turn: turnOf(english, { startUuid: 'k1' }) });
  assert.match(sent.block ?? '', /^\[답 검사\] 답을 끝내기 전에 바로잡는다\.[^]*한국어로 다시 써서[^]*다음 행동 및 순서/);
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
  assert.match(stopGuard(store, { session_id: 'e2' }, { settings: prose, turn: turnOf(inProse, { startUuid: 'k2' }) }).block ?? '', /^\[답 검사\] 답을 끝내기 전에/);
});

test('stop: a missing link or other-PC line is fixed by adding only that line after the answer (the paths already there are not repeated)', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'), { phoneRoot: 'https://pc.example.ts.net/share/results' });
  const at = path.join(settings.aiRoot, 'notes', 'a.md');
  const NOTE = 'https://pc.example.ts.net/share/results/notes/a.md';
  const first = ['노트를 정리했어요.', '```', at, '```', '```', `${OTHER}\\notes\\a.md`, '```', '', '나머지 설명이에요.', '', '다음 행동 및 순서: 없음'].join('\n');
  const sent = stopGuard(store, { session_id: 'k1' }, { settings, turn: turnOf(first, { startUuid: 'j1' }) });
  assert.ok(sent.block?.startsWith(FILL_HEAD), String(sent.block));
  assert.match(sent.block ?? '', /링크 줄이 빠졌다[^]*되풀이하지 않고, 빠진 링크 줄만 이어 쓴다/);
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

// Without it: this PC's and the other PC's path given in one code block (corrected twice on 2026-11-07) goes unseen.
test('path-block: this PC\'s and the other PC\'s path in one code block are caught; written again apart, they pass', () => {
  const settings = roots(path.join(os.tmpdir(), 'results'), { phoneRoot: 'https://pc.example.ts.net/share/results' });
  const at = path.join(settings.aiRoot, 'notes', 'a.md');
  const there = `${OTHER}\\notes\\a.md`;
  const NOTE = 'https://pc.example.ts.net/share/results/notes/a.md';
  const link = `[${NOTE}](${NOTE})`;
  const mixed = ['노트를 정리했어요.', '```', at, there, '```', link, '', '나머지 설명이에요.', '', '다음 행동 및 순서: 없음'].join('\n');
  // Caught as path-block only: the pair and the link are there.
  const f = checkPaths(mixed, settings);
  assert.deepEqual(f.map((x) => x.check), ['path-block']);
  assert.match(f[0].reason, /코드 블록 하나에 같이[^]*경로 하나마다 자기 코드 블록/);
  // Apart (and two files, each in its own blocks): fine. Code lines that are not paths, or one PC only, mix nothing.
  assert.deepEqual(checkPaths(['```', at, '```', '```', there, '```', link].join('\n'), settings), []);
  assert.deepEqual(checkPaths(['```', `Copy-Item ${at} ${there}`, '```'].join('\n'), { ...settings, phoneRoot: null }), []);
  assert.deepEqual(checkPaths(['```', at, path.join(settings.aiRoot, 'notes', 'b.md'), '```'].join('\n'), { ...settings, phoneRoot: null }).map((x) => x.check), ['path-pair']);
  // No other PC set here: nothing to mix.
  assert.deepEqual(checkPaths(mixed, { ...settings, otherPcRoot: null }), []);
  // Sent back to write its paths again apart (the answer stays); the retry checks the two together and passes.
  const store = testStore();
  const sent = stopGuard(store, { session_id: 'b1' }, { settings, turn: turnOf(mixed, { startUuid: 'm1' }) });
  assert.ok(sent.block?.startsWith(FILL_HEAD), String(sent.block));
  assert.match(sent.block ?? '', /코드 블록 하나에 같이[^]*이 PC 경로 블록 하나, 다른 PC 경로 블록 하나로 따로 다시 적고/);
  const v = stopGuard(store, { session_id: 'b1', stop_hook_active: true }, { settings, turn: turnOf(['```', at, '```', '```', there, '```', link].join('\n'), { startUuid: 'm1' }) });
  assert.equal(v.block, undefined);
  assert.deepEqual(v.findings, []);
  // Written again with only one of them apart: still caught (told on the next prompt).
  stopGuard(store, { session_id: 'b2' }, { settings, turn: turnOf(mixed, { startUuid: 'm2' }) });
  const half = stopGuard(store, { session_id: 'b2', stop_hook_active: true }, { settings, turn: turnOf(['```', at, '```'].join('\n'), { startUuid: 'm2' }) });
  assert.deepEqual(half.findings.map((x) => x.check), ['path-block']);
});

test('recommend-basis: an option marked (추천) wants a "근거:" line right under it; code blocks, inline code and short answers aside', () => {
  const body = ['되풀이 점검 기록을 봤어요.', '', '이미지 알림 11건 중 8건이 모아보기 시트였어요.', ''];
  const end = ['', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'];
  const ask = (...options: string[]) => [...body, 'G. 이미지 읽기를 어떻게 셀까요?', ...options, ...end].join('\n');
  // With its basis line (indented or not, bold too): passes.
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   근거: 기록 517개 중 이미지 알림 11건, 8건이 시트(이 턴에 다시 셈)', '2. 그대로 센다', '3. 기타 (직접 입력)')), null);
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '**근거:** 확인 안 함(짐작)', '2. 기타 (직접 입력)')), null);
  assert.equal(checkRecommendBasis(ask('- 1. 세지 않는다 (추천)', '  - 근거： 기억 #120', '- 2. 기타 (직접 입력)')), null);
  // Without it, or with the basis under the wrong option, or after a line in between: caught.
  const none = checkRecommendBasis(ask('1. 세지 않는다 (추천)', '2. 그대로 센다', '3. 기타 (직접 입력)'));
  assert.equal(none?.check, 'recommend-basis');
  assert.match(none?.reason ?? '', /G의 "1\. 세지 않는다 \(추천\)"[^]*바로 아래에 들여쓴 인용 줄 "> 근거:"[^]*확인 안 함\(짐작\)/);
  assert.equal(none?.rewrite, undefined, 'a labelled question is fixed by writing its block again');
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다', '2. 그대로 센다 (추천)', '3. 기타 (직접 입력)', '   근거: 기록 확인'))?.check, 'recommend-basis');
  assert.equal(checkRecommendBasis(ask('1. 세지 않는다 (추천)', '   시트가 많아요.', '   근거: 기록 확인', '2. 기타 (직접 입력)'))?.check, 'recommend-basis');
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

test('stop: a pick without its basis sends the answer back to write that question block again; the retry reads the block written again', () => {
  const store = testStore();
  const settings = roots(path.join(os.tmpdir(), 'results'));
  const first = ['되풀이 점검 기록을 봤어요.', '', '이미지 알림 11건이 있었어요.', '', 'G. 이미지 읽기를 어떻게 셀까요?', '1. 그대로 센다. 2~3주 지켜본다 (추천)', '2. 세지 않는다', '3. 기타 (직접 입력)', '', '남은 질문: G', '', '다음 행동 및 순서: G에 답해 주세요'].join('\n');
  const sent = stopGuard(store, { session_id: 'r1' }, { settings, turn: turnOf(first, { startUuid: 'q1' }) });
  assert.ok(sent.block?.startsWith(FILL_HEAD), String(sent.block));
  assert.match(sent.block ?? '', /근거 줄이 없다[^]*그 질문 블록\(질문 줄과 선택지 전체\)을 같은 질문 기호로 다시 적고/);
  const block = ['G. 이미지 읽기를 어떻게 셀까요?', '1. 세지 않는다 (추천)', '   근거: image-hits.md를 열어 보니 11건 중 8건이 모아보기 시트', '2. 그대로 센다', '3. 기타 (직접 입력)'].join('\n');
  const v = stopGuard(store, { session_id: 'r1', stop_hook_active: true }, { settings, turn: turnOf(block, { startUuid: 'q1' }) });
  assert.equal(v.block, undefined);
  assert.equal(v.filled, true);
  assert.deepEqual(v.findings, [], 'the block written again counts, not the first one');
  assert.deepEqual(v.caught?.map((c) => `${c.check}:${c.level}`), ['recommend-basis:block']);
  assert.equal(guardWarnNotice(store, 'r1'), '');
  // Its mistakes-record group is the one people already used for the slip.
  store.appendLog([{ session_id: 'r1', message_uuid: 'q1', role: 'user', content: '어떻게 할까?', created_at: new Date().toISOString() }]);
  assert.equal(recordGuardMistakes(store, 'r1', v), 1);
  assert.deepEqual(store.listMistakes().map((m) => [m.group_name, m.found_by]), [['근거 없는 추천', '장치']]);
  assert.match(store.listMistakes()[0].what, /^근거 없는 추천\(막음/);
  // Inside a subagent nothing is sent back; a pick under no labelled question has the answer written whole.
  assert.equal(stopGuard(store, { session_id: 'r2', agent_id: 'sub' }, { settings, turn: turnOf(first, { startUuid: 'q2' }) }).block, undefined);
  const unlabelled = first.replace('G. 이미지 읽기를 어떻게 셀까요?', '이미지 읽기는 이렇게 할 수 있어요.');
  assert.match(stopGuard(store, { session_id: 'r3' }, { settings, turn: turnOf(unlabelled, { startUuid: 'q3' }) }).block ?? '', /^\[답 검사\] 답을 끝내기 전에/);
});

test('stop hook end to end: lines added after an answer sent back are logged with it as one row (open questions and mistakes read it)', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const dir = tempDir();
  const db = path.join(dir, 'hook.db');
  const transcript = path.join(dir, 't.jsonl');
  const env = { ...process.env, SECRETARY_DB: db, SECRETARY_SEMANTIC_SEARCH: 'off' };
  const hook = (input: object) => execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'hook', 'stop'], { input: JSON.stringify(input), encoding: 'utf8', env });
  const first = '알림을 고쳤어요.\n\n이제 9시에 와요.\n\nC. 주말에도 보낼까요?\n1. 예 (추천)\n   근거: 확인 안 함(짐작)\n2. 기타 (직접 입력)';
  fs.writeFileSync(transcript, [userSays('u1', '알림 고쳐 줘'), says('a1', first)].join('\n') + '\n');
  const out = JSON.parse(hook({ session_id: 's1', transcript_path: transcript }));
  assert.equal(out.decision, 'block');
  assert.ok(String(out.reason).startsWith(FILL_HEAD));
  const added = '남은 질문: C\n\n다음 행동 및 순서: C에 답해 주세요.';
  fs.appendFileSync(transcript, [userSays('f1', `Stop hook feedback:\n${out.reason}`), says('a2', added)].join('\n') + '\n');
  assert.equal(hook({ session_id: 's1', transcript_path: transcript, stop_hook_active: true }), '');
  const store = testStore(db);
  assert.deepEqual(store.logAfter(0).map((e) => e.content), ['알림 고쳐 줘', `${first}\n\n${added}`], 'the hook\'s reason is not logged as the user\'s; the answer is one row');
  assert.deepEqual(openQuestionLines(store), ['- C. 주말에도 보낼까요? 1. 예 (추천) 근거: 확인 안 함(짐작) 2. 기타 (직접 입력)']);
  assert.deepEqual(store.listMistakes().map((m) => [m.group_name, m.log_ids]).sort(), [['next-action', '1,2'], ['open-questions', '1,2']]);
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
  assert.match(labelNotice(store, 's1'), /다음 질문 기호: AM/);
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
  // A carried question shown again in a new session's first answer ("A(옛 G, #4508). …?") is a question line.
  assert.deepEqual(usedLabels('A(옛 G, #4508). 알림 시각은요?\n1. 9시\n\n남은 질문: A, B'), ['A']);
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
  assert.match(writePlaceProblem(path.join(ai, 'whisperx-test', 'run.py'), ctx) ?? '', /바로 아래에는 새 폴더·파일을 만들지 않는다\(whisperx-test\)/);
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

test('worker-folder-guard: a work session command that makes a top-level folder or writes into temp is refused', { skip: !guardsOn() && 'feature mistake-guards is off here' }, () => {
  const ai = aiRootWith('workspaces', 'temp');
  const ws = path.join(ai, 'workspaces', 'space');
  fs.mkdirSync(ws, { recursive: true });
  const run = (command: string) => workerCheck('PowerShell', { command }, ws, { cwd: ws, aiRoot: ai });
  assert.match(run(`mkdir ${path.join(ai, '_sandbox')}`) ?? '', /바로 아래에는 새 폴더[^]*\[질문\]/);
  assert.match(run('Set-Content ..\\..\\temp\\x.txt 1') ?? '', /임시 작업 폴더/);
  assert.equal(run('mkdir output\\research\\x'), null);
  assert.equal(run(`Get-ChildItem ${path.join(ai, 'temp')}`), null);
  // Writes outside the workspace stay refused as before.
  assert.match(workerCheck('Write', { file_path: path.join(ai, 'temp', 'x') }, ws) ?? '', /공간 폴더 밖/);
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
    logIds: [4491],
    ruleRef: 'AGENTS.md 모든 것은 대화 글로',
    happenedAt: '2026-11-06T10:00:00Z',
  });
  assert.equal(a.recurred, 0);
  assert.equal(a.log_ids, '4491');
  const b = store.recordMistake({ what: '보고를 영어로 씀', group: '영어 답', madeBy: '비서', foundBy: '장치', cause: '안 지킴', logIds: [3146, 3161] });
  assert.equal(b.recurred, 1);
  assert.throws(() => store.recordMistake({ what: 'x', group: 'g', madeBy: '비서', foundBy: '사용자', cause: '안 지킴', happenedAt: 'not a date' }), /not a date/);
  assert.throws(() => store.recordMistake({ what: 'x', group: 'g', madeBy: '비서', foundBy: '누군가' as '사용자', cause: '안 지킴' }), /CHECK/);
  const filled = store.updateMistake(a.id, { guard: 'Stop 훅 english', evalIds: ['E1', 'E2'] })!;
  assert.equal(filled.guard, 'Stop 훅 english');
  assert.equal(filled.eval_ids, 'E1,E2');
  assert.match(formatMistake(filled), /^\[#1 2026-11-06 19:00\] \(영어 답\) 백그라운드 대기[^]*근거 #4491 · 규칙: AGENTS\.md[^]*장치: Stop 훅 english · 평가: E1,E2/);
  assert.deepEqual(store.mistakeGroups().map((g) => [g.group_name, g.n, g.recurred, g.guarded]), [['영어 답', 2, 1, 1]]);
  assert.deepEqual(store.listMistakes({ group: '영어 답' }).map((m) => m.id), [b.id, a.id]);
});
