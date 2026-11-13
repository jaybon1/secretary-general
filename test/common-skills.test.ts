import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AGY_SKILLS_FILE, COMMON_SKILLS_ABOUT, COMMON_SKILLS_FILE, commonSkillProblem, fixCommonSkills, OLD_COMMON_SKILLS_ABOUTS, readCommonSkills } from '../src/workspace/common-skills.ts';
import { linkProblem, writeLink } from '../src/workspace/secretary-link.ts';
import { tempDir } from './helpers.ts';

/** A workspaces folder with common skills common-a and common-b (folder name = skill name), and one workspace in it listing names. */
function setup(names: string[] | null, folders = ['common-a', 'common-b']) {
  const wsRoot = tempDir();
  const common = path.join(wsRoot, '_skills');
  for (const n of folders) {
    fs.mkdirSync(path.join(common, n), { recursive: true });
    fs.writeFileSync(path.join(common, n, 'SKILL.md'), `---\nname: ${n}\ndescription: d\n---\n`);
  }
  const folder = path.join(wsRoot, 'space');
  fs.mkdirSync(folder);
  if (names) fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), JSON.stringify({ about: 'x', skills: names }));
  return { wsRoot, common, folder };
}

const linked = (folder: string, rel: string) => fs.lstatSync(path.join(folder, ...rel.split('/'))).isSymbolicLink();
const agy = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, ...AGY_SKILLS_FILE.split('/')), 'utf8'));
const listOf = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, COMMON_SKILLS_FILE), 'utf8')).skills;

test('a folder without a list needs nothing', () => {
  const { common, folder } = setup(null);
  assert.equal(readCommonSkills(folder), null);
  assert.equal(commonSkillProblem(folder, common), null);
  assert.equal(fixCommonSkills(folder, common), false);
  assert.ok(!fs.existsSync(path.join(folder, '.agents')));
});

test('listed common skills: a link of the same name in .agents/skills, and .agents/skills.json for Antigravity with an absolute path (per PC, out of git)', () => {
  const { common, folder } = setup(['common-a']);
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /공통 스킬 링크 없음·틀림: \.agents\/skills\/common-a/);
  assert.match(p, /\.agents\/skills\.json이 목록과 다름/);
  assert.equal(fixCommonSkills(folder, common), true);
  assert.equal(commonSkillProblem(folder, common), null);
  assert.ok(linked(folder, '.agents/skills/common-a'));
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'common-a', 'SKILL.md')), 'the link reaches the skill');
  assert.ok(!fs.existsSync(path.join(folder, '.claude')), '.claude/skills is the layout fix’s (setup/skill-links.ts)');
  assert.deepEqual(agy(folder), { entries: [{ path: common.split(path.sep).join('/'), include_only: ['common-a'] }] });
  assert.equal(fixCommonSkills(folder, common), false, 'nothing to do the second time');
});

// 없으면 놓치는 실수: 공통 스킬 이름에 common-을 붙인 뒤(2026-11-09) 옛 목록("web-tools")과 옛 폴더(_skills/web-tools)·옛 링크가 남은 공간·배포판 사용자는 공통 스킬을 못 읽는다.
test('the old form moves over: a list without the prefix is written again with it, an old folder is moved and its name set, an old link is made again', () => {
  const { common, folder } = setup(['a', 'common-b'], ['a', 'common-b']);
  fs.mkdirSync(path.join(folder, '.agents', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(common, 'a'), path.join(folder, '.agents', 'skills', 'common-a'), 'junction');
  assert.deepEqual(readCommonSkills(folder), ['common-a', 'common-b']);
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /옛 형식/);
  assert.match(p, /옛 이름 폴더의 공통 스킬.*_skills\/a/);
  assert.doesNotMatch(p, /공통 스킬 없음/);
  assert.equal(fixCommonSkills(folder, common), true);
  assert.deepEqual(listOf(folder), ['common-a', 'common-b']);
  assert.ok(!fs.existsSync(path.join(common, 'a')));
  assert.match(fs.readFileSync(path.join(common, 'common-a', 'SKILL.md'), 'utf8'), /^---\nname: common-a\ndescription: d\n---/);
  assert.ok(linked(folder, '.agents/skills/common-a'));
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'common-a', 'SKILL.md')), 'the old link reaches the moved skill');
  assert.deepEqual(agy(folder).entries[0].include_only, ['common-a', 'common-b']);
  assert.equal(commonSkillProblem(folder, common), null);
  // Another workspace still on the old list: the folder is already moved, so only its list and link change.
  const other = path.join(path.dirname(folder), 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, COMMON_SKILLS_FILE), JSON.stringify({ skills: ['a'] }));
  fixCommonSkills(other, common);
  assert.deepEqual(listOf(other), ['common-a']);
  assert.equal(commonSkillProblem(other, common), null);
});

