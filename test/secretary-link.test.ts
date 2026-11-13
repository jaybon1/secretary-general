import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SECRETARY_ID_FILE } from '../src/core/secretary-id.ts';
import { CHECKS } from '../src/setup/check-items.ts';
import { BLOCK_MARK, createWorkspaceFolder, findSecretaryCode, LINK_FILE, linkProblem, linkProblems, QUESTION_BASIS_RULE, QUESTION_FIRST_RULE, readLink, renderCharter, renderRunJobHome, RUN_JOB_HOME, VERIFIER_RUN_RULE, writeLink, type WorkspaceSpec } from '../src/workspace/workspace-create.ts';
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
  // 없으면 놓치는 실수: 점검이 첫 문제 하나만 보여 줘, 비서 진입점이 다른 공간에서는 AGENTS.md 옛 글 같은 뒤 문제가 가려진다(2026-11-10).
  assert.match(linkProblem(folder, root)!, new RegExp(`^${LINK_FILE} 없음; .*링크 없음: \\.claude/skills`));
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
  // 없으면 놓치는 실수: 2026-11-11 전에 만든 공간 .gitignore의 비서 주석이 옛 말("입구 폴더")로 남아도 점검이 조용하고 workspace-links가 고치지 않는다.
  const ignoreFile = path.join(folder, '.gitignore');
  const oldComment = '# 이 공간을 맡은 비서의 입구 폴더(비서가 써 둔다, PC마다 다르다)';
  fs.writeFileSync(ignoreFile, fs.readFileSync(ignoreFile, 'utf8').replace(/^# 이 공간을 맡은 비서의 .*$/m, oldComment));
  assert.match(linkProblem(folder, root)!, /\.gitignore 주석에 .*옛 말/);
  assert.equal(writeLink(folder, root), true);
  assert.ok(!fs.readFileSync(ignoreFile, 'utf8').includes(oldComment));
  assert.equal(linkProblem(folder, root), null);
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
    assert.match(out.detail!, new RegExp(`^live: ${LINK_FILE} 없음; .*, _run-job-home: ${LINK_FILE} 없음; `));
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

/** A charter's text with its block marks taken out: what a charter from before the marks (until 2026-11-12) looked like. */
const unmarked = (text: string) => text.split('\n').filter((l) => !BLOCK_MARK.test(l)).join('\n');
const SPEC_V: WorkspaceSpec = { ...SPEC, context: '- 우리 공간 맥락', verify: ['npm test'] };

// 없으면 놓치는 실수: 비서가 공간 규칙 틀을 고쳐도 이미 만든 공간 AGENTS.md는 옛 글로 남거나(옛 글 → 새 글 고침 쌍이 빠뜨린 문장), 다시 쓰면서
// 사용자가 더한 줄·공간 맥락·검증 명령을 지운다.
test('workspace-links writes each secretary block again from the template and leaves everything outside the marks', () => {
  const root = secretary();
  const folder = tempDir();
  writeLink(folder, root);
  const now = renderCharter(SPEC_V, root);
  assert.match(now, /<!-- secretary:begin work -->\n## 일하는 방식\n/);
  assert.match(now, /<!-- secretary:end verify -->\n- `npm test`\n/, 'the check commands are the workspace\'s, after the block');
  // A block with a sentence from an older template, and a line the user added after a block.
  const mine = '- 새 영상 업무는 먼저 장부를 본다.';
  const edited = now.replace('- 이 공간 폴더 밖은 읽기만 한다.', '- 이 공간 밖은 읽기만.').replace('<!-- secretary:end start -->\n', `<!-- secretary:end start -->\n${mine}\n`);
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), edited.replaceAll('\n', '\r\n'));
  assert.match(linkProblem(folder, root)!, /AGENTS\.md의 비서 표시 안이 지금 틀과 다름/);
  assert.equal(writeLink(folder, root), true);
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), now.replace('<!-- secretary:end start -->\n', `<!-- secretary:end start -->\n${mine}\n`), 'written back as LF');
  assert.equal(linkProblem(folder, root), null);
  // A mark with no pair, or a name the template does not have: reported, the file left.
  for (const bad of [now.replace('<!-- secretary:end ask -->\n', ''), now.replace('secretary:begin ask', 'secretary:begin asks').replace('secretary:end ask', 'secretary:end asks')]) {
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), bad);
    assert.match(linkProblem(folder, root)!, /비서 표시 짝이 맞지 않음|틀에 없는 비서 표시: asks/);
    writeLink(folder, root);
    assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), bad);
  }
});

