import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SECRETARY_ID_FILE } from '../src/core/secretary-id.ts';
import { createWorkspaceFolder, findSecretaryCode, LINK_FILE, linkProblem, readLink, writeLink, type WorkspaceSpec } from '../src/workspace/workspace-create.ts';
import { tempDir } from './helpers.ts';

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

/** A workspace with secretary-link.local.json and a tool two folders down that prints what it finds. */
function toolSetup(): { ws: string; tools: string; dir: string } {
  const dir = secretary();
  const ws = tempDir();
  writeLink(ws, dir);
  const tools = path.join(ws, 'output', 'products', 'x');
  fs.mkdirSync(tools, { recursive: true });
  return { ws, tools, dir: path.join(path.resolve(dir), 'bin') };
}

/**
 * The environment the find code runs in: none of this PC's SECRETARY_*_DIR (the real secretary's would count), plus `vars`.
 * Without a link file the code takes the one variable naming a folder with a .secretary-id.
 */
function findEnv(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SECRETARY_.*_DIR$/i.test(k)));
  return { ...env, ...vars };
}
/** This secretary, the keys folder (no .secretary-id: not a secretary), the old name, and with `two` a second secretary. */
function findVars(): { one: Record<string, string>; two: Record<string, string>; bin: string } {
  const sec = secretary('AB12');
  const one = { SECRETARY_AB12_DIR: sec, SECRETARY_KEYS_DIR: tempDir(), SECRETARY_DIR: secretary('EF56') };
  return { one, two: { ...one, SECRETARY_CD34_DIR: secretary('CD34') }, bin: path.join(sec, 'bin') };
}

// 없으면 놓치는 실수: 비서 번호 없이 쓴 찾기 코드가 키 폴더 변수(SECRETARY_KEYS_DIR)를 비서로 잡거나, 비서가 둘일 때 아무 쪽이나 고른다.
test('the find code finds the secretary from a tool anywhere in the workspace (Node), else the one secretary variable', () => {
  const code = findSecretaryCode();
  const { ws, tools, dir } = toolSetup();
  const file = path.join(tools, 'find.mjs');
  fs.writeFileSync(file, `${code.node}\nconsole.log(secretaryBin() ?? '');\n`);
  const run = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [file], { encoding: 'utf8', env }).trim();
  assert.equal(run(findEnv()), dir);
  fs.rmSync(path.join(ws, LINK_FILE));
  const { one, two, bin } = findVars();
  assert.equal(run(findEnv(one)), bin);
  assert.equal(run(findEnv(two)), '', 'two secretaries: no guess');
  assert.equal(run(findEnv()), '');
});
