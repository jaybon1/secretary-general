import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain .mjs script without types
import { ID_ALPHABET, ID_FILE, LIST_FILE, PROTECTED, baseFor, ensureId, classify, classifyMoved, compareVersions, fileHash, findTag, movesBetween, normalize, parseVersion, recommend, restyle, sortTags, versionLabel } from '../scripts/update.mjs';
import { fileHash as releaseHash } from '../src/setup/release-files.ts';

test('each file is sorted by who changed it since the installed version', () => {
  // base, user, theirs
  assert.equal(classify('a', 'a', 'b'), 'replace');
  assert.equal(classify('a', 'u', 'a'), 'keep');
  assert.equal(classify('a', 'u', 'b'), 'merge');
  assert.equal(classify('a', 'b', 'b'), 'same');
  assert.equal(classify(undefined, undefined, 'n'), 'add');
  assert.equal(classify(undefined, 'mine', 'n'), 'ask-add');
  assert.equal(classify(undefined, 'n', 'n'), 'same');
  assert.equal(classify('a', 'a', undefined), 'delete');
  assert.equal(classify('a', 'u', undefined), 'ask-delete');
  assert.equal(classify('a', undefined, undefined), 'same');
  // The user deleted a file: left deleted unless the new version changed it.
  assert.equal(classify('a', undefined, 'a'), 'same');
  assert.equal(classify('a', undefined, 'b'), 'ask-missing');
});

test('a moved file: unchanged moves, changed by the user only moves as the user has it, changed by both is asked', () => {
  assert.equal(classifyMoved('a', 'a', 'b'), 'move');
  assert.equal(classifyMoved('a', 'u', 'a'), 'move-keep');
  assert.equal(classifyMoved('a', 'u', 'u'), 'move-keep');
  assert.equal(classifyMoved('a', 'u', 'b'), 'merge');
  assert.equal(classifyMoved('a', undefined, 'b'), 'ask-missing');
});

test('the script’s recommendation: the merge when clean, the user’s side of a clash in text, the new version’s in code', () => {
  assert.equal(recommend('merge', 'AGENTS.md', 0), 'merge');
  assert.equal(recommend('merge', 'AGENTS.md', 1), 'merge-mine');
  assert.equal(recommend('merge', 'src/x.ts', 2), 'merge-new');
  assert.equal(recommend('merge', 'scripts/run-job/run-job.ps1', 1), 'merge-new');
  assert.equal(recommend('ask-delete', 'scripts/old.ps1'), 'new');
  assert.equal(recommend('ask-missing', 'src/x.ts'), 'new');
  assert.equal(recommend('ask-add', 'src/new.ts'), 'new');
  assert.equal(recommend('ask-add', 'CHANGES.md'), 'keep');
});

test('moves are followed across versions: each version after the installed one, in order', () => {
  const tags = ['v7', 'v8', 'v9', 'v10'];
  const moves = { v8: { 'src/a.ts': 'src/x/a.ts', 'src/b.ts': 'src/x/b.ts' }, v9: { 'src/x/a.ts': 'src/y/a.ts' }, v10: { 'src/c.ts': 'src/z/c.ts' } };
  const from7 = movesBetween(moves, tags, 'v7', 'v10');
  assert.equal(from7.get('src/a.ts'), 'src/y/a.ts');
  assert.equal(from7.get('src/b.ts'), 'src/x/b.ts');
  assert.equal(from7.get('src/x/a.ts'), 'src/y/a.ts');
  assert.equal(from7.get('src/c.ts'), 'src/z/c.ts');
  // From v8 the first move is already behind.
  assert.equal(movesBetween(moves, tags, 'v8', 'v10').get('src/a.ts'), undefined);
  assert.equal(movesBetween(moves, tags, 'v8', 'v10').get('src/x/a.ts'), 'src/y/a.ts');
  assert.equal(movesBetween({}, tags, 'v7', 'v10').size, 0);
});

