import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { workspaceRootOf } from '../src/workspace/secretary-link.ts';
import { readStaff, STAFF_NAMES, STAFF_DIR, staffConfigProblems, staffFolder } from '../src/staff/staff.ts';

// Without it: a worker file with a typo (a tool name, a missing time limit) is found only when the unattended run fails.
test('every worker file in src/staff is listed and right, its instructions are there, and its folder is _staff/<its name>', () => {
  const files = fs.readdirSync(path.join(PROJECT_ROOT, ...STAFF_DIR.split('/'))).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  assert.deepEqual(files.sort(), [...STAFF_NAMES].sort());
  for (const name of STAFF_NAMES) {
    const w = readStaff(name);
    if (w.instructions) assert.ok(fs.existsSync(path.join(PROJECT_ROOT, ...w.instructions.split('/'))), w.instructions);
    assert.equal(w.name, name);
    assert.equal(staffFolder(w), path.join(workspaceRootOf(PROJECT_ROOT), '_staff', name));
  }
  const c = readStaff('memory-consolidation');
  assert.equal(c.memory, 'write');
  assert.ok(c.mcpTools.includes('mark_consolidated') && c.deniedTools.includes('Bash'));
  // The board rewrite: its prompt is built by code, no memory and no tools (it only writes the board's text).
  const b = readStaff('situation-board');
  assert.equal(b.instructions, undefined);
  assert.equal(b.memory, 'none');
  assert.deepEqual(b.tools, []);
  assert.ok(b.deniedTools.includes('Bash') && b.deniedTools.includes('Read'));
  const { name: _b, ...bFile } = b;
  const { name: _c, ...cFile } = c;
  assert.deepEqual(staffConfigProblems(bFile), []);
  assert.deepEqual(staffConfigProblems({ ...bFile, instructions: '', retryAfterFailMinutes: 0 }), ['instructions는 파일 경로(없으면 키를 뺀다)', 'retryAfterFailMinutes는 양수(없으면 키를 뺀다)']);
  // Without it: a folder written in the file drifts from the one the code and run-job use (_staff/<name>).
  assert.deepEqual(staffConfigProblems({ ...cFile, tools: ['Bad Tool'], timeoutMinutes: 0, folder: '_consolidate' }), ['folder 키는 쓰지 않음(폴더는 _staff/<담당자 이름>)', 'tools는 도구 이름 목록', 'timeoutMinutes는 양수']);
});
