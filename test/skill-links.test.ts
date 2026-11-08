import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { fixSkillIgnore, fixSkillLinks, formatSkillLinkFix, SKILL_GITIGNORE_LINES, SKILL_LINK_DIRS, skillLayout, skillLinkProblems, skillNames } from '../src/setup/skill-links.ts';

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
  assert.deepEqual(skillLinkProblems(skillLayout(root)), ['연결 없음: .claude/skills', '.gitignore에 스킬 연결 줄 없음']);
  // --dry-run changes nothing.
  const dry = fixSkillLinks(root, { dryRun: true });
  assert.deepEqual(dry.made, ['.gitignore', '.claude/skills']);
  assert.ok(!exists(root, '.claude'));
  assert.match(formatSkillLinkFix(dry, true).join('\n'), /만들 것: \.claude\/skills → \.agents\/skills[\s\S]*스킬 연결 고칠 것 2개$/);
  fixSkillLinks(root);
  assert.deepEqual(skillLinkProblems(skillLayout(root)), []);
  assert.ok(isLink(root, '.claude/skills'));
  // Read through the link, it is the one copy.
  assert.equal(read(root, '.claude/skills/delegate/references/a.md'), 'ref');
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'grill', 'SKILL.md'), '# grill 2');
  assert.equal(read(root, '.agents/skills/grill/SKILL.md'), '# grill 2');
  assert.match(read(root, '.gitignore'), /^\/\.claude\/skills$/m);
  // Run again: nothing to do.
  assert.deepEqual(formatSkillLinkFix(fixSkillLinks(root), false), ['스킬 연결: 모두 맞음']);
});

test('the secretary up to v8: skills/ with per-skill links moves to .agents/skills; links elsewhere move as links', () => {
  const root = tempDir();
  write(path.join(root, 'skills', 'delegate', 'SKILL.md'), '# delegate');
  write(path.join(root, 'skills', 'grill', 'SKILL.md'), '# grill');
  const vendor = tempDir();
  write(path.join(vendor, 'SKILL.md'), '# vendor');
  link(root, 'skills/ego-browser', vendor);
  const business = tempDir();
  write(path.join(business, 'mail', 'SKILL.md'), '# mail');
  for (const dir of SKILL_LINK_DIRS) for (const n of ['delegate', 'grill', 'ego-browser']) link(root, `${dir}/${n}`, path.join(root, 'skills', n));
  // A hand-made link in both CLI folders to a business skill elsewhere.
  link(root, '.claude/skills/mail', path.join(business, 'mail'));
  link(root, '.agents/skills/mail', path.join(business, 'mail'));
  write(path.join(root, '.gitignore'), ['secretary.db', '/.claude/skills/', ''].join('\n'));
  const r = skillLayout(root);
  assert.equal(r.claude, 'folder');
  assert.deepEqual(r.move.map((m) => m.from).sort(), ['skills/delegate', 'skills/ego-browser', 'skills/grill']);
  assert.match(skillLinkProblems(r).join(' / '), /연결 대신 실제 폴더\(옛 구조\): \.claude\/skills/);
  const fix = fixSkillLinks(root);
  assert.deepEqual(fix.failed, []);
  assert.deepEqual(fix.kept, []);
  assert.deepEqual(skillLinkProblems(skillLayout(root)), []);
  assert.ok(!exists(root, 'skills'), 'the old folder is gone');
  assert.ok(!isLink(root, '.agents/skills/delegate') && read(root, '.agents/skills/delegate/SKILL.md') === '# delegate');
  assert.ok(isLink(root, '.agents/skills/ego-browser') && read(root, '.agents/skills/ego-browser/SKILL.md') === '# vendor');
  assert.ok(isLink(root, '.agents/skills/mail') && read(root, '.agents/skills/mail/SKILL.md') === '# mail');
  assert.ok(isLink(root, '.claude/skills'));
  assert.deepEqual(skillNames(root), ['delegate', 'ego-browser', 'grill', 'mail']);
  assert.ok(fs.existsSync(path.join(vendor, 'SKILL.md')) && fs.existsSync(path.join(business, 'mail', 'SKILL.md')), 'what links pointed at is not touched');
  const ignore = read(root, '.gitignore');
  assert.match(ignore, /^secretary\.db$/m);
  assert.match(ignore, /^\/\.agents\/skills\/common-\*$/m);
  assert.equal(ignore, ['secretary.db', '/.claude/skills/', '/.agents/skills/common-*', '/.agents/skills.json', ''].join('\n'), 'the old line stays, no second one; the missing lines follow it without a header');
});

