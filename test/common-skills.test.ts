import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AGY_SKILLS_FILE, COMMON_SKILLS_FILE, commonSkillProblem, fixCommonSkills, readCommonSkills } from '../src/workspace/common-skills.ts';
import { linkProblem, writeLink } from '../src/workspace/secretary-link.ts';
import { tempDir } from './helpers.ts';

/** A workspaces folder with common skills a and b, and one workspace in it listing names. */
function setup(names: string[] | null) {
  const wsRoot = tempDir();
  const common = path.join(wsRoot, '_skills');
  for (const n of ['a', 'b']) {
    fs.mkdirSync(path.join(common, n), { recursive: true });
    fs.writeFileSync(path.join(common, n, 'SKILL.md'), `---\nname: ${n}\n---\n`);
  }
  const folder = path.join(wsRoot, 'space');
  fs.mkdirSync(folder);
  if (names) fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), JSON.stringify({ about: 'x', skills: names }));
  return { wsRoot, common, folder };
}

const linked = (folder: string, rel: string) => fs.lstatSync(path.join(folder, ...rel.split('/'))).isSymbolicLink();
const agy = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, ...AGY_SKILLS_FILE.split('/')), 'utf8'));

test('a folder without a list needs nothing', () => {
  const { common, folder } = setup(null);
  assert.equal(readCommonSkills(folder), null);
  assert.equal(commonSkillProblem(folder, common), null);
  assert.equal(fixCommonSkills(folder, common), false);
  assert.ok(!fs.existsSync(path.join(folder, '.agents')));
});

test('listed common skills: a common-<name> link in .agents/skills, and .agents/skills.json for Antigravity with an absolute path (per PC, out of git)', () => {
  const { common, folder } = setup(['a']);
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /공통 스킬 연결 없음·틀림: \.agents\/skills\/common-a/);
  assert.match(p, /\.agents\/skills\.json이 목록과 다름/);
  assert.equal(fixCommonSkills(folder, common), true);
  assert.equal(commonSkillProblem(folder, common), null);
  assert.ok(linked(folder, '.agents/skills/common-a'));
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'common-a', 'SKILL.md')), 'the link reaches the skill');
  assert.ok(!fs.existsSync(path.join(folder, '.claude')), '.claude/skills is the layout fix’s (setup/skill-links.ts)');
  assert.deepEqual(agy(folder), { entries: [{ path: common.split(path.sep).join('/'), include_only: ['a'] }] });
  assert.equal(fixCommonSkills(folder, common), false, 'nothing to do the second time');
});

test('a name dropped from the list loses its link and its place in skills.json; other entries and the folder’s own skills stay', () => {
  const { common, folder } = setup(['a', 'b']);
  fixCommonSkills(folder, common);
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'own'), { recursive: true });
  const file = path.join(folder, ...AGY_SKILLS_FILE.split('/'));
  const hand = { path: 'C:/elsewhere', include_only: ['x'] };
  fs.writeFileSync(file, JSON.stringify({ entries: [hand, ...agy(folder).entries] }));
  fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), JSON.stringify({ skills: ['a'] }));
  assert.match(commonSkillProblem(folder, common)!, /목록에 없는 공통 스킬 연결: \.agents\/skills\/common-b/);
  fixCommonSkills(folder, common);
  assert.ok(!fs.existsSync(path.join(folder, '.agents', 'skills', 'common-b')));
  assert.ok(fs.existsSync(path.join(common, 'b', 'SKILL.md')), 'only the link went');
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'own')));
  assert.deepEqual(agy(folder), { entries: [hand, { path: common.split(path.sep).join('/'), include_only: ['a'] }] });
  assert.equal(commonSkillProblem(folder, common), null);
  // An empty list: our entry goes, the hand-made one stays; with none left the file goes.
  fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), JSON.stringify({ skills: [] }));
  fixCommonSkills(folder, common);
  assert.deepEqual(agy(folder), { entries: [hand] });
  fs.writeFileSync(file, JSON.stringify({ entries: [{ path: '../_skills', include_only: ['a'] }] }));
  fixCommonSkills(folder, common);
  assert.ok(!fs.existsSync(file));
});

