import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { CHECKS } from '../src/setup/check-items.ts';
import { fixAuxFolders, planAuxFolders } from '../src/workspace/aux-folders.ts';
import { workspaceRootOf } from '../src/workspace/secretary-link.ts';
import { fixStaffFolder, readStaff, STAFF_NAMES, STAFF_DIR, staffConfigProblems, staffFolder, staffFolderProblems } from '../src/staff/staff.ts';
import { tempDir, testStore } from './helpers.ts';

/** Runs fn with the workspaces folder at a fresh temp folder. */
function inWorkspaces<T>(fn: (ws: string) => T): T {
  const ws = path.join(tempDir(), 'workspaces');
  fs.mkdirSync(ws);
  const saved = process.env.SECRETARY_WORKSPACE_ROOT;
  process.env.SECRETARY_WORKSPACE_ROOT = ws;
  try {
    return fn(ws);
  } finally {
    process.env.SECRETARY_WORKSPACE_ROOT = saved;
  }
}

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
  assert.deepEqual(staffConfigProblems({ ...bFile, instructions: '', retryAfterFailMinutes: 0 }), ['instructions는 파일 경로(없으면 칸을 뺀다)', 'retryAfterFailMinutes는 양수(없으면 칸을 뺀다)']);
  // Without it: a folder written in the file drifts from the one the code and run-job use (_staff/<name>).
  assert.deepEqual(staffConfigProblems({ ...cFile, tools: ['Bad Tool'], timeoutMinutes: 0, folder: '_consolidate' }), ['folder 칸은 쓰지 않음(폴더는 _staff/<담당자 이름>)', 'tools는 도구 이름 목록', 'timeoutMinutes는 양수']);
});