// 없으면 놓치는 실수: git의 v:refname 정렬은 v0.9.0을 v1보다 앞에 두어, 옛 tag(v1~v8) 뒤에 낸 v0.9.0이 최신으로 안 잡히고 v8 사용자는 "이미 최신"이 된다.
test('versions: old one-number tags read as 0.N.0, new ones vX.Y.Z; the newest is found by number', () => {
  assert.deepEqual(parseVersion('v8'), [0, 8, 0]);
  assert.deepEqual(parseVersion('v0.9.0'), [0, 9, 0]);
  assert.deepEqual(parseVersion('0.10.2\n'), [0, 10, 2]);
  assert.equal(parseVersion('v8-rc'), null);
  assert.equal(parseVersion(undefined), null);
  const tags = sortTags(['v0.9.0', 'v1', 'v8', 'v2', 'v0.10.0', 'v0.9.1', 'v7', 'note', 'v1.0.0']);
  assert.deepEqual(tags, ['v1', 'v2', 'v7', 'v8', 'v0.9.0', 'v0.9.1', 'v0.10.0', 'v1.0.0']);
  assert.ok(compareVersions('v0.9.0', 'v8') > 0 && compareVersions('v8', '0.8.0') === 0 && compareVersions('v0.9.0', 'v0.10.0') < 0);
  // A VERSION file says 'v7' or 'v8' (old releases) or 'v0.9.0': the tag of that number, whichever way it is written.
  assert.equal(findTag(tags, 'v8'), 'v8');
  assert.equal(findTag(tags, '0.8.0'), 'v8');
  assert.equal(findTag(tags, 'v0.9.0'), 'v0.9.0');
  assert.equal(findTag(tags, 'v3'), undefined);
  assert.equal(findTag(tags, 'garbage'), undefined);
  assert.equal(versionLabel('v8'), 'v8(0.8.0)');
  assert.equal(versionLabel('v0.9.0'), 'v0.9.0');
  // Moves keys are tag names; old v8 and new v0.9.0 keys are followed in number order.
  const moves = { v8: { 'src/a.ts': 'src/x/a.ts' }, 'v0.9.0': { 'src/x/a.ts': 'src/y/a.ts', 'src/b.ts': 'src/y/b.ts' } };
  assert.equal(movesBetween(moves, ['v0.9.0', 'v7', 'v8'], 'v7', 'v0.9.0').get('src/a.ts'), 'src/y/a.ts');
  assert.equal(movesBetween(moves, ['v0.9.0', 'v7', 'v8'], 'v8', 'v0.9.0').get('src/b.ts'), 'src/y/b.ts');
  assert.equal(movesBetween(moves, ['v0.9.0', 'v7', 'v8'], 'v8', 'v0.9.0').get('src/a.ts'), undefined);
  assert.equal(movesBetween({ '0.9.0': { 'src/b.ts': 'src/z/b.ts' } }, ['v8', 'v0.9.0'], 'v8', 'v0.9.0').get('src/b.ts'), 'src/z/b.ts');
});

/** A repository with the old one-number tags v7 and v8 and the first 0.x tag v0.9.0 after them; user folders as each old version shipped. */
function semverSetup() {
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    }
  };
  const release = (files: Record<string, string>, tag: string, gone: string[] = []) => {
    for (const f of gone) fs.rmSync(path.join(repo, f));
    put(repo, files);
    g('add', '-A');
    g('commit', '-qm', tag);
    g('tag', tag);
  };
  g('init', '-q');
  const v7 = { 'package.json': '{}\n', VERSION: 'v7\n', 'a.txt': 'a7\n', 'src/old.ts': 'old\n' };
  release(v7, 'v7');
  const v8 = { ...v7, VERSION: 'v8\n', 'a.txt': 'a8\n', 'scripts/export/x.ps1': 'export\n', 'scripts/update-moves.json': '{}\n' };
  release(v8, 'v8');
  // 0.9.0 moves src/old.ts and drops the v8 feature's script (deleted, not moved).
  release({ VERSION: 'v0.9.0\n', 'a.txt': 'a9\n', 'src/new/old.ts': 'old\n', 'scripts/update-moves.json': JSON.stringify({ 'v0.9.0': { 'src/old.ts': 'src/new/old.ts' } }) }, 'v0.9.0', ['src/old.ts', 'scripts/export/x.ps1']);
  const userFrom = (files: Record<string, string>) => {
    const user = tempDir();
    put(user, files);
    return user;
  };
  const run = (...a: string[]) => execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'update.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe' });
  return { repo, run, userFrom, v7, v8 };
}

// 없으면 놓치는 실수: VERSION이 'v7'·'v8'인 옛 사용자 폴더가 새 tag v0.9.0을 최신으로 못 보거나 기준을 못 찾아 업데이트가 멈춘다.
test('a v7 or v8 user folder updates to v0.9.0: the base is found from VERSION, v0.9.0 is the newest, its moves are followed', () => {
  const { repo, run, userFrom, v7, v8 } = semverSetup();
  for (const [files, base] of [[v7, 'v7'], [v8, 'v8']] as const) {
    const user = userFrom(files);
    const detect = run('detect', '--user', user, '--repo', repo);
    assert.match(detect, /^최신: v0\.9\.0$/m);
    assert.match(detect, new RegExp(`판별: ${base}\\(0\\.${base.slice(1)}\\.0\\) \\(VERSION 파일\\)`));
    assert.match(detect, new RegExp(`^BASE=${base}$`, 'm'));
    const plan = run('plan', '--user', user, '--repo', repo, '--base', base);
    assert.match(plan, new RegExp(`^기준 ${base}\\(0\\.${base.slice(1)}\\.0\\) → 최신 v0\\.9\\.0$`, 'm'));
    assert.match(plan, /새 자리로 옮김\(사용자가 안 고친 파일, 새 버전 내용으로\): 1개\n {2}- src\/new\/old\.ts \(옛 자리 src\/old\.ts\)/);
    if (base === 'v8') assert.match(plan, /지움\(새 버전에서 없어졌고 사용자가 안 고침\): 1개\n {2}- scripts\/export\/x\.ps1/);
    const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
    run('apply', '--user', user, '--repo', repo, '--base', base, '--work', work);
    assert.equal(fs.readFileSync(path.join(user, 'VERSION'), 'utf8'), 'v0.9.0\n');
    assert.equal(fs.readFileSync(path.join(user, 'src', 'new', 'old.ts'), 'utf8'), 'old\n');
    // Now on v0.9.0 (VERSION 'v0.9.0', or written as '0.9.0'): already the newest.
    assert.match(run('detect', '--user', user, '--repo', repo), /^BASE=v0\.9\.0$/m);
    assert.match(run('plan', '--user', user, '--repo', repo, '--base', '0.9.0'), /기준 v0\.9\.0 → 최신 v0\.9\.0\n이미 최신/);
  }
  // A file list naming an old version finds its tag the same way.
  const listed = userFrom({ ...v8, VERSION: '' });
  fs.rmSync(path.join(listed, 'VERSION'));
  fs.writeFileSync(path.join(listed, LIST_FILE), JSON.stringify({ version: 'v8', files: {} }));
  assert.match(run('detect', '--user', listed, '--repo', repo), /판별: v8\(0\.8\.0\) \(파일 목록 release-files\.json\)\nBASE=v8/);
});

