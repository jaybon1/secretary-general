import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { planFromProfile, planProblems, type MovePlan } from '../src/upgrade/big-work-move.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir, testStore } from './helpers.ts';
// @ts-expect-error plain .mjs script without types
import { compareVersions } from '../scripts/update.mjs';

// A v7 profile: the big works were a section of it (consolidate kept '큰 일 상태' there).
const PROFILE = [
  '# 민지님',
  '- 프리랜서 디자이너, 한국어로 짧게 답하는 것을 좋아한다.',
  '',
  '## 큰 일 상태',
  '- 진행 중: 카페 소개 페이지 (시안 2차), 비서 기억 정리',
  '- 사용자 차례: 이사 계약 (집주인 답 확인)',
  '- 보류: 블로그 시작 (주제 정하면 다시)',
  '- 운영 중: 없음',
  '',
  '## 운영 원칙',
  '- 비싼 작업은 run-job으로 넘긴다.',
].join('\n');

test('big-work move: a grouped section becomes one plan row per work, the profile keeps the rest', () => {
  const plan = planFromProfile(PROFILE, 40);
  assert.deepEqual(plan.section[0], '## 큰 일 상태');
  assert.deepEqual(
    plan.rows.map((r) => [r.name, r.state, r.note]),
    [
      ['카페 소개 페이지', '진행 중', '시안 2차'],
      ['비서 기억 정리', '진행 중', ''],
      ['이사 계약', '사용자 차례', '집주인 답 확인'],
      ['블로그 시작', '보류', '주제 정하면 다시'],
    ],
  );
  assert.deepEqual(planProblems(plan), [], '"운영 중: 없음" adds no row');
  assert.equal(plan.newProfile, '# 민지님\n- 프리랜서 디자이너, 한국어로 짧게 답하는 것을 좋아한다.\n\n## 운영 원칙\n- 비싼 작업은 run-job으로 넘긴다.');

  const perLine = planFromProfile('**큰 일 상태:**\n- 블로그·인스타 자동화 — 진행 중 (2차 시험)\n- 새 아이디어 정리\n\n그 밖의 말', 3);
  assert.deepEqual(perLine.rows.map((r) => [r.name, r.state, r.note]), [['블로그·인스타 자동화', '진행 중', '2차 시험'], ['새 아이디어 정리', '?', '']]);
  assert.match(planProblems(perLine).join('\n'), /상태를 정해야 함.*새 아이디어 정리/);
  assert.equal(perLine.newProfile, '그 밖의 말');
  assert.throws(() => planFromProfile('# 민지님\n- 디자이너', 1), /찾지 못했어요/);
});

test('big-work move over the CLI: preview writes a plan without touching data, --apply fills the board once', () => {
  const dir = tempDir();
  const db = path.join(dir, 'move.db');
  const before = testStore(db);
  before.updateProfile(PROFILE, 'init');
  before.db.close();
  const planFile = path.join(dir, 'plan.json');
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'big-work-from-profile', planFile, ...args], {
      env: { ...process.env, SECRETARY_DB: db, SECRETARY_EMBED: 'off', SECRETARY_SETUP_CHECK: 'off' },
      encoding: 'utf8',
    });
  assert.match(cli(), /프로필 v1의 큰 일 칸 5줄 → 판 4줄[\s\S]*고칠 것 없음/);
  const s = testStore(db);
  assert.equal(s.getProfile()?.version, 1, 'preview changes nothing');
  assert.deepEqual(s.bigWork(), []);

  // The secretary checks each line here; a fix is an edit of the JSON.
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as MovePlan;
  plan.rows[1].note = '분류 중';
  fs.writeFileSync(planFile, JSON.stringify(plan));
  assert.match(cli('--apply'), /큰 일 판 4줄 넣음, 프로필 v2 저장/);
  const after = testStore(db);
  assert.deepEqual(after.bigWork().map((r) => [r.name, r.note]).slice(0, 2), [['카페 소개 페이지', '시안 2차'], ['비서 기억 정리', '분류 중']]);
  assert.equal(after.bigWork().length, 4);
  assert.doesNotMatch(after.getProfile()?.content ?? '', /큰 일/);
  assert.throws(() => cli('--apply'), /v1에서 만들었는데 지금은 v2/);
});