test('an old workspace: skills/ and its README, common-* links in a real .claude/skills, the old .gitignore block', () => {
  const root = tempDir();
  const common = tempDir();
  write(path.join(common, 'a', 'SKILL.md'), '# a');
  write(path.join(root, 'skills', 'README.md'), '업무 종류별 스킬을 `<이름>/SKILL.md`로 둔다. 목록과 쓰는 법은 AGENTS.md "스킬과 기억".\n');
  write(path.join(root, 'skills', 'voice', 'SKILL.md'), '# voice');
  for (const dir of SKILL_LINK_DIRS) link(root, `${dir}/common-a`, path.join(common, 'a'));
  write(path.join(root, '.gitignore'), ['.venv/', '# 공통 스킬(workspaces/_skills)로 가는 연결(비서가 common-skills.json대로 만든다, PC마다 다르다)', '.claude/skills/common-*', '.agents/skills/common-*', ''].join('\n'));
  assert.match(skillLinkProblems(skillLayout(root)).join(' / '), /\.gitignore/);
  fixSkillLinks(root);
  assert.deepEqual(skillLinkProblems(skillLayout(root)), []);
  assert.ok(!exists(root, 'skills'));
  assert.equal(read(root, '.agents/skills/voice/SKILL.md'), '# voice');
  assert.ok(isLink(root, '.agents/skills/common-a'), 'the common link stays (common-skills.ts owns it)');
  assert.equal(read(root, '.claude/skills/common-a/SKILL.md'), '# a');
  assert.equal(read(root, '.gitignore'), ['.venv/', '', ...SKILL_GITIGNORE_LINES, ''].join('\n'));
});

test('a .gitignore with some of the link lines gets the missing ones right after them, without a second header', () => {
  const root = folder();
  write(path.join(root, '.gitignore'), ['# 옛 머리줄', '/.claude/skills', '/.agents/skills/common-*', '', '.venv/', ''].join('\n'));
  assert.match(skillLinkProblems(skillLayout(root)).join(' / '), /\.gitignore/);
  fixSkillIgnore(root);
  assert.equal(read(root, '.gitignore'), ['# 옛 머리줄', '/.claude/skills', '/.agents/skills/common-*', '/.agents/skills.json', '', '.venv/', ''].join('\n'));
  assert.equal(fixSkillIgnore(root), false);
});

test('a name taken on both sides is left and reported; other moves still happen; a wrong link is made again', () => {
  const root = folder();
  const other = folder();
  write(path.join(root, 'skills', 'grill', 'SKILL.md'), '# my grill');
  write(path.join(root, 'skills', 'mine', 'SKILL.md'), '# mine');
  write(path.join(root, 'skills', 'notes.txt'), 'x');
  link(root, '.claude/skills', path.join(other, '.agents', 'skills'));
  const r = skillLayout(root);
  assert.equal(r.claude, 'wrong');
  const problems = skillLinkProblems(r).join(' / ');
  assert.match(problems, /다른 곳을 가리킴: \.claude\/skills\(→ [^)]+\)/);
  assert.match(problems, /같은 이름이 이미 있어 옮기지 않음\(지우지 않음\): skills\/grill, skills\/notes\.txt/);
  const fix = fixSkillLinks(root);
  assert.deepEqual(fix.remade, ['.claude/skills']);
  assert.deepEqual(fix.moved, ['skills/mine → .agents/skills/mine']);
  assert.deepEqual(fix.kept, ['skills/grill', 'skills/notes.txt']);
  assert.equal(read(root, 'skills/grill/SKILL.md'), '# my grill', 'not touched');
  assert.equal(read(root, '.agents/skills/grill/SKILL.md'), '# grill');
  assert.equal(read(root, '.claude/skills/mine/SKILL.md'), '# mine');
  assert.ok(fs.existsSync(path.join(other, '.agents', 'skills', 'delegate', 'SKILL.md')), 'what the wrong link pointed at is not touched');
  assert.match(formatSkillLinkFix(fix, false).at(-1)!, /^스킬 연결 고친 것 \d+개, 그대로 둔 것 2개$/);
});

test('a real skill folder in .claude/skills moves in; one whose name is taken keeps .claude/skills a folder', () => {
  const root = folder();
  write(path.join(root, '.claude', 'skills', 'own', 'SKILL.md'), '# own');
  write(path.join(root, '.claude', 'skills', 'grill', 'SKILL.md'), '# other grill');
  const fix = fixSkillLinks(root);
  assert.deepEqual(fix.moved, ['.claude/skills/own → .agents/skills/own']);
  assert.deepEqual(fix.kept, ['.claude/skills/grill', '.claude/skills']);
  assert.equal(read(root, '.claude/skills/grill/SKILL.md'), '# other grill');
  fs.rmSync(path.join(root, '.claude', 'skills', 'grill'), { recursive: true });
  fixSkillLinks(root);
  assert.ok(isLink(root, '.claude/skills'));
  assert.equal(read(root, '.claude/skills/own/SKILL.md'), '# own');
});

test('git keeps the links out: .claude/skills, common-* and Ego Lite’s link are ignored, the skills are not', (t) => {
  const ignored = (p: string) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: PROJECT_ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: PROJECT_ROOT, stdio: 'ignore' });
  } catch {
    t.skip('not a git checkout (a release unpacked from a zip): its .gitignore is read by git only');
    return;
  }
  for (const p of ['.claude/skills/delegate/SKILL.md', '.agents/skills/common-example/SKILL.md', '.agents/skills/ego-browser/SKILL.md']) assert.ok(ignored(p), p);
  for (const p of ['.agents/skills/delegate/SKILL.md', '.claude/settings.json']) assert.ok(!ignored(p), p);
});