test('line ends and a BOM do not count as a change, and come back in the user style', () => {
  assert.equal(normalize('﻿a\r\nb\r\n'), 'a\nb\n');
  assert.equal(classify(normalize('x\r\n'), normalize('﻿x\n'), normalize('y\n')), 'replace');
  assert.equal(restyle('a\nb\n', 'a\r\n', 'a\n'), 'a\r\nb\r\n');
  assert.equal(restyle('a\n', 'a\n', '﻿a\n'), '﻿a\n');
  assert.equal(restyle('a\n', undefined, 'a\n'), 'a\n');
});

test('personal data, downloads and local settings are never part of an update', () => {
  for (const p of ['secretary.db', 'secretary.db-wal', 'secretary.db.setup.json', 'secretary.db.embedder-failures.log', 'backups/x.db', 'models/a/b.onnx', 'node_modules/x/package.json', '.claude/settings.local.json', 'scripts/my.local.json', '.git/config', 'keys/a.env', '.secretary-id'])
    assert.ok(PROTECTED.test(p), p);
  for (const p of ['AGENTS.md', 'src/store/schema.ts', '.claude/settings.json', 'skills/update/SKILL.md', '.claude/skills/update/SKILL.md', 'VERSION', 'features.json', 'scripts/update-moves.json']) assert.ok(!PROTECTED.test(p), p);
});

/** A repository with tags v7 and v8 (v8 moves some files), and a user folder installed from v7 with edits. */
function setup() {
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    }
  };
  g('init', '-q');
  const v7 = {
    'package.json': '{}\n',
    'AGENTS.md': 'rule 1\nrule 2\nrule 3\n',
    'a.txt': 'a\n',
    'gone.txt': 'g\n',
    'clash.txt': 'one\nA\nB\nC\nend\n',
    'clash2.txt': 'one\nA\nB\nC\nend\n',
    'src/recall.ts': 'const SEM_MARGIN = 0.2;\nconst SPAN = 1;\nexport {};\n',
    'src/ingest.ts': 'ingest\n',
    'src/text.ts': 'text v7\n',
    // Updates start from v7, the first version with VERSION (it says which version the user installed).
    VERSION: 'v7\n',
  };
  put(repo, v7);
  g('add', '-A');
  g('commit', '-qm', 'v7');
  g('tag', 'v7');
  fs.rmSync(path.join(repo, 'gone.txt'));
  for (const f of ['src/recall.ts', 'src/ingest.ts', 'src/text.ts']) fs.rmSync(path.join(repo, f));
  put(repo, {
    'AGENTS.md': 'rule 1\nrule 2\nrule 3\nrule 4\n',
    'a.txt': 'a2\n',
    'new.txt': 'n\n',
    'clash.txt': 'two\nA\nB\nC\nend2\n',
    'clash2.txt': 'two\nA\nB\nC\nend2\n',
    // recall.ts moved and changed elsewhere in the file; ingest.ts moved unchanged; text.ts moved and changed.
    'src/memory/recall.ts': 'const SEM_MARGIN = 0.2;\nconst SPAN = 1;\nexport {};\n// moved\n',
    'src/log/ingest.ts': 'ingest\n',
    'src/memory/text.ts': 'text v8\n',
    'scripts/update-moves.json': JSON.stringify({ v8: { 'src/recall.ts': 'src/memory/recall.ts', 'src/ingest.ts': 'src/log/ingest.ts', 'src/text.ts': 'src/memory/text.ts' } }),
    VERSION: 'v8\n',
  });
  g('add', '-A');
  g('commit', '-qm', 'v8');
  g('tag', 'v8');

  const user = tempDir();
  put(user, {
    ...v7,
    'AGENTS.md': 'my rule\nrule 1\nrule 2\nrule 3\n',
    'clash.txt': 'mine\nA\nB\nC\nend\n',
    'clash2.txt': 'mine\nA\nB\nC\nend\n',
    'src/recall.ts': 'const SEM_MARGIN = 0.15;\nconst SPAN = 1;\nexport {};\n',
    'src/ingest.ts': 'ingest\n',
    'secretary.db': 'DB',
  });
  const script = path.join(PROJECT_ROOT, 'scripts', 'update.mjs');
  const run = (...a: string[]) => execFileSync(process.execPath, [script, ...a], { encoding: 'utf8', stdio: 'pipe' });
  const read = (p: string) => fs.readFileSync(path.join(user, p), 'utf8');
  const has = (p: string) => fs.existsSync(path.join(user, p));
  return { repo, user, run, read, has };
}

