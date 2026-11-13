import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { frontMatter, SPEC_KEY_EXCEPTIONS, skillSpecProblems, skillsDirProblems } from '../src/setup/skill-spec.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';

const skill = (dir: string, name: string, text: string, extra: Record<string, string> = {}) => {
  const at = path.join(dir, name);
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, 'SKILL.md'), text);
  for (const [rel, body] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(at, rel)), { recursive: true });
    fs.writeFileSync(path.join(at, rel), body);
  }
  return at;
};

// 없으면 놓치는 실수: 업무 세션·비서가 만든 스킬이 agentskills.io 사양(name = 폴더 이름, 맨 위 참고 파일은 references/)에서 벗어나도 아무도 모른다(2026-11-09 사양 맞추기).
test('a skill against the format: name not the folder, bad name, no description, a loose file, an unknown key, too long; a common- name in a workspace', () => {
  const dir = tempDir();
  const good = skill(dir, 'good-one', '---\nname: good-one\ndescription: 무엇을 언제\nmetadata:\n  version: "1"\n---\n# x\n', { 'scripts/a.py': '', 'references/r.md': '', 'assets/c.json': '{}' });
  assert.deepEqual(skillSpecProblems(good), []);
  const bad = skill(dir, 'Bad', '---\nname: Other_X\nfoo: 1\n---\n' + 'x\n'.repeat(600), { 'notes.md': '' });
  const p = skillSpecProblems(bad).join(' / ');
  for (const w of ['폴더 이름과 다름', '64자 형식', 'description 없음', '사양에 없는 머리말 키: foo', '줄(500줄 미만', 'notes.md']) assert.ok(p.includes(w), `${w}: ${p}`);
  assert.deepEqual(skillSpecProblems(skill(dir, 'no-fm', '# x')), ['머리말(`--- … ---`) 없음']);
  const own = skill(dir, 'common-x', '---\nname: common-x\ndescription: d\n---\n');
  assert.deepEqual(skillSpecProblems(own), []);
  assert.match(skillSpecProblems(own, { own: true }).join(), /common-/);
  assert.deepEqual(frontMatter('---\nname: a\ndescription: >\n  두 줄\n  설명\n---\n')?.get('description'), '두 줄 설명');
  // Links (ego-browser, common-*) are another's to keep: skipped.
  fs.symlinkSync(bad, path.join(dir, 'linked'), 'junction');
  assert.deepEqual(skillsDirProblems(dir).map((x) => x.skill), ['Bad', 'no-fm']);
});

test('the format exceptions are one list with a reason, and only keys a skill really has', () => {
  for (const [name, keys] of Object.entries(SPEC_KEY_EXCEPTIONS)) {
    const fm = frontMatter(fs.readFileSync(path.join(PROJECT_ROOT, '.agents', 'skills', name, 'SKILL.md'), 'utf8'))!;
    for (const k of keys) assert.ok(fm.has(k), `${name}: ${k} is not in its front matter any more, take it off the exceptions`);
  }
});

test('the skills in this repository follow the format (the secretary’s own and the release’s)', () => {
  for (const dir of [path.join(PROJECT_ROOT, '.agents', 'skills'), path.join(PROJECT_ROOT, 'release-src', 'overlay', '.agents', 'skills')]) {
    assert.deepEqual(skillsDirProblems(dir, { own: true }), [], dir);
  }
});
