import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AGY_SKILLS_FILE, COMMON_SKILLS_FILE, commonSkillProblem, fixCommonSkills } from '../src/workspace/common-skills.ts';
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

test('listed common skills: a link of the same name in .agents/skills, and .agents/skills.json for Antigravity with an absolute path (per PC, out of git)', () => {
  const { common, folder } = setup(['common-a']);
  const p = commonSkillProblem(folder, common)!;
  assert.match(p, /공통 스킬 링크 없음·틀림: \.agents\/skills\/common-a/);
  assert.match(p, /\.agents\/skills\.json이 목록과 다름/);
  assert.equal(fixCommonSkills(folder, common), true);
  assert.equal(commonSkillProblem(folder, common), null);
  assert.ok(linked(folder, '.agents/skills/common-a'));
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'common-a', 'SKILL.md')), 'the link reaches the skill');
  assert.ok(!fs.existsSync(path.join(folder, '.claude')), '.claude/skills is the layout fix’s (workspace/skill-links.ts)');
  assert.deepEqual(agy(folder), { entries: [{ path: common.split(path.sep).join('/'), include_only: ['common-a'] }] });
  assert.equal(fixCommonSkills(folder, common), false, 'nothing to do the second time');
});