test('an update applies what only one side changed and asks about every file both changed, even a clean merge', () => {
  const { repo, user, run, read, has } = setup();
  assert.match(run('detect', '--user', user, '--repo', repo), /BASE=v7/);
  const backup = run('backup', '--user', user);
  const work = /WORK=(.+)/.exec(backup)![1].trim();
  // Run by an older update skill, the newest steps are pointed to.
  assert.match(backup, /이번 업데이트의 순서는 받은 저장소의 스킬에 있어요: .*update.SKILL\.md/);
  assert.equal(fs.readFileSync(path.join(work, 'files', 'AGENTS.md'), 'utf8'), 'my rule\nrule 1\nrule 2\nrule 3\n');
  assert.ok(!fs.existsSync(path.join(work, 'files', 'secretary.db')));

  const plan = run('plan', '--user', user, '--repo', repo, '--base', 'v7');
  assert.match(plan, /새 자리로 옮김\(사용자가 안 고친 파일, 새 버전 내용으로\): 2개\n {2}- src\/log\/ingest\.ts \(옛 자리 src\/ingest\.ts\)\n {2}- src\/memory\/text\.ts \(옛 자리 src\/text\.ts\)/);
  assert.match(plan, /src\/memory\/recall\.ts \(옛 자리 src\/recall\.ts\)/);

  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v7', '--work', work);
  // One side only: done.
  assert.equal(read('a.txt'), 'a2\n');
  assert.equal(read('new.txt'), 'n\n');
  assert.equal(read('VERSION'), 'v8\n');
  assert.ok(!has('gone.txt'));
  assert.equal(read('src/log/ingest.ts'), 'ingest\n');
  assert.ok(!has('src/ingest.ts'), 'an unchanged moved file leaves its old place');
  assert.equal(read('src/memory/text.ts'), 'text v8\n');
  assert.equal(read('secretary.db'), 'DB');
  // The install id: a folder from before it (v7) gets one at the end of apply, said in the output.
  const id = read(ID_FILE).trim();
  assert.match(id, /^[A-Z0-9]{4}$/);
  assert.ok(out.includes(`비서 고유 번호: ${id} (새로 만듦, .secretary-id)`));
  assert.match(out, /옛 이름 작업은 "올린 뒤 할 일"대로 새 이름으로 옮긴다/);
  // Both sides: nothing written yet, even where the merge is clean (AGENTS.md, the moved recall.ts).
  assert.equal(read('AGENTS.md'), 'my rule\nrule 1\nrule 2\nrule 3\n');
  assert.ok(has('src/recall.ts') && !has('src/memory/recall.ts'), 'the moved file waits at its old place');
  assert.match(out, /남은 부딪힘: 4개/);
  assert.match(out, /- AGENTS\.md · [^\n]*깨끗이 합쳐짐[^\n]*고를 것: keep\/new\/merge\/edited · 추천: merge · 사용자 수정: /);
  assert.match(out, /- clash\.txt · [^\n]*부딪힌 곳 1군데[^\n]*고를 것: keep\/new\/merge-mine\/merge-new\/edited · 추천: merge-mine/);
  assert.match(out, /- src\/memory\/recall\.ts \(옛 자리 src\/recall\.ts\) · [^\n]*깨끗이 합쳐짐/);
  assert.equal(fs.readFileSync(path.join(work, 'merged', 'AGENTS.md'), 'utf8'), 'my rule\nrule 1\nrule 2\nrule 3\nrule 4\n');
  assert.equal(fs.readFileSync(path.join(work, 'merged', 'src', 'memory', 'recall.ts'), 'utf8'), 'const SEM_MARGIN = 0.15;\nconst SPAN = 1;\nexport {};\n// moved\n');
  assert.match(fs.readFileSync(path.join(work, 'user-diffs', 'src', 'memory', 'recall.ts.diff'), 'utf8'), /^diff src\/recall\.ts\n--- 받았던 버전\/src\/recall\.ts\n\+\+\+ 지금 사용자 파일\/src\/recall\.ts\n@@[^\n]*\n-const SEM_MARGIN = 0\.2;\n\+const SEM_MARGIN = 0\.15;/);
  assert.match(fs.readFileSync(path.join(work, 'conflicts', 'clash.txt'), 'utf8'), /^<<<<<<< 내 것\nmine\n=======\ntwo\n>>>>>>> 새 버전\nA\nB\nC\nend2\n$/);

  // Keep, overwrite, mix.
  assert.throws(() => run('resolve', '--user', user, '--work', work, '--file', 'clash.txt', '--take', 'edited'), /표시/);
  assert.throws(() => run('resolve', '--user', user, '--work', work, '--file', 'clash.txt', '--take', 'merge'), /고를 수 없어요/);
  assert.match(run('resolve', '--user', user, '--work', work, '--file', 'AGENTS.md', '--take', 'keep'), /정리함: AGENTS\.md → keep/);
  assert.equal(read('AGENTS.md'), 'my rule\nrule 1\nrule 2\nrule 3\n');
  // A moved file named by its old path, as the user may know it; the mix goes to the new place and the old one goes.
  run('resolve', '--user', user, '--work', work, '--file', 'src\\recall.ts', '--take', 'merge');
  assert.equal(read('src/memory/recall.ts'), 'const SEM_MARGIN = 0.15;\nconst SPAN = 1;\nexport {};\n// moved\n');
  assert.ok(!has('src/recall.ts'));
  // v7's update skill says "mine": the user's side of the clash, the rest of the merge.
  run('resolve', '--user', user, '--work', work, '--file', 'clash.txt', '--take', 'mine');
  assert.equal(read('clash.txt'), 'mine\nA\nB\nC\nend2\n');
  // The rest as recommended.
  assert.match(run('resolve', '--user', user, '--work', work, '--rest'), /추천대로 정함: clash2\.txt → merge-mine\n남은 부딪힘: 없음/);
  assert.equal(read('clash2.txt'), 'mine\nA\nB\nC\nend2\n');
  assert.match(run('detect', '--user', user, '--repo', repo), /BASE=v8/);
  assert.match(run('plan', '--user', user, '--repo', repo, '--base', 'v8'), /이미 최신/);
});

