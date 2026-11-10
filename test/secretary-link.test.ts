import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SECRETARY_ID_FILE } from '../src/setup/secretary-id.ts';
import { CHECKS } from '../src/setup/check-items.ts';
import { createWorkspaceFolder, findSecretaryCode, LINK_FILE, linkProblem, linkProblems, oldFindSecretaryFixes, readLink, renderCharter, renderFindSecretary, writeLink, type WorkspaceSpec } from '../src/workspace/workspace-create.ts';
import { tempDir, testStore } from './helpers.ts';

const win = process.platform === 'win32';
const SPEC: WorkspaceSpec = { kind: 'solo', name: 'insta', title: '인스타', purpose: '게시물 제작' };

/** A secretary folder with an id, in a temp place. */
function secretary(id = 'AB12'): string {
  const root = tempDir();
  fs.writeFileSync(path.join(root, SECRETARY_ID_FILE), `${id}\n`);
  return root;
}

test('a new workspace gets secretary-link.local.json (this secretary\'s folder and id), kept out of its git', () => {
  const root = secretary();
  const ws = createWorkspaceFolder({ ...SPEC, parentDir: tempDir() }, undefined, root);
  const link = readLink(ws.folder)!;
  assert.equal(link.bin, path.join(path.resolve(root), 'bin'));
  assert.ok(!('dir' in link), 'the secretary folder itself is not named');
  assert.equal(link.id, 'AB12');
  assert.match(fs.readFileSync(path.join(ws.folder, '.gitignore'), 'utf8'), /^secretary-link\.local\.json$/m);
  assert.equal(linkProblem(ws.folder, root), null);
  if (fs.existsSync(path.join(ws.folder, '.git'))) {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ws.folder, encoding: 'utf8' });
    assert.doesNotMatch(tracked, /secretary-link\.local\.json/, 'a path on this PC is not committed');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: ws.folder, encoding: 'utf8' }), '', 'nothing left to commit');
  }
});

