import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { INSTALL_ID_FILE } from '../src/setup/install-id.ts';
import { CHECKS } from '../src/setup/check-items.ts';
import { createWorkspaceFolder, findSecretaryCode, LINK_FILE, linkProblem, linkProblems, readLink, renderCharter, writeLink, type WorkspaceSpec } from '../src/workspace/folders.ts';
import { tempDir, testStore } from './helpers.ts';

const win = process.platform === 'win32';
const SPEC: WorkspaceSpec = { kind: 'solo', name: 'insta', title: '인스타', purpose: '게시물 제작' };

/** A secretary folder with an id, in a temp place. */
function secretary(id = 'AB12'): string {
  const root = tempDir();
  fs.writeFileSync(path.join(root, INSTALL_ID_FILE), `${id}\n`);
  return root;
}

test('a new workspace gets secretary.json (this secretary\'s folder and id), kept out of its git', () => {
  const root = secretary();
  const ws = createWorkspaceFolder({ ...SPEC, parentDir: tempDir() }, undefined, root);
  const link = readLink(ws.folder)!;
  assert.equal(link.bin, path.join(path.resolve(root), 'bin'));
  assert.ok(!('dir' in link), 'the secretary folder itself is not named');
  assert.equal(link.id, 'AB12');
  assert.match(fs.readFileSync(path.join(ws.folder, '.gitignore'), 'utf8'), /^secretary\.json$/m);
  assert.equal(linkProblem(ws.folder, root), null);
  if (fs.existsSync(path.join(ws.folder, '.git'))) {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ws.folder, encoding: 'utf8' });
    assert.doesNotMatch(tracked, /secretary\.json/, 'a path on this PC is not committed');
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
  fs.writeFileSync(path.join(root, INSTALL_ID_FILE), 'EF56\n');
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
  const home = path.join(parent, 'workspaces', 'run-job-home');
  fs.mkdirSync(home, { recursive: true });
  const saved = process.env.SECRETARY_WORKSPACE_ROOT;
  process.env.SECRETARY_WORKSPACE_ROOT = path.join(parent, 'workspaces');
  try {
    assert.deepEqual(linkProblems(dbPath, root).map((p) => path.basename(p.folder)), ['live', 'run-job-home'], 'archived and gone ones are not looked at');
    const item = CHECKS.find((c) => c.id === 'workspace-links')!;
    const out = item.run({ o: { root, dbPath } as never, probe: null });
    assert.equal(out.status, 'missing');
    assert.equal(out.detail, `live: ${LINK_FILE} 없음, run-job-home: ${LINK_FILE} 없음`);
    for (const p of linkProblems(dbPath, root)) writeLink(p.folder, root);
    assert.equal(item.run({ o: { root, dbPath } as never, probe: null }).status, 'ok');
    // No database (a first install): nothing to look at but run-job's home.
    assert.deepEqual(linkProblems(path.join(tempDir(), 'none.db'), root), []);
  } finally {
    if (saved === undefined) delete process.env.SECRETARY_WORKSPACE_ROOT;
    else process.env.SECRETARY_WORKSPACE_ROOT = saved;
  }
});

/** A workspace with secretary.json and a tool two folders down that prints what it finds. */
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
  // Without the file: this secretary's variable, then the old one.
  fs.rmSync(path.join(ws, LINK_FILE));
  const env = { ...process.env, SECRETARY_AB12_DIR: 'C:\\by-id', SECRETARY_DIR: 'C:\\old' };
  assert.equal(execFileSync(process.execPath, [file], { encoding: 'utf8', env }).trim(), 'C:\\by-id\\bin');
  assert.equal(execFileSync(process.execPath, [file], { encoding: 'utf8', env: { ...env, SECRETARY_AB12_DIR: '' } }).trim(), 'C:\\old\\bin');
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
  assert.equal(run({ ...process.env, SECRETARY_AB12_DIR: '', SECRETARY_DIR: 'C:\\old' }), 'C:\\old\\bin');
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
  assert.equal(run({ ...process.env, SECRETARY_AB12_DIR: '', SECRETARY_DIR: 'C:\\old' }), 'C:\\old\\bin');
});