test('a folder without VERSION or file list (before v7, or VERSION deleted) is not guessed: the user is asked', () => {
  const { repo, user, run } = setup();
  fs.rmSync(path.join(user, 'VERSION'));
  const out = run('detect', '--user', user, '--repo', repo);
  assert.match(out, /판별: 못 함 \(VERSION 파일도 파일 목록도 없음\)\. 이 업데이트는 v7부터 올린다[^\n]*있는 tag: v7, v8\)/);
  assert.match(out, /^BASE=$/m);
  assert.match(out, /^CLEAR=no$/m);
  assert.doesNotMatch(out, /일치/);
  // A VERSION naming no tag is not taken either.
  fs.writeFileSync(path.join(user, 'VERSION'), 'v3\n');
  assert.match(run('detect', '--user', user, '--repo', repo), /판별: 못 함 \(VERSION 파일의 v3이 tag에 없고 파일 목록도 없음\)/);
});

test('the install id is kept: an update never replaces it, and one in lower case is written again in upper case', () => {
  const { repo, user, run, read } = setup();
  fs.writeFileSync(path.join(user, ID_FILE), 'my01\r\n');
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v7', '--work', work);
  assert.equal(read(ID_FILE), 'MY01\n');
  assert.match(out, /비서 고유 번호: MY01 \(그대로, \.secretary-id\)/);
  assert.deepEqual(ensureId(user), { id: 'MY01', created: false });
  // Same letters as src/setup/install-id.ts (the secretary makes the same kind of id).
  assert.equal(ID_ALPHABET, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
});

test('overwrite takes the new version whole; a moved file the user changed alone moves as it is', () => {
  const { repo, user, run, read, has } = setup();
  // The user changed text.ts too; the new version changed it as well (both sides) — overwrite it.
  fs.writeFileSync(path.join(user, 'src', 'text.ts'), 'text mine\n');
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  run('apply', '--user', user, '--repo', repo, '--base', 'v7', '--work', work);
  assert.ok(has('src/text.ts'), 'asked first');
  run('resolve', '--user', user, '--work', work, '--file', 'src/memory/text.ts', '--take', 'new');
  assert.equal(read('src/memory/text.ts'), 'text v8\n');
  assert.ok(!has('src/text.ts'));
  // keep on a moved file: the user's own text at the new place.
  run('resolve', '--user', user, '--work', work, '--file', 'src/memory/recall.ts', '--take', 'keep');
  assert.equal(read('src/memory/recall.ts'), 'const SEM_MARGIN = 0.15;\nconst SPAN = 1;\nexport {};\n');
  assert.ok(!has('src/recall.ts'));
});

test('the file list hash is the same as the release builder writes it (src/setup/release-files.ts)', () => {
  for (const s of ['﻿a\r\nb\r\n', 'a\nb\n', '한글\n', '']) assert.equal(fileHash(Buffer.from(s, 'utf8')), releaseHash(Buffer.from(s, 'utf8')), JSON.stringify(s));
  assert.equal(fileHash(Buffer.from('﻿a\r\n', 'utf8')), fileHash(Buffer.from('a\n', 'utf8')));
  const binary = Buffer.from([0, 1, 13, 10, 255]);
  assert.equal(fileHash(binary), releaseHash(binary));
  // A file still matching the list was not changed by the user, whatever the tag has.
  const listHash = fileHash(Buffer.from('rebuilt\n'));
  assert.equal(baseFor(Buffer.from('tag\n'), Buffer.from('rebuilt\r\n'), listHash).byList, true);
  assert.equal(baseFor(Buffer.from('tag\n'), Buffer.from('mine\n'), listHash).byList, false);
  assert.equal(baseFor(Buffer.from('tag\n'), Buffer.from('tag\n'), fileHash(Buffer.from('tag\n'))).byList, false);
  assert.equal(baseFor(undefined, Buffer.from('rebuilt\n'), listHash).byList, true);
});

test('with the user’s file list a file the tag has otherwise is not taken for a user change; the list itself always comes new', () => {
  const { repo, user, run, read } = setup();
  // The user got a v7 built a little differently from tag v7: a.txt and gone.txt were other bytes. The list says so.
  fs.writeFileSync(path.join(user, 'a.txt'), 'a rebuilt\n');
  fs.writeFileSync(path.join(user, 'gone.txt'), 'g rebuilt\n');
  const hashOf = (p: string) => fileHash(fs.readFileSync(path.join(user, p)));
  fs.writeFileSync(path.join(user, LIST_FILE), JSON.stringify({ version: 'v7', files: Object.fromEntries(['a.txt', 'gone.txt', 'package.json'].map((p) => [p, hashOf(p)])) }));
  // Without VERSION the list's version decides; the detect line counts what the user changed by hash.
  fs.rmSync(path.join(user, 'VERSION'));
  const detect = run('detect', '--user', user, '--repo', repo);
  assert.match(detect, /판별: v7\(0\.7\.0\) \(파일 목록 release-files\.json\)/);
  assert.match(detect, /파일 목록\(release-files\.json\): v7, 목록 3개 중 사용자가 고친 것 0개, 지운 것 0개/);
  const plan = run('plan', '--user', user, '--repo', repo, '--base', 'v7');
  // a.txt: the new version's, not a question; gone.txt: deleted, not a question.
  assert.match(plan, /새 버전으로 바꿈\(사용자가 안 고친 파일\): \d+개\n(?: {2}- [^\n]+\n)*? {2}- a\.txt\n/);
  assert.match(plan, /지움\(새 버전에서 없어졌고 사용자가 안 고침\): 1개\n {2}- gone\.txt/);
  assert.match(plan, /파일 목록\(release-files\.json\) 해시로 사용자가 안 고친 것으로 본 파일: 2개/);
  // Without the list the same files are questions.
  fs.renameSync(path.join(user, LIST_FILE), path.join(user, 'list.bak'));
  const without = run('plan', '--user', user, '--repo', repo, '--base', 'v7');
  assert.match(without, /물어볼 것: 사용자도 새 버전도 고침[^\n]*\n(?: {2}- [^\n]+\n)*? {2}- a\.txt\n/);
  assert.match(without, /물어볼 것: 새 버전에서 지운 파일을 사용자가 고쳤음[^\n]*\n {2}- gone\.txt/);
  fs.renameSync(path.join(user, 'list.bak'), path.join(user, LIST_FILE));
  // A list in the new version replaces the user's (never asked) and is not taken for a user file.
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  fs.writeFileSync(path.join(repo, LIST_FILE), JSON.stringify({ version: 'v9', files: {} }));
  g('add', '-A');
  g('commit', '-qm', 'v9');
  g('tag', 'v9');
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v7', '--work', work);
  assert.doesNotMatch(out, /- release-files\.json ·/);
  assert.equal(JSON.parse(read(LIST_FILE)).version, 'v9');
  assert.equal(read('a.txt'), 'a2\n');
});

/**
 * A made-up chain of all three skill layouts: v7 kept skills as real folders in .claude/skills/; "v8" here is the
 * layout of the unreleased v8 trial build (skills/ with a link per skill there and in .agents/skills/); "v9" here keeps
 * them as real folders in .agents/skills/ with .claude/skills one link to it, as the released v8 does (its own v7 path is
 * the last test here).
 */
function skillSetup() {
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    }
  };
  g('init', '-q');
  const v7 = {
    'package.json': '{}\n',
    VERSION: 'v7\n',
    '.claude/skills/delegate/SKILL.md': 'delegate 1\nA\nB\nC\nend\n',
    '.claude/skills/grill/SKILL.md': 'grill 1\n',
    '.claude/skills/update/SKILL.md': 'update 1\nA\nB\nC\nend\n',
  };
  put(repo, v7);
  g('add', '-A');
  g('commit', '-qm', 'v7');
  g('tag', 'v7');
  fs.rmSync(path.join(repo, '.claude'), { recursive: true });
  const v8Moves = { '.claude/skills/delegate/SKILL.md': 'skills/delegate/SKILL.md', '.claude/skills/grill/SKILL.md': 'skills/grill/SKILL.md', '.claude/skills/update/SKILL.md': 'skills/update/SKILL.md' };
  const v8 = {
    'package.json': '{}\n',
    VERSION: 'v8\n',
    'skills/delegate/SKILL.md': 'delegate 1\nA\nB\nC\nend\n',
    'skills/grill/SKILL.md': 'grill 2\n',
    'skills/update/SKILL.md': 'update 2\nA\nB\nC\nend\n',
    'skills/features/SKILL.md': 'features\n',
  };
  put(repo, { ...v8, 'scripts/update-moves.json': JSON.stringify({ v8: v8Moves }) });
  g('add', '-A');
  g('commit', '-qm', 'v8');
  g('tag', 'v8');
  fs.rmSync(path.join(repo, 'skills'), { recursive: true });
  const v9Moves = Object.fromEntries(['delegate', 'grill', 'update', 'features'].map((n) => [`skills/${n}/SKILL.md`, `.agents/skills/${n}/SKILL.md`]));
  put(repo, {
    VERSION: 'v9\n',
    '.agents/skills/delegate/SKILL.md': 'delegate 1\nA\nB\nC\nend\n',
    '.agents/skills/grill/SKILL.md': 'grill 2\n',
    '.agents/skills/update/SKILL.md': 'update 3\nA\nB\nC\nend\n',
    '.agents/skills/features/SKILL.md': 'features\n',
    'scripts/update-moves.json': JSON.stringify({ v8: v8Moves, v9: v9Moves }),
  });
  g('add', '-A');
  g('commit', '-qm', 'v9');
  g('tag', 'v9');
  const user = tempDir();
  const script = path.join(PROJECT_ROOT, 'scripts', 'update.mjs');
  const run = (...a: string[]) => execFileSync(process.execPath, [script, ...a], { encoding: 'utf8', stdio: 'pipe' });
  const read = (p: string) => fs.readFileSync(path.join(user, p), 'utf8');
  const isLink = (p: string) => fs.lstatSync(path.join(user, p)).isSymbolicLink();
  const link = (p: string, target: string) => {
    fs.mkdirSync(path.dirname(path.join(user, p)), { recursive: true });
    fs.symlinkSync(target, path.join(user, p), 'junction');
  };
  return { repo, user, run, read, isLink, link, put, v7, v8 };
}

