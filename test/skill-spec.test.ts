import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { skillsDirProblems } from '../src/setup/skill-spec.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';

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

test('the skills in this repository follow the format (the secretary’s own and the release’s)', () => {
  for (const dir of [path.join(PROJECT_ROOT, '.agents', 'skills'), path.join(PROJECT_ROOT, 'release-src', 'overlay', '.agents', 'skills')]) {
    assert.deepEqual(skillsDirProblems(dir, { own: true }), [], dir);
  }
});
