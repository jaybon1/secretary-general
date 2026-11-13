import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, testStore, write, writeFiles } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { entryPath } from '../src/core/paths.ts';
import { ASSUMED_REPORT, renderCharter, renderTaskBrief } from '../src/workspace/rules-text.ts';
import { briefPartsReport, emptyBriefParts, briefCoverage, briefReport, decisionBody, decisionsFor, findSpaceRoot, leftoverFolders, main, otherMemories, pathsIn, rankCoverage, reportCheck, skillRulesFor, spaceSkillFiles, withoutFolders } from '../scripts/delegate-check/delegate-check.ts';

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
  write(brief, '# 더빙\n더빙 목소리를 만든다.');
  const out: string[] = [];
  assert.equal(main(['brief', brief, '--tag', '더빙', '--db', file], (s) => out.push(s)), 1);
  assert.match(out.join('\n'), /지시서에 안 들어간 듯 1개[^]*\[빠진 듯 \d+% · 관련 [\d.]+\] #1 [^]*겹친 말: [^]*지시서에 없는 이름·숫자: Speechify-K2/);
  assert.equal(main(['brief', brief, '--db', file], () => {}), 2, 'no tag, no query');
  assert.equal(main(['brief', brief, '--tag', 'x', '--db', path.join(tempDir(), 'none.db')], () => {}), 2);
});