test('from v7 the skills move to .agents/skills/ (the user’s edits and skills too) and .claude/skills becomes one link, in the same command', () => {
  const { repo, user, run, read, isLink, put, v7 } = skillSetup();
  put(user, {
    ...v7,
    // Changed by the user only; changed by both (asked); a skill the user made; a file the user added to a secretary skill.
    '.claude/skills/delegate/SKILL.md': 'delegate mine\nA\nB\nC\nend\n',
    '.claude/skills/update/SKILL.md': 'update 1\nA\nB\nC\nend mine\n',
    '.claude/skills/mine/SKILL.md': 'my skill\n',
    '.claude/skills/mine/references/x.md': 'my ref\n',
    '.claude/skills/grill/notes.md': 'my note\n',
    // Ego Lite's own skill, a real folder there: it moves with the rest.
    '.claude/skills/ego-browser/SKILL.md': 'ego\n',
  });
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v7', '--work', work);
  // The secretary's skills at their new place: the user's edit kept, the new version's change in.
  assert.equal(read('.agents/skills/delegate/SKILL.md'), 'delegate mine\nA\nB\nC\nend\n');
  assert.equal(read('.agents/skills/grill/SKILL.md'), 'grill 2\n');
  assert.equal(read('.agents/skills/features/SKILL.md'), 'features\n');
  // What v7 did not ship moves too: the user's own skill and the file the user added.
  assert.equal(read('.agents/skills/mine/SKILL.md'), 'my skill\n');
  assert.equal(read('.agents/skills/mine/references/x.md'), 'my ref\n');
  assert.equal(read('.agents/skills/grill/notes.md'), 'my note\n');
  assert.equal(read('.agents/skills/ego-browser/SKILL.md'), 'ego\n');
  // Both changed: asked; meanwhile the user's file waits at the new place, as the user has it.
  assert.equal(read('.agents/skills/update/SKILL.md'), 'update 1\nA\nB\nC\nend mine\n');
  assert.match(out, /- \.agents\/skills\/update\/SKILL\.md \(옛 자리 \.claude\/skills\/update\/SKILL\.md\) · /);
  assert.match(out, /스킬 자리: 옛 자리\(\.claude\/skills\/, skills\/\)에서 \.agents\/skills\/로 옮긴 폴더 \d+개, 파일 4개 \(사용자가 만든 스킬: mine\)/);
  // .claude/skills is the one link to .agents/skills, made in this same command.
  assert.ok(isLink('.claude/skills'));
  assert.ok(!isLink('.agents/skills/delegate'));
  assert.equal(read('.claude/skills/mine/SKILL.md'), 'my skill\n');
  assert.match(out, /만듦: \.claude\/skills → \.agents\/skills/);
  // Settling the asked file at its new place does not delete it through the old path (now reached through the link).
  run('resolve', '--user', user, '--work', work, '--file', '.claude/skills/update/SKILL.md', '--take', 'merge');
  assert.equal(read('.agents/skills/update/SKILL.md'), 'update 3\nA\nB\nC\nend mine\n');
  assert.ok(isLink('.claude/skills'));
  // Run again from v9: nothing to move, the link stays. (The work folder is named to the minute: the first one goes.)
  fs.rmSync(work, { recursive: true });
  const work2 = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  assert.ok(!fs.existsSync(path.join(work2, 'files', '.claude', 'skills', 'update')), 'the folder copy does not go through links');
  const again = run('apply', '--user', user, '--repo', repo, '--base', 'v9', '--work', work2);
  assert.doesNotMatch(again, /스킬 자리:/);
  assert.match(again, /스킬 연결: 모두 맞음/);
});