test('a hand-made link to a common skill under another name is taken onto the list', () => {
  const { common, folder } = setup(null);
  fs.mkdirSync(path.join(folder, '.agents', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(common, 'b'), path.join(folder, '.agents', 'skills', 'b'), 'junction');
  assert.match(commonSkillProblem(folder, common)!, /목록에 넣을 공통 스킬 연결: \.agents\/skills\/b/);
  fixCommonSkills(folder, common);
  assert.deepEqual(readCommonSkills(folder), ['b']);
  assert.ok(!fs.existsSync(path.join(folder, '.agents', 'skills', 'b')));
  assert.ok(linked(folder, '.agents/skills/common-b'));
  assert.equal(commonSkillProblem(folder, common), null);
});

test('an unknown name and a real folder in the way are reported, not made up or removed', () => {
  const { common, folder } = setup(['a', 'zzz']);
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'common-a'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.agents', 'skills', 'common-a', 'x.md'), 'mine');
  fixCommonSkills(folder, common);
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /공통 스킬 없음: zzz/);
  assert.match(p, /연결 대신 실제 폴더\(지우지 않음\): \.agents\/skills\/common-a/);
  assert.equal(fs.readFileSync(path.join(folder, '.agents', 'skills', 'common-a', 'x.md'), 'utf8'), 'mine');
  fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), '{oops');
  assert.equal(readCommonSkills(folder), 'bad');
  assert.match(commonSkillProblem(folder, common)!, /못 읽음/);
});

test('an own skill named like a listed common skill is reported (Antigravity shows one), and left', () => {
  const { common, folder } = setup(['a']);
  fixCommonSkills(folder, common);
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'b'), { recursive: true });
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /공통 스킬과 이름이 같은 공간 스킬.*: \.agents\/skills\/a$/);
  assert.equal(fixCommonSkills(folder, common), false);
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'a')));
});

test('secretary.json writing also puts the skill layout and the common skills right (install check item workspace-links)', () => {
  const { wsRoot, folder } = setup(['b']);
  // The old workspace layout: skills/ and the old charter sentence.
  fs.mkdirSync(path.join(folder, 'skills', 'own'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'skills', 'own', 'SKILL.md'), '# own');
  // The old workspace charter: the skill path, and the empty skill list (one with skills is left to the secretary).
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), '- 시작하기 전에 아래 "스킬과 기억"의 목록에 맞는 스킬이 있으면 먼저 읽는다.\n이 공간에서 배운 것은 업무 종류별 스킬(`skills/<이름>/SKILL.md`, 깊은 내용은)\n\n스킬 목록(새 스킬이 생기면 비서가 이름과 한 줄 설명을 더한다):\n\n- 아직 없음\n\n## 일하는 방식\n');
  const root = tempDir();
  const old = process.env.SECRETARY_WORKSPACE_ROOT;
  process.env.SECRETARY_WORKSPACE_ROOT = wsRoot;
  try {
    assert.equal(writeLink(folder, root), true);
    assert.equal(linkProblem(folder, root), null);
    assert.ok(linked(folder, '.agents/skills/common-b'));
    assert.ok(linked(folder, '.claude/skills'));
    assert.equal(fs.readFileSync(path.join(folder, '.claude', 'skills', 'own', 'SKILL.md'), 'utf8'), '# own');
    assert.equal(
      fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'),
      '- 시작하기 전에 맞는 스킬(`.agents/skills/`, 공통 스킬은 `common-<이름>`)이 있으면 먼저 읽는다.\n이 공간에서 배운 것은 업무 종류별 스킬(`.agents/skills/<이름>/SKILL.md`, 깊은 내용은)\n\n## 일하는 방식\n',
    );
    const at = path.join(folder, '.agents', 'skills', 'common-b');
    try {
      fs.unlinkSync(at);
    } catch {
      fs.rmdirSync(at);
    }
    assert.match(linkProblem(folder, root)!, /\.agents\/skills\/common-b/);
    assert.equal(writeLink(folder, root), true, 'a missing link alone is fixed');
    assert.equal(linkProblem(folder, root), null);
  } finally {
    if (old === undefined) delete process.env.SECRETARY_WORKSPACE_ROOT;
    else process.env.SECRETARY_WORKSPACE_ROOT = old;
  }
});