// 없으면 놓치는 실수: 공간 태그에 걸린 결정을 모두 "빠진 듯"으로 내면 효과음·소재 고르기처럼 이 일과 상관없는 결정이 위를 채워, 정작 백업 방식 결정이 묻힌다(2026-11-08 영상 채널 백업 업무, 68개 중 57개).
test('brief: left-out decisions ranked by the words they share with the brief, only the top few, unrelated ones no finding', () => {
  const file = path.join(tempDir(), 'd.db');
  const store = testStore(file);
  const noise = [
    '효과음은 전환에 Simple Whoosh, 등장에 Bubble Pop을 쓰고 미리보기에서 켜고 끌 수 있게 한다.',
    '소재는 한 회차에 생활 속 궁금증과 낯선 제도를 각 5개씩 출처 자료에 근거해 낸다.',
    '첫 15초 훅은 결론 먼저로 하고 롱폼 길이는 고정하지 않는다.',
    '기본 화면 스타일은 어두운 바탕에 외곽선 두른 큰 글자와 아래 자막 띠다.',
  ].map((c) => store.remember({ kind: 'decision', content: `2026-11-03 사용자 결정(채널): ${c}`, tags: ['채널'] }).id);
  const backup = store.remember({ kind: 'decision', content: '2026-10-28 사용자 결정(백업): 백업은 공개된 편을 yt-dlp로 유튜브가 최적화한 공개본으로 받아 백업 폴더에 넣는다.', tags: ['채널', '백업'] }).id;
  const when = store.remember({ kind: 'decision', content: '2026-11-08 사용자 결정(백업): 백업 시점은 다음 영상을 올릴 때 이전 편이 공개됐는지 확인하고 공개된 편만 한다.', tags: ['채널', '백업'] }).id;
  store.remember({ kind: 'fact', content: '효과음 모음은 공용 폴더에 있다. 효과음 이름은 영어다.', tags: ['소리'] });
  const brief = '# 백업 방식 바로잡기\n공개된 영상의 백업을 렌더본이 아니라 유튜브 공개본으로 바꾼다.\n1. 네 영상을 유튜브에서 가장 좋은 화질로 받아 각 편 최종 폴더에 넣는다.';
  const decisions = decisionsFor(store.db, ['채널']);
  const ranked = rankCoverage(brief, briefCoverage(brief, decisions), otherMemories(store.db, decisions));
  assert.deepEqual(ranked.slice(0, 2).map((c) => c.decision.id).sort(), [backup, when].sort(), JSON.stringify(ranked.map((c) => [c.decision.id, c.relevance])));
  assert.ok(ranked.find((c) => c.decision.id === backup)!.shared.includes('백업'));
  assert.ok(noise.every((id) => ranked.find((c) => c.decision.id === id)!.relevance === 0), 'a decision sharing nothing telling scores 0');
  // Only the top N left-out ones are listed; the rest are counted. Those sharing nothing are no finding.
  const r = briefReport('TASK.md', ranked, ['채널'], 1);
  assert.equal(r.leftOut, ranked.filter((c) => c.covered < 0.5 && c.relevance > 0).length);
  assert.ok(r.leftOut >= 1 && r.leftOut <= 2, r.text);
  assert.equal((r.text.match(/\[빠진 듯/g) ?? []).length, 1, r.text);
  assert.match(r.text, /관련 높은 위 1개\(최대 1, --memories로 바꿈\)[^]*안 보인 빠진 듯한 결정 \d+개[^]*--memories \d+/);
  assert.doesNotMatch(r.text.split('안 보인')[0], /효과음|소재는|훅은|스타일은/);
  store.db.close();
  // The command line: --memories sets how many; a brief sharing nothing with any decision exits 0.
  const task = path.join(tempDir(), 'TASK.md');
  write(task, brief);
  const out: string[] = [];
  assert.equal(main(['brief', task, '--tag', '채널', '--db', file, '--memories', '5'], (s) => out.push(s)), 1);
  assert.match(out.join('\n'), /최대 5, --memories/);
  const other = path.join(tempDir(), 'TASK.md');
  write(other, '# 블로그 글\n주간 소식 글을 쓴다.\n의도: 독자에게 소식 전하기\n범위 밖: 없음\n사용자 원문: "써 줘" (#1)');
  assert.equal(main(['brief', other, '--tag', '채널', '--db', file], () => {}), 0, 'left-out decisions unrelated to the brief are not findings');
});

// 없으면 놓치는 실수: 지시서가 그 공간 스킬 규칙과 어긋나도(스킬은 "공개가 끝난 뒤 backup.py로 백업", 지시서는 "올린 뒤 바로 백업") 기억만 대조해 놓친다(2026-11-08 영상 채널 공간).
test('brief: the space skill rules sharing words with the brief, the backup rule first, common skills too', () => {
  const root = tempDir('dc-space-');
  const space = path.join(root, 'workspaces', 'cafe-1');
  writeFiles(space, {
    'AGENTS.md': '# 공간',
    'common-skills.json': JSON.stringify({ skills: ['youtube-ops'] }),
    '.agents/skills/channel-ops/SKILL.md': [
      '---',
      'name: channel-ops',
      'description: 채널 업로드와 백업을 한다.',
      '---',
      '# 채널 프로그램',
      '1. 로그인이 필요하면 [질문]으로 멈춘다.',
      '3. 채널 공개 상태는 `channel_info.py`로 본다.',
      '10. 공개가 끝난 영상은 `backup.py`로 에셋을 NAS `...\\<YYMMDD-N 제목>\\에셋\\`에 백업한다.',
      '   이유: NAS 백업을 업로드 직후에 하면 공개 전에 고친 파일이 빠진다.',
      '```',
      'python backup.py push --dry-run',
      '```',
    ].join('\n'),
    '.agents/skills/voice/SKILL.md': '# 목소리\n- 새 목소리 견본은 목소리 모음에 넣는다.',
  });
  // The list says youtube-ops (old form, no common- prefix); the skill is in its common- folder.
  writeFiles(path.join(root, 'workspaces', '_skills'), { 'common-youtube-ops/SKILL.md': '# 유튜브\n- 업로드는 비공개로 하고 영어 자막을 함께 올린다.\n- 쇼츠 관련 동영상은 사람이 지정한다.' });
  const task = path.join(space, 'output', 'records', 'ep02-upload', 'TASK.md');
  write(task, '# 2편 업로드\n1단계: 영상을 비공개로 업로드하고 영어 자막을 올린다.\n2단계: 올린 뒤 바로 렌더본으로 NAS에 백업한다(backup.py).');
  assert.equal(findSpaceRoot(task), space);
  assert.equal(findSpaceRoot(path.join(root, 'x.md')), null);
  const files = spaceSkillFiles(space);
  assert.deepEqual(files.map((f) => f.skill), ['공통 youtube-ops', 'channel-ops', 'voice']);
  const rules = skillRulesFor(fs.readFileSync(task, 'utf8'), files);
  const backup = rules.find((r) => /공개가 끝난 영상은 `backup\.py`/.test(r.text));
  assert.ok(backup && rules.indexOf(backup) <= 1, JSON.stringify(rules, null, 1));
  assert.ok(backup.shared.includes('백업') && backup.shared.includes('backup') && !backup.shared.includes('py'));
  assert.ok(rules.some((r) => r.skill === '공통 youtube-ops' && /비공개/.test(r.text)), 'a common skill rule');
  assert.ok(!rules.some((r) => /^이유|python backup|^name|목소리/.test(r.text)), 'no why lines, code, front matter or unrelated rules');
  assert.equal(skillRulesFor(fs.readFileSync(task, 'utf8'), files, 1).length, 1);
  assert.equal(withoutFolders('본보기 `output/records/a-b/check.py` 참고'), '본보기 `check` 참고');
  // The command line shows the rules after the memories, as many as --rules says.
  const db = path.join(tempDir(), 'd.db');
  testStore(db).db.close();
  const out: string[] = [];
  fs.appendFileSync(task, '\n의도: 독자에게 소식 전하기\n범위 밖: 없음\n사용자 원문: "써 줘" (#1)\n');
  assert.equal(main(['brief', task, '--tag', '영상', '--db', db, '--rules', '2'], (s) => out.push(s)), 0);
  assert.match(out.join('\n'), /공간 스킬 규칙\(지시서와 맞는지 확인\): .*cafe-1의 스킬 3개에서 지시서와 단어가 겹치는 줄 위 2개[^]*\[channel-ops channel-ops\/SKILL\.md:8\] 10\. 공개가 끝난/);
  const lone = path.join(tempDir(), 'TASK.md');
  write(lone, '백업한다');
  const out2: string[] = [];
  main(['brief', lone, '--tag', 'x', '--db', db], (s) => out2.push(s));
  assert.match(out2.join('\n'), /공간 스킬 규칙: .*못 찾음/);
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

// 없으면 놓치는 실수: 지시서에 사용자가 왜 이 일을 하려는지(의도), 하지 않을 것, 사용자 말 그대로가 빠져, 받는 쪽이 바꿔 쓴 지시대로 엉뚱한 결과를 가져온다(2026-11-13 사용자 결정, 의도 조사 사례 C).
test('brief: TASK.md has intent, out of scope and the user\'s words (empty ones say so), and delegate-check tells which are empty; reports ask what was settled without asking', () => {
  const task = { name: 'a', title: 'T', goal: 'g', doneCriteria: ['x'], proof: ['y'] };
  assert.deepEqual(emptyBriefParts(renderTaskBrief(task)), ['의도', '범위 밖', '사용자 원문']);
  const full = renderTaskBrief({ ...task, intent: '다음 주 회의에서 고를 자료', outOfScope: ['push 하지 않음'], userWords: '"비교해 줘" (#900543)' });
  assert.deepEqual(emptyBriefParts(full), []);
  assert.match(full, /## 의도\n\n다음 주 회의에서 고를 자료[^]*## 범위 밖 \(하지 않는 것\)\n\n- push 하지 않음[^]*## 사용자 원문\n\n"비교해 줘" \(#900543\)/);
  // A run-job's or subagent's instruction: "의도: …" lines or headings with their words below.
  assert.deepEqual(emptyBriefParts('일: 조사\n의도: 사러 가기 전 비교\n범위 밖: 구매\n사용자 원문: "알아봐 줘"'), []);
  assert.deepEqual(emptyBriefParts('일: 조사\n## 의도\n\n## 범위 밖 (하지 않는 것)\n- 구매'), ['의도', '사용자 원문']);
  assert.match(briefPartsReport('일: 조사').text, /지시서 칸 빠짐: 의도, 범위 밖, 사용자 원문/);
  // The end-of-task report asks for what the worker settled without asking.
  assert.match(ASSUMED_REPORT, /묻지 않고 대신 정한 것·가정/);
  assert.ok(renderCharter({ kind: "solo", name: "w", title: "W", purpose: "p" } as never).includes(ASSUMED_REPORT));
});