test('from v8 the per-skill links go and skills/ moves to .agents/skills/, Ego Lite’s link with it', () => {
  const { repo, user, run, read, isLink, link, put, v8 } = skillSetup();
  put(user, {
    ...v8,
    'skills/delegate/SKILL.md': 'delegate mine\nA\nB\nC\nend\n',
    'skills/mine/SKILL.md': 'my skill\n',
    '.gitignore': '/.claude/skills/\n/.agents/skills/\n/skills/ego-browser\n',
  });
  const vendor = tempDir();
  fs.writeFileSync(path.join(vendor, 'SKILL.md'), 'ego\n');
  link('skills/ego-browser', vendor);
  // What v8's skill-links made: a link per skill in both CLI folders.
  for (const dir of ['.claude/skills', '.agents/skills']) for (const n of ['delegate', 'grill', 'update', 'features', 'mine', 'ego-browser']) link(`${dir}/${n}`, path.join(user, 'skills', n));
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v8', '--work', work);
  assert.ok(!fs.existsSync(path.join(user, 'skills')), 'the old folder is gone');
  assert.ok(isLink('.claude/skills'));
  for (const n of ['delegate', 'grill', 'update', 'features', 'mine']) assert.ok(!isLink(`.agents/skills/${n}`), `${n}: a real folder`);
  assert.equal(read('.agents/skills/delegate/SKILL.md'), 'delegate mine\nA\nB\nC\nend\n');
  assert.equal(read('.agents/skills/update/SKILL.md'), 'update 3\nA\nB\nC\nend\n');
  assert.equal(read('.agents/skills/mine/SKILL.md'), 'my skill\n');
  assert.ok(isLink('.agents/skills/ego-browser') && read('.claude/skills/ego-browser/SKILL.md') === 'ego\n');
  assert.ok(fs.existsSync(path.join(vendor, 'SKILL.md')), 'what the link pointed at is not touched');
  assert.match(out, /사용자가 만든 스킬: mine/);
  assert.match(read('.gitignore'), /^\/\.agents\/skills\/common-\*$/m);
});