test('every file a v7 copy has but v8 does not is followed by the moves file, except the ones v8 left out', () => {
  // v7's tracked files outside what v8 keeps in place (tools/, the top files and test/ stay). v7's skills were real
  // folders in .claude/skills/; v8 keeps them in .agents/skills/ (.claude/skills is one link an install makes).
  const v7Moved = [
    '.claude/skills/consolidate/SKILL.md', '.claude/skills/delegate/SKILL.md', '.claude/skills/grill/SKILL.md', '.claude/skills/handoff/SKILL.md', '.claude/skills/update/SKILL.md',
    'scripts/backup-db.ps1', 'scripts/claude-env.ps1', 'scripts/ego-grab.mjs', 'scripts/install-autostart.ps1',
    'scripts/install-usage-guard.mjs', 'scripts/notify.ps1', 'scripts/open-chrome.ps1', 'scripts/providers.json', 'scripts/providers.ps1',
    'scripts/remote-server.ps1', 'scripts/run-job-stats.ps1', 'scripts/run-job.ps1', 'scripts/server-control.ps1',
    'scripts/start-worker.ps1', 'scripts/trust-folder.mjs', 'scripts/usage-file.mjs', 'scripts/usage-guard.mjs', 'scripts/usage-statusline.mjs',
    'scripts/usage.ps1', 'scripts/watch-embedder.mjs', 'scripts/watch-worker.ps1', 'scripts/worker-done.ps1', 'scripts/worker-guard.mjs',
    'scripts/worker-logs.ps1', 'src/board.ts', 'src/config.ts', 'src/context-size.ts', 'src/context.ts', 'src/continuity.ts', 'src/db.ts',
    'src/ingest.ts', 'src/mcp-server.ts', 'src/prev-answer.ts', 'src/recall.ts', 'src/semantic.ts', 'src/setup.ts', 'src/store.ts',
    'src/text.ts', 'src/threats.ts', 'src/usage.ts', 'src/workspace.ts',
  ];
  const all = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'update-moves.json'), 'utf8')) as Record<string, Record<string, string>>;
  const moves = all.v8;
  assert.deepEqual(Object.keys(moves).sort(), [...v7Moved].sort());
  // v8에서 뺀 기능(작업 공간 zip 묶기)의 v7 파일 두 개는 옮김에 적지 않는다: 적으면 새 자리가 v8에 없는데도 업데이트가 옛 파일을
  // 새 자리로 옮겨 뺀 기능이 되살아난다(classifyMoved). 옮김에 없으면 안 고친 것은 지우고 고친 것만 지울지 묻는다(classify).
  // 아래 "새 자리가 있어야 한다" 확인이 그 실수를 잡는다.
  // 없으면 놓치는 실수: 이 배포판 VERSION보다 뒤 버전 칸(예: v0.9.0인데 v0.10.0 칸)에 적은 옮김은 받은 저장소에 그 tag가 없어 쓰이지 않아, 올릴 때 사용자가 고친 파일이 '지울지 물을 것'이 된다.
  // 칸 이름은 tag 그대로: v8까지는 숫자 하나(0.N.0으로 읽음), 그 뒤는 v0.X.Y(scripts/update.mjs parseVersion).
  const version = fs.readFileSync(path.join(PROJECT_ROOT, 'VERSION'), 'utf8').trim();
  assert.match(version, /^v\d+\.\d+\.\d+$/, 'VERSION은 v0.X.Y 꼴(새 tag 이름과 같게)');
  for (const k of Object.keys(all).filter((x) => x !== 'about')) assert.ok((/^v\d+$/.test(k) || /^v\d+\.\d+\.\d+$/.test(k)) && compareVersions(k, version) <= 0, `update-moves.json의 ${k} 칸이 이 배포판(${version})보다 뒤이거나 tag 이름 꼴이 아님`);
  assert.ok(Object.entries(moves).filter(([from]) => from.startsWith('.claude/skills/')).every(([from, to]) => to === `.agents/skills/${from.slice('.claude/skills/'.length)}`));
  const real = (p: string) => fs.realpathSync(p).toLowerCase();
  for (const [from, to] of Object.entries(moves)) {
    // Gone, or (a skill once the link is made) the new file itself seen through a link.
    const old = path.join(PROJECT_ROOT, from);
    assert.ok(!fs.existsSync(old) || real(old) === real(path.join(PROJECT_ROOT, to)), `${from} should be gone now`);
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, to)), `${from} → ${to} missing`);
  }
});