test('an older workspace gets the file and the .gitignore line; one pointing elsewhere is put right', () => {
  const root = secretary();
  const folder = tempDir();
  fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules/');
  assert.equal(linkProblem(folder, root), `${LINK_FILE} 없음`);
  assert.equal(writeLink(folder, root), true);
  assert.equal(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').split('\n').filter((l) => l === LINK_FILE).length, 1);
  assert.match(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8'), /^node_modules\/\n#/, 'the old lines stay, the new one goes on its own line');
  assert.equal(writeLink(folder, root), false, 'nothing to do the second time');
  // Moved secretary, another secretary, another id: each is a problem the writer fixes.
  const other = secretary('CD34');
  assert.match(linkProblem(folder, other)!, /^다른 폴더를 가리킴: /);
  fs.writeFileSync(path.join(root, SECRETARY_ID_FILE), 'EF56\n');
  assert.equal(linkProblem(folder, root), '번호가 다름: AB12');
  writeLink(folder, root);
  assert.equal(readLink(folder)!.id, 'EF56');
  assert.equal(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').split('\n').filter((l) => l === LINK_FILE).length, 1, 'the line is not added twice');
  fs.writeFileSync(path.join(folder, LINK_FILE), '{ broken');
  assert.equal(linkProblem(folder, root), `${LINK_FILE}을 못 읽음`);
});

test('the install check lists the database\'s workspaces (and run-job\'s home) whose file is missing or stale; the fix writes them', async () => {
  const root = secretary();
  const parent = tempDir();
  const dbPath = path.join(tempDir(), 'test.db');
  const store = testStore(dbPath);
  const live = path.join(parent, 'live');
  const archived = path.join(parent, 'archived');
  for (const f of [live, archived]) fs.mkdirSync(f);
  store.createWorkspace({ kind: 'solo', name: 'live', title: 'L', purpose: 'p', folder: live, agents: [] });
  const old = store.createWorkspace({ kind: 'solo', name: 'old', title: 'O', purpose: 'p', folder: archived, agents: [] });
  store.archiveWorkspace(old.id, archived);
  store.createWorkspace({ kind: 'solo', name: 'gone', title: 'G', purpose: 'p', folder: path.join(parent, 'gone'), agents: [] });
  store.db.close();
  const home = path.join(parent, 'workspaces', '_run-job-home');
  fs.mkdirSync(home, { recursive: true });
  const saved = process.env.SECRETARY_WORKSPACE_ROOT;
  process.env.SECRETARY_WORKSPACE_ROOT = path.join(parent, 'workspaces');
  try {
    assert.deepEqual(linkProblems(dbPath, root).map((p) => path.basename(p.folder)), ['live', '_run-job-home'], 'archived and gone ones are not looked at');
    const item = CHECKS.find((c) => c.id === 'workspace-links')!;
    const out = item.run({ o: { root, dbPath } as never, probe: null });
    assert.equal(out.status, 'missing');
    assert.equal(out.detail, `live: ${LINK_FILE} 없음, _run-job-home: ${LINK_FILE} 없음`);
    for (const p of linkProblems(dbPath, root)) writeLink(p.folder, root);
    assert.equal(item.run({ o: { root, dbPath } as never, probe: null }).status, 'ok');
    // No database (a first install): nothing to look at but run-job's home.
    assert.deepEqual(linkProblems(path.join(tempDir(), 'none.db'), root), []);
  } finally {
    if (saved === undefined) delete process.env.SECRETARY_WORKSPACE_ROOT;
    else process.env.SECRETARY_WORKSPACE_ROOT = saved;
  }
});

/** A workspace with secretary-link.local.json and a tool two folders down that prints what it finds. */
function toolSetup(): { ws: string; tools: string; dir: string } {
  const dir = secretary();
  const ws = tempDir();
  writeLink(ws, dir);
  const tools = path.join(ws, 'output', 'products', 'x');
  fs.mkdirSync(tools, { recursive: true });
  return { ws, tools, dir: path.join(path.resolve(dir), 'bin') };
}

test('the charter\'s code finds the secretary folder from a tool anywhere in the workspace (Node), else the variables', () => {
  const code = findSecretaryCode('SECRETARY_AB12_DIR');
  assert.ok(renderCharter(SPEC).includes(findSecretaryCode().node), 'the charter carries the code');
  const { ws, tools, dir } = toolSetup();
  const file = path.join(tools, 'find.mjs');
  fs.writeFileSync(file, `${code.node}\nconsole.log(secretaryBin());\n`);
  assert.equal(execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim(), dir);
  // Without the file: this secretary's variable (the old SECRETARY_DIR is not read any more).
  fs.rmSync(path.join(ws, LINK_FILE));
  const env = { ...process.env, SECRETARY_AB12_DIR: 'C:\\by-id', SECRETARY_DIR: 'C:\\old' };
  assert.equal(execFileSync(process.execPath, [file], { encoding: 'utf8', env }).trim(), 'C:\\by-id\\bin');
  assert.equal(execFileSync(process.execPath, [file], { encoding: 'utf8', env: { ...env, SECRETARY_AB12_DIR: '' } }).trim(), '');
});

test('the same in PowerShell 5.1', { skip: !win }, () => {
  const code = findSecretaryCode('SECRETARY_AB12_DIR');
  const { ws, tools, dir } = toolSetup();
  const file = path.join(tools, 'find.ps1');
  fs.writeFileSync(file, `\uFEFF${code.powershell}\nGet-SecretaryBin\n`);
  const run = (env = process.env) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env }).trim();
  assert.equal(run(), dir);
  fs.rmSync(path.join(ws, LINK_FILE));
  assert.equal(run({ ...process.env, SECRETARY_AB12_DIR: 'C:\\by-id', SECRETARY_DIR: 'C:\\old' }), 'C:\\by-id\\bin');
  assert.equal(run({ ...process.env, SECRETARY_AB12_DIR: '', SECRETARY_DIR: 'C:\\old' }), '');
});

test('the same in Python', { skip: spawnSync('python', ['--version']).status !== 0 }, () => {
  const code = findSecretaryCode('SECRETARY_AB12_DIR');
  const { ws, tools, dir } = toolSetup();
  const file = path.join(tools, 'find.py');
  fs.writeFileSync(file, `${code.python}\nprint(secretary_bin())\n`);
  const run = (env = process.env) => execFileSync('python', ['-I', file], { encoding: 'utf8', env }).trim();
  assert.equal(run(), dir);
  fs.rmSync(path.join(ws, LINK_FILE));
  assert.equal(run({ ...process.env, SECRETARY_AB12_DIR: 'C:\\by-id', SECRETARY_DIR: 'C:\\old' }), 'C:\\by-id\\bin');
  // 없으면 놓치는 실수: 위치 파일도 환경변수도 없을 때 Path(None)의 TypeError로 멈춰 원인을 알 수 없다.
  const none = spawnSync('python', ['-I', file], { encoding: 'utf8', env: { ...process.env, SECRETARY_AB12_DIR: '' } });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /SECRETARY_AB12_DIR.*workspace-links/); // the Korean words come in the console's code page (python -I ignores PYTHONIOENCODING)
  assert.doesNotMatch(none.stderr, /TypeError/);
});