// 없으면 놓치는 실수: 다시 만든 v8(스킬이 .agents/skills)로 v7에서 바로 올릴 때 옮김 표가 그 v8 칸에서 스킬을 새 자리로 잇지 못하면, 사용자가 고친 스킬이 '새 버전에서 지운 파일'로 물어지고 추천(new)대로 하면 고친 내용이 빠진다.
test('from v7 straight to v8 (skills in .agents/skills/): the v8 moves take each skill to its new place, the user’s edit along', () => {
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    }
  };
  g('init', '-q');
  const v7 = { 'package.json': '{}\n', VERSION: 'v7\n', '.claude/skills/delegate/SKILL.md': 'delegate 1\nA\nB\nC\nend\n', '.claude/skills/grill/SKILL.md': 'grill 1\n' };
  put(repo, v7);
  g('add', '-A');
  g('commit', '-qm', 'v7');
  g('tag', 'v7');
  fs.rmSync(path.join(repo, '.claude'), { recursive: true });
  const moves = { v8: Object.fromEntries(['delegate', 'grill'].map((n) => [`.claude/skills/${n}/SKILL.md`, `.agents/skills/${n}/SKILL.md`])) };
  put(repo, { VERSION: 'v8\n', '.agents/skills/delegate/SKILL.md': 'delegate 1\nA\nB\nC\nend\n', '.agents/skills/grill/SKILL.md': 'grill 2\n', 'scripts/update-moves.json': JSON.stringify(moves) });
  g('add', '-A');
  g('commit', '-qm', 'v8');
  g('tag', 'v8');
  const user = tempDir();
  put(user, { ...v7, '.claude/skills/delegate/SKILL.md': 'delegate mine\nA\nB\nC\nend\n' });
  const run = (...a: string[]) => execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'update.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe' });
  const plan = run('plan', '--user', user, '--repo', repo, '--base', 'v7');
  assert.doesNotMatch(plan, /새 버전에서 지운 파일을 사용자가 고쳤음/);
  assert.match(plan, /\.agents\/skills\/delegate\/SKILL\.md \(옛 자리 \.claude\/skills\/delegate\/SKILL\.md\)/);
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  run('apply', '--user', user, '--repo', repo, '--base', 'v7', '--work', work);
  const read = (p: string) => fs.readFileSync(path.join(user, p), 'utf8');
  assert.equal(read('.agents/skills/delegate/SKILL.md'), 'delegate mine\nA\nB\nC\nend\n');
  assert.equal(read('.agents/skills/grill/SKILL.md'), 'grill 2\n');
  assert.ok(fs.lstatSync(path.join(user, '.claude', 'skills')).isSymbolicLink());
});