// 없으면 놓치는 실수: 표시가 없던 공간(2026-11-12 전)을 옮기면서 사람이 더한 줄을 틀 줄로 알고 지우거나, 틀을 공간에 맞게 고친 줄을 공간 몫으로 남겨
// 같은 규칙이 두 번 들어간다. legacy-name: charter-unmarked
test('a charter without marks is moved: template lines (today\'s and old ones) into blocks, the workspace\'s own after them; unsure ones are left', () => {
  const root = secretary();
  const folder = tempDir();
  writeLink(folder, root);
  const now = renderCharter(SPEC_V, root);
  const mine = '- 새 영상 업무는 먼저 장부를 본다.';
  // An old template's line (the question's first line before 2026-11-10) where today's lines are.
  const oldFirst = '- 첫 줄은 `[질문]`으로 시작하고 질문 하나만 쓴다. 이어서 선택지, 추천과 이유, 답을 기다리는 동안 멈춘 작업을 적는다.';
  const before = unmarked(now).replace(`${QUESTION_FIRST_RULE}\n${QUESTION_BASIS_RULE}\n`, `${oldFirst}\n`).replace('- 이 공간 폴더 밖은 읽기만 한다.\n', `- 이 공간 폴더 밖은 읽기만 한다.\n${mine}\n`);
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), before);
  assert.match(linkProblem(folder, root)!, /AGENTS\.md에 비서 표시가 없음/);
  assert.equal(writeLink(folder, root), true);
  const moved = fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8');
  assert.equal(moved, now.replace('<!-- secretary:end work -->\n', `<!-- secretary:end work -->\n${mine}\n`));
  assert.equal(linkProblem(folder, root), null);
  // A line like a template line but not one (a template line the user changed): nothing changed, the line reported.
  const unsure = unmarked(now).replace('보고서·시험 결과·배포본(zip 등)은', '보고서·시험 결과·배포본(zip은 요청할 때만)은');
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), unsure);
  assert.match(linkProblem(folder, root)!, /"업무를 받으면"의 줄이 틀 줄과 비슷하지만 같지 않아 자동으로 옮기지 않음: - 제품 업무는/);
  writeLink(folder, root);
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), unsure);
  // A charter from a template without "스킬과 기억": left until the user says so, then it gets the section and MEMORY.md.
  const noLearning = unmarked(now).replace(/## 스킬과 기억\n[^]*?\n(?=## 일하는 방식)/, '');
  assert.notEqual(noLearning, unmarked(now));
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), noLearning);
  assert.match(linkProblem(folder, root)!, /지금 틀에 있는 절이 없어 자동으로 옮기지 않음\(스킬과 기억\)/);
  writeLink(folder, root);
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), noLearning);
  assert.equal(writeLink(folder, root, true), true);
  assert.equal(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8'), now);
  assert.match(fs.readFileSync(path.join(folder, 'MEMORY.md'), 'utf8'), /^# 인스타 사실 메모/);
  assert.equal(linkProblem(folder, root), null);
  // run-job's folder rules (made only when missing, aux-folders.ts) follow the template the same way.
  const home = path.join(tempDir(), RUN_JOB_HOME);
  fs.mkdirSync(home);
  writeLink(home, root);
  fs.writeFileSync(path.join(home, 'AGENTS.md'), `${unmarked(renderRunJobHome(root))}${mine}\n`);
  assert.equal(writeLink(home, root), true);
  assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), `${renderRunJobHome(root)}${mine}\n`);
  assert.equal(linkProblem(home, root), null);
});

// 없으면 놓치는 실수: 확인 담당이 검증을 업무 세션과 다른 환경(시험 폴더 환경변수 없이)으로 다시 돌리거나 반복·변형 시험까지 되풀이해 시간이 겹치고
// 제품 폴더에 시험 파일을 남긴다(업무 159).
test('the verifier line: settings handed over, one run with them, repeated/broken-copy runs only compared', () => {
  const now = renderCharter(SPEC);
  assert.ok(now.includes(VERIFIER_RUN_RULE), 'a new charter has the line');
  for (const key of ['환경 설정', '환경변수', '한 번씩만', '출력 파일과 대조만', '다시 돌리면', '깨뜨린 복사본']) assert.ok(VERIFIER_RUN_RULE.includes(key), key);
});
