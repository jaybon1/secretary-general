import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, testStore, write } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { entryPath } from '../src/core/paths.ts';
import { briefCoverage, decisionBody, decisionsFor, leftoverFolders, main, pathsIn, reportCheck } from '../scripts/delegate-check/delegate-check.ts';

test('brief: the decisions of the given tags (and a query), the ones the brief leaves out first', () => {
  const file = path.join(tempDir(), 'd.db');
  const store = testStore(file);
  const tts = store.remember({ kind: 'decision', content: '2026-11-01 사용자 결정(더빙): 더빙 목소리는 Speechify-K2로 만들고 속도는 1.1배로 한다.', tags: ['영상', '더빙'] }).id;
  const sub = store.remember({ kind: 'decision', content: '자막은 화면 아래 두 줄까지만 쓴다.', tags: ['영상', '자막'] }).id;
  store.remember({ kind: 'fact', content: '더빙 업무는 영상 공간에서 한다.', tags: ['영상', '더빙'] });
  const old = store.remember({ kind: 'decision', content: '더빙은 옛 방식으로 한다.', tags: ['영상', '더빙'] }).id;
  store.forget(old, 'x');
  store.remember({ kind: 'decision', content: '블로그는 주 2회 올린다.', tags: ['블로그'] });
  const ds = decisionsFor(store.db, ['더빙']);
  assert.deepEqual(ds.map((d) => d.id), [tts], 'decisions only, active only, by tag');
  assert.deepEqual(decisionsFor(store.db, ['영상']).map((d) => d.id), [tts, sub]);
  assert.deepEqual(decisionsFor(store.db, [], '자막 줄').map((d) => d.id), [sub], 'a query finds one without the tag');
  assert.equal(decisionBody('2026-11-01 사용자 결정(더빙): 더빙 목소리'), '더빙 목소리');
  // A brief that leaves the voice out: shown first, with the name it lacks.
  const left = briefCoverage('# 더빙\n해외 반응 영상의 더빙을 만든다. 자막은 화면 아래 두 줄까지만.', decisionsFor(store.db, ['영상']));
  assert.equal(left[0].decision.id, tts);
  assert.ok(left[0].covered < 0.5, String(left[0].covered));
  assert.deepEqual(left[0].missingNames, ['Speechify-K2']);
  assert.ok(left[1].covered >= 0.5);
  // One that carries it.
  const full = briefCoverage('더빙 목소리는 Speechify-K2로 만들고 속도는 1.1배로 한다.', ds);
  assert.ok(full[0].covered >= 0.8 && full[0].missingNames.length === 0);
  store.db.close();
  // The command line: exit 1 while something is left out, the DB only read.
  const brief = path.join(tempDir(), 'TASK.md');
  write(brief, '# 더빙\n더빙을 만든다.');
  const out: string[] = [];
  assert.equal(main(['brief', brief, '--tag', '더빙', '--db', file], (s) => out.push(s)), 1);
  assert.match(out.join('\n'), /지시서에 안 들어간 듯 1개[^]*\[빠진 듯 \d+%\] #1 [^]*지시서에 없는 이름·숫자: Speechify-K2/);
  assert.equal(main(['brief', brief, '--db', file], () => {}), 2, 'no tag, no query');
  assert.equal(main(['brief', brief, '--tag', 'x', '--db', path.join(tempDir(), 'none.db')], () => {}), 2);
});

test('report: a "deleted" claim against what is there, paths that are not, leftover test folders, strange entries on top', () => {
  const top = tempDir('dc-top-');
  for (const d of ['workspaces', 'notes', 'secretary-1', 'stray-test']) fs.mkdirSync(path.join(top, d));
  const out = path.join(top, 'workspaces', 'space', 'output', 'research', '20261107-run');
  fs.mkdirSync(path.join(out, 'trial-2'), { recursive: true });
  fs.mkdirSync(path.join(out, 'final'), { recursive: true });
  write(path.join(out, 'REPORT.md'), '');
  const report = [
    '# 보고',
    '시험 폴더는 모두 지웠습니다(`trial-1`, `trial-2`).',
    '`final/` 안에 결과가 있다.',
    '임시 서버도 정리했어요.',
    '결과:',
    '```',
    path.join(out, 'REPORT.md'),
    path.join(out, 'missing.md'),
    '```',
  ].join('\n');
  const r = reportCheck(report, { reportFile: path.join(out, 'REPORT.md'), roots: [out], top, hours: 24 });
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(r.findings.some((f) => f.kind === 'still-there' && f.text.endsWith(path.join(out, 'trial-2'))), r.text);
  assert.ok(!r.findings.some((f) => f.text.endsWith('trial-1')), 'a deleted one that is gone is fine');
  assert.ok(r.findings.some((f) => f.kind === 'missing-path' && f.text.endsWith('missing.md')));
  assert.ok(!r.findings.some((f) => f.kind === 'missing-path' && f.text.endsWith('REPORT.md')));
  assert.ok(r.findings.some((f) => f.kind === 'leftover' && f.text.endsWith('trial-2')));
  assert.deepEqual(r.findings.filter((f) => f.kind === 'top-unknown').map((f) => path.basename(f.text)), ['stray-test']);
  assert.ok(kinds.length >= 4);
  assert.match(r.text, /"지웠다·없다" 류 주장 2줄/);
  assert.match(r.text, /최근 24시간에 바뀐 항목 /);
  assert.deepEqual(pathsIn('`a\\b.txt`와 C:\\x\\y 그리고 `npm test -- --x`'), ['a\\b.txt', 'C:\\x\\y']);
  assert.deepEqual(leftoverFolders(out).map((p) => path.basename(p)), ['trial-2']);
  // Nothing wrong: exit 0.
  const clean = path.join(tempDir(), 'R.md');
  write(clean, '다 만들었어요.');
  assert.equal(main(['report', clean, '--top', tempDir()], () => {}), 0);
  assert.equal(main(['report', path.join(out, 'REPORT.md'), '--root', out, '--top', top], () => {}), 1, 'an empty report claims nothing, but the leftover folder is told');
});

test('bin/delegate-check.mjs runs the script (usage on a wrong call)', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', entryPath('delegate-check.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^사용:\n {2}node bin\/delegate-check\.mjs brief/);
  const help = execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'scripts', 'delegate-check', 'delegate-check.ts'), 'report', path.join(PROJECT_ROOT, 'package.json'), '--top', tempDir()], { encoding: 'utf8' });
  assert.match(help, /^보고 대조: /);
});
