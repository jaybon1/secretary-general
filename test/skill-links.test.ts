import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write } from './helpers.ts';
import { fixSkillLinks, formatSkillLinkFix, SKILL_LINK_DIRS, skillLayout, skillLinkProblems, skillNames } from '../src/workspace/skill-links.ts';

const isLink = (root: string, rel: string) => fs.lstatSync(path.join(root, ...rel.split('/'))).isSymbolicLink();
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));
const link = (root: string, rel: string, target: string) => {
  fs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  fs.symlinkSync(target, path.join(root, ...rel.split('/')), 'junction');
};

/** A folder with two skills in .agents/skills and nothing else yet (a fresh clone). */
function folder(): string {
  const root = tempDir();
  write(path.join(root, '.agents', 'skills', 'delegate', 'SKILL.md'), '# delegate');
  write(path.join(root, '.agents', 'skills', 'delegate', 'references', 'a.md'), 'ref');
  write(path.join(root, '.agents', 'skills', 'grill', 'SKILL.md'), '# grill');
  // Not a skill: no SKILL.md.
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'notes'), { recursive: true });
  return root;
}

test('skills are real folders in .agents/skills; .claude/skills is one link to it, made by one command', () => {
  const root = folder();
  assert.deepEqual(skillNames(root), ['delegate', 'grill']);
  assert.deepEqual(SKILL_LINK_DIRS, ['.claude/skills', '.agents/skills']);
  assert.deepEqual(skillLinkProblems(skillLayout(root)), ['링크 없음: .claude/skills', '.gitignore에 스킬 링크 줄 없음']);
  // --dry-run changes nothing.
  const dry = fixSkillLinks(root, { dryRun: true });
  assert.deepEqual(dry.made, ['.gitignore', '.claude/skills']);
  assert.ok(!exists(root, '.claude'));
  assert.match(formatSkillLinkFix(dry, true).join('\n'), /만들 것: \.claude\/skills → \.agents\/skills[\s\S]*스킬 링크 고칠 것 2개$/);
  fixSkillLinks(root);
  assert.deepEqual(skillLinkProblems(skillLayout(root)), []);
  assert.ok(isLink(root, '.claude/skills'));
  // Read through the link, it is the one copy.
  assert.equal(read(root, '.claude/skills/delegate/references/a.md'), 'ref');
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'grill', 'SKILL.md'), '# grill 2');
  assert.equal(read(root, '.agents/skills/grill/SKILL.md'), '# grill 2');
  assert.match(read(root, '.gitignore'), /^\/\.claude\/skills$/m);
  // Run again: nothing to do.
  assert.deepEqual(formatSkillLinkFix(fixSkillLinks(root), false), ['스킬 링크: 모두 맞음']);
});