// Without it: the tool list drifts back into a second place (the old run-job -MemoryWrite list copied from the skill).
test('the consolidation tool list is only in the worker file: run-job and the memory script name no tools of their own', () => {
  const runJob = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'run-job', 'run-job.ps1'), 'utf8');
  const mcp = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-mcp.ps1'), 'utf8');
  for (const text of [runJob, mcp]) {
    assert.doesNotMatch(text, /mark_consolidated|MemoryConsolidateTools/);
    assert.doesNotMatch(text, /'Bash,PowerShell,Read/);
  }
  assert.match(runJob, /src\\staff\\\$Staff\.json/);
  assert.match(runJob, /Join-Path \(Join-Path \$workspaceRoot '_staff'\) \$Staff/);
  // Without it: run-job without its default folder runs in the temp folder, without that folder's rules (2026-11-09: it stops).
  assert.doesNotMatch(runJob, /GetTempPath/);
  assert.match(runJob, /throw "run-job 기본 작업 폴더가 없어요/);
  const skill = fs.readFileSync(path.join(PROJECT_ROOT, '.agents', 'skills', 'consolidate', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /allowed-tools/);
});

test('a worker folder: made with its role (AGENTS.md, CLAUDE.md importing it), put right when the role changes, run records left', () => {
  inWorkspaces((ws) => {
    const w = readStaff('memory-consolidation');
    assert.deepEqual(staffFolderProblems(w), ['_staff/memory-consolidation 없음']);
    assert.deepEqual(fixStaffFolder(w, PROJECT_ROOT, true), ['_staff/memory-consolidation 없음'], 'dry run');
    assert.ok(!fs.existsSync(path.join(ws, '_staff', 'memory-consolidation')));
    fixStaffFolder(w);
    const dir = staffFolder(w);
    assert.equal(dir, path.join(ws, '_staff', 'memory-consolidation'));
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /^# 기억 정리 담당\n/);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    assert.deepEqual(staffFolderProblems(w), []);
    fs.writeFileSync(path.join(dir, 'runs-AB12.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '옛 역할');
    assert.deepEqual(staffFolderProblems(w), ['_staff/memory-consolidation/AGENTS.md이 설정의 역할 글과 다름']);
    fixStaffFolder(w);
    assert.deepEqual(staffFolderProblems(w), []);
    assert.equal(fs.readFileSync(path.join(dir, 'runs-AB12.jsonl'), 'utf8'), '{}\n');
  });
});

// Without it: renaming old\ (or _old\) to _archived\ leaves the database's retired workspaces (and their tasks' folder) pointing at nothing.
test('aux folders: run-job-home and old move to _run-job-home and _archived, retired workspaces under old follow, both names left for the user', () => {
  inWorkspaces((ws) => {
    const dbPath = path.join(tempDir(), 'test.db');
    const store = testStore(dbPath);
    fs.mkdirSync(path.join(ws, 'run-job-home', 'output'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'old', 'maple-20261019'), { recursive: true });
    const live = store.createWorkspace({ kind: 'solo', name: 'live', title: 'L', purpose: 'p', folder: path.join(ws, 'live'), agents: [] });
    const gone = store.createWorkspace({ kind: 'solo', name: 'maple', title: '메이플', purpose: 'p', folder: path.join(ws, 'maple-20261019'), agents: [] });
    store.archiveWorkspace(gone.id, path.join(ws, 'old', 'maple-20261019'));
    const task = store.createTask({ workspaceId: gone.id, name: 't', title: '업무', goal: 'g', outputDir: 'o' });

    const plan = planAuxFolders(PROJECT_ROOT, dbPath);
    assert.deepEqual(plan.rename.map((r) => path.basename(r.to)), ['_run-job-home', '_archived']);
    assert.deepEqual(plan.repath, [{ id: gone.id, title: '메이플', from: path.join(ws, 'old', 'maple-20261019'), to: path.join(ws, '_archived', 'maple-20261019') }]);
    assert.deepEqual(plan.staff, ['_staff/memory-consolidation 없음', '_staff/situation-board 없음']);
    // The old run-job-home is moved there; its rules it lacks are made after the move.
    assert.ok(plan.runJobHome.includes('_run-job-home/AGENTS.md'));
    const item = CHECKS.find((c) => c.id === 'workspace-aux-folders')!;
    const before = item.run({ o: { root: PROJECT_ROOT, dbPath } as never, probe: null });
    assert.equal(before.status, 'missing');
    assert.match(before.detail!, /옮길 것: .*run-job-home → .*_run-job-home/);
    assert.match(before.detail!, /DB 고칠 것: 공간 #\d+ 메이플/);

    const { failed } = fixAuxFolders(PROJECT_ROOT, dbPath, (id, folder) => void store.moveWorkspace(id, folder));
    assert.deepEqual(failed, []);
    assert.ok(fs.existsSync(path.join(ws, '_run-job-home', 'output')) && !fs.existsSync(path.join(ws, 'run-job-home')), 'moved, no link left');
    assert.ok(fs.existsSync(path.join(ws, '_archived', 'maple-20261019')) && !fs.existsSync(path.join(ws, 'old')));
    assert.equal(store.getWorkspace(gone.id)?.folder, path.join(ws, '_archived', 'maple-20261019'));
    assert.equal(store.getTask(task.id)?.folder, path.join(ws, '_archived', 'maple-20261019'), "the tasks follow their workspace's folder");
    assert.equal(store.getWorkspace(live.id)?.folder, path.join(ws, 'live'), 'others untouched');
    assert.equal(item.run({ o: { root: PROJECT_ROOT, dbPath } as never, probe: null }).status, 'ok');

    // Both names there: nothing moved, said.
    fs.mkdirSync(path.join(ws, 'old'));
    const both = planAuxFolders(PROJECT_ROOT, dbPath);
    assert.deepEqual(both.rename, []);
    assert.deepEqual(both.both.map((r) => path.basename(r.from)), ['old']);
    // 없으면 놓치는 실수: 하루 쓰인 이름 _old(2026-11-09)로 옮겨 둔 PC에서 보관 공간이 _archived로 가지 않는다.
    fs.rmSync(path.join(ws, 'old'), { recursive: true });
    fs.renameSync(path.join(ws, '_archived'), path.join(ws, '_old'));
    assert.deepEqual(planAuxFolders(PROJECT_ROOT, dbPath).rename.map((r) => [path.basename(r.from), path.basename(r.to)]), [['_old', '_archived']]);
    store.db.close();
  });
});

// Without it: a new install has no _run-job-home, and run-job (which now stops without it) fails until the user or the secretary makes the folder.
test('aux folders: a new install gets the worker folders and run-job home with its rules; files already there are not rewritten', () => {
  inWorkspaces((ws) => {
    const dbPath = path.join(tempDir(), 'none.db');
    const plan = planAuxFolders(PROJECT_ROOT, dbPath);
    assert.deepEqual({ ...plan, staff: [], runJobHome: [] }, { rename: [], both: [], repath: [], staffMoves: [], staff: [], runJobHome: [] });
    assert.deepEqual(plan.staff, ['_staff/memory-consolidation 없음', '_staff/situation-board 없음']);
    assert.deepEqual(plan.runJobHome, ['_run-job-home/AGENTS.md', '_run-job-home/CLAUDE.md', '_run-job-home/.gitignore', '_run-job-home/common-skills.json']);
    assert.ok(!fs.existsSync(path.join(ws, '_run-job-home')), 'planning makes nothing');

    fixAuxFolders(PROJECT_ROOT, dbPath, () => assert.fail('no database rows'));
    const home = path.join(ws, '_run-job-home');
    assert.match(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), /^# run-job 작업 폴더\n[\s\S]*output\/research\//);
    assert.equal(fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    assert.ok(fs.existsSync(path.join(home, 'secretary-link.local.json')) && fs.existsSync(path.join(home, 'output', 'research')), 'link and research folder');
    // Only the common skills there are: none in this empty workspaces folder.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'common-skills.json'), 'utf8')).skills, []);
    assert.deepEqual(planAuxFolders(PROJECT_ROOT, dbPath), { rename: [], both: [], repath: [], staffMoves: [], staff: [], runJobHome: [] });

    fs.writeFileSync(path.join(home, 'AGENTS.md'), '사용자가 고친 규칙\n');
    fs.rmSync(path.join(home, 'CLAUDE.md'));
    assert.deepEqual(planAuxFolders(PROJECT_ROOT, dbPath).runJobHome, ['_run-job-home/CLAUDE.md']);
    fixAuxFolders(PROJECT_ROOT, dbPath, () => {});
    assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), '사용자가 고친 규칙\n', 'kept');
    assert.ok(fs.existsSync(path.join(home, 'CLAUDE.md')));
  });
});

// Without it: after the workers' rename (2026-11-09) the old _consolidate and _board stay behind with their run records,
// or a run that already made the new folder leaves the old records split off ("both there", nothing moved).
test('aux folders: old worker folders _consolidate and _board move to _staff/<name> with their run records, or merge into a new one already there', () => {
  inWorkspaces((ws) => {
    const dbPath = path.join(tempDir(), 'none.db');
    const oldC = path.join(ws, '_consolidate');
    const oldB = path.join(ws, '_board');
    fs.mkdirSync(oldC);
    fs.writeFileSync(path.join(oldC, 'AGENTS.md'), '# 기억 정리 담당\n옛 역할\n');
    fs.writeFileSync(path.join(oldC, 'runs-AB12.jsonl'), '{"n":1}\n');
    // The board's new folder is there already (a run made it): its records come after the old ones.
    fs.mkdirSync(oldB);
    fs.writeFileSync(path.join(oldB, 'CLAUDE.md'), '@AGENTS.md\n');
    fs.writeFileSync(path.join(oldB, 'runs-AB12.jsonl'), '{"old":1}\n');
    fs.writeFileSync(path.join(oldB, 'runs-CD34.jsonl'), '{"other":1}\n');
    fixStaffFolder(readStaff('situation-board'));
    const newB = path.join(ws, '_staff', 'situation-board');
    fs.writeFileSync(path.join(newB, 'runs-AB12.jsonl'), '{"new":1}\n');

    const plan = planAuxFolders(PROJECT_ROOT, dbPath);
    assert.deepEqual(plan.staffMoves, [
      { from: oldC, to: path.join(ws, '_staff', 'memory-consolidation'), merge: false },
      { from: oldB, to: newB, merge: true },
    ]);
    // The old consolidation folder about to be moved is checked: its role differs, its CLAUDE.md is missing.
    assert.deepEqual(plan.staff, ['_staff/memory-consolidation/AGENTS.md이 설정의 역할 글과 다름', '_staff/memory-consolidation/CLAUDE.md 없음']);
    const item = CHECKS.find((c) => c.id === 'workspace-aux-folders')!;
    const before = item.run({ o: { root: PROJECT_ROOT, dbPath } as never, probe: null });
    assert.match(before.detail!, /옮길 것: .*_consolidate → .*memory-consolidation/);
    assert.match(before.detail!, /담당자 폴더 합칠 것.*_board → .*situation-board/);
    assert.ok(fs.existsSync(oldC), 'planning moves nothing');

    const { failed } = fixAuxFolders(PROJECT_ROOT, dbPath, () => assert.fail('no database rows'));
    assert.deepEqual(failed, []);
    assert.ok(!fs.existsSync(oldC) && !fs.existsSync(oldB), 'no folder or link left at the old names');
    const newC = path.join(ws, '_staff', 'memory-consolidation');
    assert.equal(fs.readFileSync(path.join(newC, 'runs-AB12.jsonl'), 'utf8'), '{"n":1}\n');
    assert.deepEqual(staffFolderProblems(readStaff('memory-consolidation')), [], 'role put right after the move');
    assert.equal(fs.readFileSync(path.join(newB, 'runs-AB12.jsonl'), 'utf8'), '{"old":1}\n{"new":1}\n');
    assert.equal(fs.readFileSync(path.join(newB, 'runs-CD34.jsonl'), 'utf8'), '{"other":1}\n');
    assert.deepEqual(staffFolderProblems(readStaff('situation-board')), []);
    assert.deepEqual(planAuxFolders(PROJECT_ROOT, dbPath), { rename: [], both: [], repath: [], staffMoves: [], staff: [], runJobHome: [] });

    // Something else of the same name in both: left in the old folder and said.
    fs.mkdirSync(oldB);
    fs.writeFileSync(path.join(oldB, 'note.txt'), 'old');
    fs.writeFileSync(path.join(newB, 'note.txt'), 'new');
    const again = fixAuxFolders(PROJECT_ROOT, dbPath, () => {});
    assert.equal(again.failed.length, 1);
    assert.match(again.failed[0], /note\.txt/);
    assert.equal(fs.readFileSync(path.join(newB, 'note.txt'), 'utf8'), 'new');
  });
});

// Without it: the staff folders made under _workers (2026-11-09, before the staff rename) stay behind with their run
// records, and the empty _workers lingers beside the workspaces.
test('aux folders: _workers/<name> moves to _staff/<name> (merged after an older _consolidate), and the emptied _workers goes', () => {
  inWorkspaces((ws) => {
    const dbPath = path.join(tempDir(), 'none.db');
    const oldest = path.join(ws, '_consolidate');
    const mid = path.join(ws, '_workers', 'memory-consolidation');
    const midB = path.join(ws, '_workers', 'situation-board');
    fs.mkdirSync(oldest);
    fs.writeFileSync(path.join(oldest, 'runs-AB12.jsonl'), '{"n":1}\n');
    fs.mkdirSync(mid, { recursive: true });
    fs.writeFileSync(path.join(mid, 'runs-AB12.jsonl'), '{"n":2}\n');
    fs.mkdirSync(midB, { recursive: true });
    fs.writeFileSync(path.join(midB, 'runs-AB12.jsonl'), '{"b":1}\n');
    const newC = path.join(ws, '_staff', 'memory-consolidation');
    const newB = path.join(ws, '_staff', 'situation-board');
    assert.deepEqual(planAuxFolders(PROJECT_ROOT, dbPath).staffMoves, [
      { from: oldest, to: newC, merge: false },
      { from: mid, to: newC, merge: true },
      { from: midB, to: newB, merge: false },
    ]);
    const { failed } = fixAuxFolders(PROJECT_ROOT, dbPath, () => assert.fail('no database rows'));
    assert.deepEqual(failed, []);
    assert.equal(fs.readFileSync(path.join(newC, 'runs-AB12.jsonl'), 'utf8'), '{"n":2}\n{"n":1}\n', 'records merged in, the later move first');
    assert.equal(fs.readFileSync(path.join(newB, 'runs-AB12.jsonl'), 'utf8'), '{"b":1}\n');
    assert.ok(!fs.existsSync(path.join(ws, '_workers')), 'the emptied _workers is removed');
    assert.ok(!fs.existsSync(oldest));
    assert.deepEqual(staffFolderProblems(readStaff('memory-consolidation')), []);
  });
});