test('a name dropped from the list loses its link and its place in skills.json; other entries and the folder’s own skills stay', () => {
  const { common, folder } = setup(['common-a', 'common-b']);
  fixCommonSkills(folder, common);
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'own'), { recursive: true });
  const file = path.join(folder, ...AGY_SKILLS_FILE.split('/'));
  const hand = { path: 'C:/elsewhere', include_only: ['x'] };
  fs.writeFileSync(file, JSON.stringify({ entries: [hand, ...agy(folder).entries] }));
  fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), JSON.stringify({ skills: ['common-a'] }));
  assert.match(commonSkillProblem(folder, common)!, /목록에 없는 공통 스킬 링크: \.agents\/skills\/common-b/);
  fixCommonSkills(folder, common);
  assert.ok(!fs.existsSync(path.join(folder, '.agents', 'skills', 'common-b')));
  assert.ok(fs.existsSync(path.join(common, 'common-b', 'SKILL.md')), 'only the link went');
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'own')));
  assert.deepEqual(agy(folder), { entries: [hand, { path: common.split(path.sep).join('/'), include_only: ['common-a'] }] });
  assert.equal(commonSkillProblem(folder, common), null);
  // An empty list: our entry goes, the hand-made one stays; with none left the file goes.
  fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), JSON.stringify({ skills: [] }));
  fixCommonSkills(folder, common);
  assert.deepEqual(agy(folder), { entries: [hand] });
  fs.writeFileSync(file, JSON.stringify({ entries: [{ path: '../_skills', include_only: ['common-a'] }] }));
  fixCommonSkills(folder, common);
  assert.ok(!fs.existsSync(file));
});

test('a hand-made link to a common skill under another name is taken onto the list', () => {
  const { common, folder } = setup(null);
  fs.mkdirSync(path.join(folder, '.agents', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(common, 'common-b'), path.join(folder, '.agents', 'skills', 'b'), 'junction');
  assert.match(commonSkillProblem(folder, common)!, /목록에 넣을 공통 스킬 링크: \.agents\/skills\/b/);
  fixCommonSkills(folder, common);
  assert.deepEqual(readCommonSkills(folder), ['common-b']);
  assert.ok(!fs.existsSync(path.join(folder, '.agents', 'skills', 'b')));
  assert.ok(linked(folder, '.agents/skills/common-b'));
  assert.equal(commonSkillProblem(folder, common), null);
});

test('an unknown name and a real folder in the way are reported, not made up or removed', () => {
  const { common, folder } = setup(['common-a', 'common-zzz']);
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'common-a'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.agents', 'skills', 'common-a', 'x.md'), 'mine');
  fixCommonSkills(folder, common);
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /공통 스킬 없음: common-zzz/);
  assert.match(p, /링크 대신 실제 폴더\(지우지 않음\): \.agents\/skills\/common-a/);
  assert.equal(fs.readFileSync(path.join(folder, '.agents', 'skills', 'common-a', 'x.md'), 'utf8'), 'mine');
  fs.writeFileSync(path.join(folder, COMMON_SKILLS_FILE), '{oops');
  assert.equal(readCommonSkills(folder), 'bad');
  assert.match(commonSkillProblem(folder, common)!, /못 읽음/);
});

// 없으면 놓치는 실수: 공간 스킬이 공통 스킬 이름 자리(common-…)를 쓰면 링크와 겹치거나 Antigravity 목록에서 하나로 합쳐 보인다.
test('an own skill named common-* (not on the list) is reported and left; an own skill named like the short name is fine now', () => {
  const { common, folder } = setup(['common-a']);
  fixCommonSkills(folder, common);
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'common-mine'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.agents', 'skills', 'a'), { recursive: true });
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /common-으로 시작하는 공간 스킬.*: \.agents\/skills\/common-mine$/);
  assert.equal(fixCommonSkills(folder, common), false);
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'common-mine')));
});

test('secretary-link.local.json writing also puts the skill layout and the common skills right (install check item workspace-links)', () => {
  const { wsRoot, folder } = setup(['b']);
  // The old workspace layout: skills/.
  fs.mkdirSync(path.join(folder, 'skills', 'own'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'skills', 'own', 'SKILL.md'), '# own');
  const root = tempDir();
  const old = process.env.SECRETARY_WORKSPACE_ROOT;
  process.env.SECRETARY_WORKSPACE_ROOT = wsRoot;
  try {
    assert.equal(writeLink(folder, root), true);
    assert.equal(linkProblem(folder, root), null);
    assert.ok(linked(folder, '.agents/skills/common-b'));
    assert.ok(linked(folder, '.claude/skills'));
    assert.deepEqual(listOf(folder), ['common-b']);
    assert.equal(fs.readFileSync(path.join(folder, '.claude', 'skills', 'own', 'SKILL.md'), 'utf8'), '# own');
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

// Without it: lists written before 2026-11-09 keep the old about (names without common-) after their names were fixed.
test('an about the secretary wrote before is written again with the current one; one the user wrote is left', () => {
  const { common, folder } = setup(['common-a']);
  fixCommonSkills(folder, common);
  const file = path.join(folder, COMMON_SKILLS_FILE);
  fs.writeFileSync(file, JSON.stringify({ about: OLD_COMMON_SKILLS_ABOUTS[0], skills: ['common-a'] }));
  assert.match(commonSkillProblem(folder, common)!, /about이 옛 설명/);
  assert.equal(fixCommonSkills(folder, common), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { about: COMMON_SKILLS_ABOUT, skills: ['common-a'] });
  assert.equal(commonSkillProblem(folder, common), null);
  fs.writeFileSync(file, JSON.stringify({ about: '사용자가 직접 쓴 설명', skills: ['common-a'] }));
  assert.equal(commonSkillProblem(folder, common), null, 'a hand-written about is not ours to change');
});