// 없으면 놓치는 실수: 공간 규칙(AGENTS.md)의 파이썬 찾는 코드가 2026-11-10 전 꼴(못 찾으면 TypeError)에 머물러, 새 도구도 그 꼴을 베낀다.
test('workspace-links rewrites the charter\'s Python code that stopped with a bare TypeError', () => {
  const root = secretary();
  const folder = tempDir();
  const now = renderFindSecretary('SECRETARY_AB12_DIR').join('\n');
  const [a, b] = oldFindSecretaryFixes(root).at(-1)!;
  assert.ok(now.includes(b));
  writeLink(folder, root);
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), `# 공간\n\n${now.replace(b, a)}\n`);
  assert.match(linkProblem(folder, root)!, /못 찾을 때 알림 없는/);
  assert.equal(writeLink(folder, root), true);
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), `# 공간\n\n${now}\n`);
});

// 없으면 놓치는 실수: 공간 규칙(AGENTS.md)의 비서 입구 찾는 글과 코드에 옛 환경변수 SECRETARY_DIR가 남아, 새로 만드는 공간 도구도 옛 이름을 읽는다.
test('workspace-links rewrites a charter\'s old find-secretary lines (the old SECRETARY_DIR after the variable) to today\'s', () => {
  const root = secretary();
  const folder = tempDir();
  const now = renderFindSecretary('SECRETARY_AB12_DIR').join('\n');
  let old = now;
  for (const [a, b] of oldFindSecretaryFixes(root)) {
    assert.ok(now.includes(b), `today's line: ${b}`);
    old = old.replace(b, a);
  }
  assert.notEqual(old, now);
  assert.match(old, /SECRETARY_DIR/);
  writeLink(folder, root);
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), `# 공간\n\n${old}\n`);
  assert.match(linkProblem(folder, root)!, /옛 환경변수 SECRETARY_DIR/);
  assert.equal(writeLink(folder, root), true);
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), `# 공간\n\n${now}\n`);
  assert.equal(linkProblem(folder, root), null);
  assert.deepEqual(oldFindSecretaryFixes(tempDir()), [], 'a copy without an id has only the old name');
});

// 없으면 놓치는 실수: 비서 위치 파일 이름을 secretary-link.local.json으로 바꾼 뒤, 옛 이름 secretary.json을 읽는 공간 도구가 낡은 값을 읽거나
// 공간 AGENTS.md의 찾는 코드가 옛 이름에 머문다.
test('the old link name secretary.json: kept the same while it is there (never made), the charter code moves to the new name', () => {
  const root = secretary();
  const folder = tempDir();
  writeLink(folder, root);
  assert.ok(!fs.existsSync(path.join(folder, 'secretary.json')), 'no old-name file is made');
  // A workspace from before: the old file pointing elsewhere, and the charter's code reading the old name.
  const now = renderFindSecretary('SECRETARY_AB12_DIR').join('\n');
  const old = now.replaceAll(LINK_FILE, 'secretary.json');
  assert.notEqual(old, now);
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), `# 공간\n\n${old}\n`);
  assert.match(linkProblem(folder, root)!, /옛 파일 이름 secretary\.json/);
  fs.writeFileSync(path.join(folder, 'secretary.json'), JSON.stringify({ bin: 'C:\\elsewhere\\bin' }));
  assert.match(linkProblem(folder, root)!, /옛 이름 secretary\.json이 새 파일과 다름/);
  assert.equal(writeLink(folder, root), true);
  assert.equal(fs.readFileSync(path.join(folder, 'secretary.json'), 'utf8'), fs.readFileSync(path.join(folder, LINK_FILE), 'utf8'), 'the old file now says the same');
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), `# 공간\n\n${now}\n`);
  assert.equal(linkProblem(folder, root), null);
});
