import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain .mjs script without types
import { ID_ALPHABET, ID_FILE, LIST_FILE, MIN_BASE, PROTECTED, baseFor, carryFeatureStates, ensureId, classify, classifyMoved, compareVersions, fileHash, findTag, keyMerged, mergeJson, mergeJsonText, movesBetween, normalize, parseVersion, recommend, removeFile, restyle, sortTags } from '../scripts/update.mjs';
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
  // A settings JSON: the key-by-key merge, or the user's side of the clash when it does not read as JSON; npm's files the new version's.
  assert.equal(recommend('merge', 'common-skills.json', 1, true), 'merge');
  assert.equal(recommend('merge', '.claude/settings.json', 1), 'merge-mine');
  assert.equal(recommend('merge', 'package.json', 1), 'merge-new');
  assert.equal(recommend('merge', 'package-lock.json', 3), 'merge-new');
  assert.ok(keyMerged('scripts/lib/providers.json') && keyMerged('package.json') && !keyMerged('package-lock.json') && !keyMerged('src/x.ts'));
});

test('moves are followed across versions: each version after the installed one, in order', () => {
  const tags = ['v0.11.0', 'v0.12.0', 'v0.13.0', 'v0.14.0'];
  const moves = { 'v0.12.0': { 'src/a.ts': 'src/x/a.ts', 'src/b.ts': 'src/x/b.ts' }, 'v0.13.0': { 'src/x/a.ts': 'src/y/a.ts' }, 'v0.14.0': { 'src/c.ts': 'src/z/c.ts' } };
  const from11 = movesBetween(moves, tags, 'v0.11.0', 'v0.14.0');
  assert.equal(from11.get('src/a.ts'), 'src/y/a.ts');
  assert.equal(from11.get('src/b.ts'), 'src/x/b.ts');
  assert.equal(from11.get('src/x/a.ts'), 'src/y/a.ts');
  assert.equal(from11.get('src/c.ts'), 'src/z/c.ts');
  // From v0.12.0 the first move is already behind.
  assert.equal(movesBetween(moves, tags, 'v0.12.0', 'v0.14.0').get('src/a.ts'), undefined);
  assert.equal(movesBetween(moves, tags, 'v0.12.0', 'v0.14.0').get('src/x/a.ts'), 'src/y/a.ts');
  assert.equal(movesBetween({}, tags, 'v0.11.0', 'v0.14.0').size, 0);
});

// 없으면 놓치는 실수: 이름 순서로 줄 세우면 v0.100.0이 v0.12.0보다 앞에 와 최신을 잘못 잡거나, VERSION이 '0.11.0'처럼 v 없이 적힌 폴더의 기준 tag를 못 찾는다.
test('versions: vX.Y.Z by number; the newest is found by number, a VERSION with or without the v finds its tag', () => {
  assert.deepEqual(parseVersion('v0.11.0'), [0, 11, 0]);
  assert.deepEqual(parseVersion('0.11.2\n'), [0, 11, 2]);
  assert.equal(parseVersion('v8'), null);
  assert.equal(parseVersion('v0.11.0-rc'), null);
  assert.equal(parseVersion(undefined), null);
  const tags = sortTags(['v0.100.0', 'v0.12.0', 'v0.11.0', 'v0.11.1', 'note', 'v1.0.0']);
  assert.deepEqual(tags, ['v0.11.0', 'v0.11.1', 'v0.12.0', 'v0.100.0', 'v1.0.0']);
  assert.ok(compareVersions('v0.12.0', 'v0.11.0') > 0 && compareVersions('v0.11.0', '0.11.0') === 0 && compareVersions('v0.11.0', 'v0.11.1') < 0);
  assert.equal(findTag(tags, 'v0.11.0'), 'v0.11.0');
  assert.equal(findTag(tags, '0.12.0'), 'v0.12.0');
  assert.equal(findTag(tags, 'v0.13.0'), undefined);
  assert.equal(findTag(tags, 'garbage'), undefined);
  assert.equal(MIN_BASE, 'v0.11.0');
  // A moves key in the other spelling ("0.12.0" for tag v0.12.0) is followed too.
  assert.equal(movesBetween({ '0.12.0': { 'src/b.ts': 'src/z/b.ts' } }, ['v0.11.0', 'v0.12.0'], 'v0.11.0', 'v0.12.0').get('src/b.ts'), 'src/z/b.ts');
});

/** A repository with tags v0.10.0 (older than updates start from), v0.11.0 and v0.12.0; user folders as each version shipped. */
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
  const v10 = { 'package.json': '{}\n', VERSION: 'v0.10.0\n', 'a.txt': 'a9\n' };
  release(v10, 'v0.10.0');
  const v11 = { ...v10, VERSION: 'v0.11.0\n', 'a.txt': 'a10\n', 'src/old.ts': 'old\n', 'scripts/export/x.ps1': 'export\n', 'scripts/update-moves.json': '{}\n' };
  release(v11, 'v0.11.0');
  // 0.12.0 moves src/old.ts and drops a feature's script (deleted, not moved).
  release({ VERSION: 'v0.12.0\n', 'a.txt': 'a11\n', 'src/new/old.ts': 'old\n', 'scripts/update-moves.json': JSON.stringify({ 'v0.12.0': { 'src/old.ts': 'src/new/old.ts' } }) }, 'v0.12.0', ['src/old.ts', 'scripts/export/x.ps1']);
  const userFrom = (files: Record<string, string>) => {
    const user = tempDir();
    put(user, files);
    return user;
  };
  const run = (...a: string[]) => execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'update.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe' });
  return { repo, run, userFrom, v10, v11 };
}

// 없으면 놓치는 실수: VERSION이 v0.11.0인 사용자 폴더가 새 tag를 최신으로 못 보거나 기준을 못 찾아 업데이트가 멈춘다. 또는 업데이트가 받지 않는 옛 버전(v0.11.0보다 옛것)을 기준으로 올려 그 사이 옮김·옛 이름 처리 없이 파일이 섞인다.
test('a v0.11.0 user folder updates: the base is found from VERSION, the newest tag and its moves are followed; an older folder is not taken', () => {
  const { repo, run, userFrom, v10, v11 } = semverSetup();
  const user = userFrom(v11);
  const detect = run('detect', '--user', user, '--repo', repo);
  assert.match(detect, /^최신: v0\.12\.0$/m);
  assert.match(detect, /판별: v0\.11\.0 \(VERSION 파일\)/);
  assert.match(detect, /^BASE=v0\.11\.0$/m);
  const plan = run('plan', '--user', user, '--repo', repo, '--base', 'v0.11.0');
  assert.match(plan, /^기준 v0\.11\.0 → 최신 v0\.12\.0$/m);
  assert.match(plan, /새 자리로 옮김\(사용자가 안 고친 파일, 새 버전 내용으로\): 1개\n {2}- src\/new\/old\.ts \(옛 자리 src\/old\.ts\)/);
  assert.match(plan, /지움\(새 버전에서 없어졌고 사용자가 안 고침\): 1개\n {2}- scripts\/export\/x\.ps1/);
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  run('apply', '--user', user, '--repo', repo, '--base', 'v0.11.0', '--work', work);
  assert.equal(fs.readFileSync(path.join(user, 'VERSION'), 'utf8'), 'v0.12.0\n');
  assert.equal(fs.readFileSync(path.join(user, 'src', 'new', 'old.ts'), 'utf8'), 'old\n');
  // Now on v0.12.0 (VERSION 'v0.12.0', or written as '0.12.0'): already the newest.
  assert.match(run('detect', '--user', user, '--repo', repo), /^BASE=v0\.12\.0$/m);
  assert.match(run('plan', '--user', user, '--repo', repo, '--base', '0.12.0'), /기준 v0\.12\.0 → 최신 v0\.12\.0\n이미 최신/);
  // Older than v0.11.0: not guessed, not planned.
  const old = userFrom(v10);
  const refused = run('detect', '--user', old, '--repo', repo);
  assert.match(refused, /판별: 못 함 \(VERSION 파일의 v0\.10\.0은 v0\.11\.0보다 옛 버전\)\. 이 업데이트는 v0\.11\.0부터 올린다/);
  assert.match(refused, /^BASE=$/m);
  assert.match(refused, /^CLEAR=no$/m);
  assert.throws(() => run('plan', '--user', old, '--repo', repo, '--base', 'v0.10.0'), /v0\.11\.0보다 옛 버전/);
  // A one-number VERSION of the first releases is no version at all.
  fs.writeFileSync(path.join(old, 'VERSION'), 'v8\n');
  assert.match(run('detect', '--user', old, '--repo', repo), /판별: 못 함 \(VERSION 파일의 v8이 tag에 없음\)/);
});

// 없으면 놓치는 실수: 공개는 고른 버전만 해서(v0.12.0 다음 v0.14.0) 옮김 칸이 tag 없는 버전(v0.13.0)에 적히면, tag만 따라가던 업데이트가 그 옮김을 건너뛰어 사용자가 고친 파일이 '지울지 물을 것'과 '새 파일'로 갈라진다.
test('skipping versions: moves of versions without a tag are followed in order, up to the newest only', () => {
  const tags = ['v0.11.0', 'v0.12.0', 'v0.14.0'];
  const moves = { 'v0.12.0': { 'src/c.ts': 'src/d.ts' }, '0.13.0': { 'src/a.ts': 'src/b.ts' }, 'v0.13.1': { 'src/b.ts': 'src/e.ts' }, 'v0.15.0': { 'src/e.ts': 'src/f.ts' } };
  const m = movesBetween(moves, tags, 'v0.11.0', 'v0.14.0');
  assert.equal(m.get('src/a.ts'), 'src/e.ts', '0.13.0 then v0.13.1, neither tagged');
  assert.equal(m.get('src/c.ts'), 'src/d.ts');
  assert.equal(m.size, 3, 'nothing past the newest tag (v0.15.0)');
  assert.equal(movesBetween(moves, tags, 'v0.12.0', 'v0.14.0').get('src/c.ts'), undefined, 'behind the base');
  assert.equal(movesBetween(moves, tags, 'v0.12.0', 'v0.14.0').get('src/b.ts'), 'src/e.ts');

  const { repo, run, userFrom, v11 } = semverSetup();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  // Published after v0.12.0: v0.14.0, with v0.13.0's move written under the untagged v0.13.0.
  const allMoves = { 'v0.12.0': { 'src/old.ts': 'src/new/old.ts' }, 'v0.13.0': { 'src/new/old.ts': 'src/thirteen/old.ts' } };
  fs.rmSync(path.join(repo, 'src', 'new', 'old.ts'));
  fs.mkdirSync(path.join(repo, 'src', 'thirteen'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'thirteen', 'old.ts'), 'old\nnew line\n');
  fs.writeFileSync(path.join(repo, 'VERSION'), 'v0.14.0\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'update-moves.json'), JSON.stringify(allMoves));
  g('add', '-A');
  g('commit', '-qm', 'v0.14.0');
  g('tag', 'v0.14.0');
  const user = userFrom({ ...v11, 'src/old.ts': 'old (mine)\n' });
  const plan = run('plan', '--user', user, '--repo', repo, '--base', 'v0.11.0');
  assert.match(plan, /기준 v0\.11\.0 → 최신 v0\.14\.0/);
  assert.match(plan, /src\/thirteen\/old\.ts \(옛 자리 src\/old\.ts\)/, 'the user’s edit follows both moves, the untagged one too');
  assert.doesNotMatch(plan, /물어볼 것: 새 버전에서 지운 파일/);
});

// 없으면 놓치는 실수: 옮김 표의 새 자리가 이 판에 없으면 업데이트가 사용자가 고친 옛 파일을 옮기지 못하고 '지울지 물을 것'으로 묻는다. 또는 이 판 VERSION보다 뒤 칸에 적은 옮김은 받은 저장소에 그 tag가 없어 쓰이지 않는다.
test('every move in update-moves.json lands on a file this version has, in a column after the oldest base (MIN_BASE) up to this version', () => {
  const all = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'update-moves.json'), 'utf8')) as Record<string, Record<string, string>>;
  const version = fs.readFileSync(path.join(PROJECT_ROOT, 'VERSION'), 'utf8').trim();
  assert.match(version, /^v\d+\.\d+\.\d+$/, 'VERSION은 v0.X.Y 꼴(새 tag 이름과 같게)');
  const columns = Object.keys(all).filter((k) => k !== 'about' && k !== 'scheduledTasks').sort(compareVersions);
  for (const k of columns)
    assert.ok(/^v\d+\.\d+\.\d+$/.test(k) && compareVersions(k, MIN_BASE) > 0 && compareVersions(k, version) <= 0, `update-moves.json의 ${k} 칸이 ${MIN_BASE} 다음부터 이 배포판(${version})까지가 아니거나 tag 이름 꼴이 아님`);
  // A later column may move the file again: the place to find now is the end of that chain.
  for (const [i, k] of columns.entries()) {
    for (const [from, to] of Object.entries(all[k])) {
      const now = columns.slice(i + 1).reduce((p, later) => all[later][p] ?? p, to);
      assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, from)), `${from} should be gone now`);
      assert.ok(fs.existsSync(path.join(PROJECT_ROOT, now)), `${from} → ${now} missing`);
    }
  }
});

test('line ends and a BOM do not count as a change, and come back in the user style', () => {
  assert.equal(normalize('﻿a\r\nb\r\n'), 'a\nb\n');
  assert.equal(classify(normalize('x\r\n'), normalize('﻿x\n'), normalize('y\n')), 'replace');
  assert.equal(restyle('a\nb\n', 'a\r\n', 'a\n'), 'a\r\nb\r\n');
  assert.equal(restyle('a\n', 'a\n', '﻿a\n'), '﻿a\n');
  assert.equal(restyle('a\n', undefined, 'a\n'), 'a\n');
});

test('personal data, downloads and local settings are never part of an update', () => {
  for (const p of ['secretary.db', 'secretary.db-wal', 'secretary.db.setup-check.json', 'secretary.db.semantic-search-server-failures.log', 'backups/x.db', 'models/a/b.onnx', 'node_modules/x/package.json', '.claude/settings.local.json', 'scripts/my.local.json', 'this-secretary.local.json', '.git/config', 'keys/a.env', '.secretary-id'])
    assert.ok(PROTECTED.test(p), p);
  // An example of this PC's settings is a release file like any other (this-secretary.local.example.json).
  for (const p of ['AGENTS.md', 'src/store/schema.ts', '.claude/settings.json', '.agents/skills/secretary-update/SKILL.md', 'VERSION', 'features.json', 'scripts/update-moves.json', 'this-secretary.local.example.json']) assert.ok(!PROTECTED.test(p), p);
});

// 없으면 놓치는 실수: 옮기거나 지운 파일의 옛 폴더가 빈 채 남아, SKILL.md 없는 옛 스킬 폴더(.agents/skills/<옛 이름>)가 올린 뒤 설치 점검과 스킬 사양 시험에 걸린다.
test('a removed file takes the folders it leaves empty with it, never one that still holds something', () => {
  const user = tempDir();
  for (const [p, t] of Object.entries({ '.agents/skills/old/references/a.md': 'a', '.agents/skills/old/SKILL.md': 's', '.agents/skills/now/SKILL.md': 'n', 'kept/gone.txt': 'g', 'kept/mine.txt': 'm', 'top.txt': 't' })) {
    fs.mkdirSync(path.dirname(path.join(user, p)), { recursive: true });
    fs.writeFileSync(path.join(user, p), t);
  }
  const has = (p: string) => fs.existsSync(path.join(user, p));
  removeFile(user, '.agents/skills/old/references/a.md');
  assert.ok(!has('.agents/skills/old/references') && has('.agents/skills/old/SKILL.md'), 'the emptied folder goes, its parent with a file stays');
  removeFile(user, '.agents/skills/old/SKILL.md');
  assert.ok(!has('.agents/skills/old') && has('.agents/skills/now/SKILL.md'), 'the old skill folder goes, the one beside it stays');
  removeFile(user, 'kept/gone.txt');
  assert.ok(has('kept/mine.txt'), "a folder with a file of the user's stays");
  removeFile(user, 'top.txt');
  removeFile(user, 'never/was.txt');
  assert.ok(fs.existsSync(user), 'the user folder itself stays');
  // A link on the way up (.claude/skills → .agents/skills) is left alone, its target with it.
  fs.mkdirSync(path.join(user, 'target', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(user, 'target', 'sub', 'f.txt'), 'f');
  fs.symlinkSync(path.join(user, 'target'), path.join(user, 'link'), 'junction');
  removeFile(user, 'link/sub/f.txt');
  assert.ok(has('link') && has('target') && !has('target/sub'), 'the link stays');
});

/** A repository with tags v0.11.0 and v0.12.0 (v0.12.0 moves some files), and a user folder installed from v0.11.0 with edits. */
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
  const v11 = {
    'package.json': '{}\n',
    'AGENTS.md': 'rule 1\nrule 2\nrule 3\n',
    'a.txt': 'a\n',
    'gone.txt': 'g\n',
    'clash.txt': 'one\nA\nB\nC\nend\n',
    'clash2.txt': 'one\nA\nB\nC\nend\n',
    'src/recall.ts': 'const SEM_MARGIN = 0.2;\nconst SPAN = 1;\nexport {};\n',
    'src/ingest.ts': 'ingest\n',
    'src/text.ts': 'text 10\n',
    // VERSION says which version the user installed.
    VERSION: 'v0.11.0\n',
  };
  put(repo, v11);
  g('add', '-A');
  g('commit', '-qm', 'v0.11.0');
  g('tag', 'v0.11.0');
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
    'src/memory/text.ts': 'text 11\n',
    'scripts/update-moves.json': JSON.stringify({ 'v0.12.0': { 'src/recall.ts': 'src/memory/recall.ts', 'src/ingest.ts': 'src/log/ingest.ts', 'src/text.ts': 'src/memory/text.ts' } }),
    VERSION: 'v0.12.0\n',
  });
  g('add', '-A');
  g('commit', '-qm', 'v0.12.0');
  g('tag', 'v0.12.0');

  const user = tempDir();
  put(user, {
    ...v11,
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
  assert.match(run('detect', '--user', user, '--repo', repo), /BASE=v0\.11\.0/);
  const backup = run('backup', '--user', user);
  const work = /WORK=(.+)/.exec(backup)![1].trim();
  // Run by the user folder's older update skill, the newest steps are pointed to.
  assert.match(backup, /이번 업데이트의 순서는 받은 저장소의 스킬에 있어요: .*secretary-update.SKILL\.md/);
  assert.equal(fs.readFileSync(path.join(work, 'files', 'AGENTS.md'), 'utf8'), 'my rule\nrule 1\nrule 2\nrule 3\n');
  assert.ok(!fs.existsSync(path.join(work, 'files', 'secretary.db')));

  const plan = run('plan', '--user', user, '--repo', repo, '--base', 'v0.11.0');
  assert.match(plan, /새 자리로 옮김\(사용자가 안 고친 파일, 새 버전 내용으로\): 2개\n {2}- src\/log\/ingest\.ts \(옛 자리 src\/ingest\.ts\)\n {2}- src\/memory\/text\.ts \(옛 자리 src\/text\.ts\)/);
  assert.match(plan, /src\/memory\/recall\.ts \(옛 자리 src\/recall\.ts\)/);

  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v0.11.0', '--work', work);
  // One side only: done.
  assert.equal(read('a.txt'), 'a2\n');
  assert.equal(read('new.txt'), 'n\n');
  assert.ok(!has('gone.txt'));
  assert.equal(read('src/log/ingest.ts'), 'ingest\n');
  assert.ok(!has('src/ingest.ts'), 'an unchanged moved file leaves its old place');
  assert.equal(read('src/memory/text.ts'), 'text 11\n');
  assert.equal(read('secretary.db'), 'DB');
  // The secretary id: a folder without one gets it at the end of apply, said in the output.
  const id = read(ID_FILE).trim();
  assert.match(id, /^[A-Z0-9]{4}$/);
  assert.ok(out.includes(`비서 고유 번호: ${id} (새로 만듦, .secretary-id)`));
  // Both sides: nothing written yet, even where the merge is clean (AGENTS.md, the moved recall.ts).
  assert.equal(read('AGENTS.md'), 'my rule\nrule 1\nrule 2\nrule 3\n');
  assert.ok(has('src/recall.ts') && !has('src/memory/recall.ts'), 'the moved file waits at its old place');
  assert.match(out, /남은 부딪힘: 4개/);
  assert.match(out, /- AGENTS\.md · [^\n]*깨끗이 합쳐짐[^\n]*고를 것: keep\/new\/merge\/edited · 추천: merge · 사용자 수정: /);
  assert.match(out, /- clash\.txt · [^\n]*부딪힌 곳 1군데[^\n]*고를 것: keep\/new\/merge-mine\/merge-new\/edited · 추천: merge-mine/);
  assert.match(out, /- src\/memory\/recall\.ts \(옛 자리 src\/recall\.ts\) · [^\n]*깨끗이 합쳐짐/);
  // 없으면 놓치는 실수: apply가 VERSION을 먼저 새 버전으로 써서, 묻는 중에 업데이트를 그만두면 다음 업데이트가 새 버전을 기준으로 삼아
  // 답을 못 받은 옛 파일을 "사용자가 고친 것"으로 지킨다.
  assert.equal(read('VERSION'), 'v0.11.0\n', 'the version mark waits while questions are open');
  assert.match(out, /버전 표시 파일\(남은 부딪힘을 모두 정한 뒤 resolve가 새 버전으로 씀[^\n]*\): VERSION/);
  assert.match(run('detect', '--user', user, '--repo', repo), /BASE=v0\.11\.0/, 'stopped here, the next update starts from the old version again');
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
  // The user's side of the clash, the rest of the merge.
  run('resolve', '--user', user, '--work', work, '--file', 'clash.txt', '--take', 'merge-mine');
  assert.equal(read('clash.txt'), 'mine\nA\nB\nC\nend2\n');
  // The rest as recommended.
  assert.equal(read('VERSION'), 'v0.11.0\n');
  assert.match(run('resolve', '--user', user, '--work', work, '--rest'), /추천대로 정함: clash2\.txt → merge-mine\n남은 부딪힘: 없음\n버전 표시 파일\(남은 부딪힘 없음, 새 버전으로 씀\): VERSION/);
  assert.equal(read('clash2.txt'), 'mine\nA\nB\nC\nend2\n');
  assert.equal(read('VERSION'), 'v0.12.0\n');
  assert.match(run('detect', '--user', user, '--repo', repo), /BASE=v0\.12\.0/);
  assert.match(run('plan', '--user', user, '--repo', repo, '--base', 'v0.12.0'), /이미 최신/);
});

test('a folder without VERSION (deleted) or with a version no tag has is not guessed: the user is asked', () => {
  const { repo, user, run } = setup();
  fs.rmSync(path.join(user, 'VERSION'));
  const out = run('detect', '--user', user, '--repo', repo);
  assert.match(out, /판별: 못 함 \(VERSION 파일 없음\)\. 이 업데이트는 v0\.11\.0부터 올린다[^\n]*있는 tag: v0\.11\.0, v0\.12\.0\)/);
  assert.match(out, /^BASE=$/m);
  assert.match(out, /^CLEAR=no$/m);
  assert.doesNotMatch(out, /일치/);
  // A VERSION naming no tag is not taken either.
  fs.writeFileSync(path.join(user, 'VERSION'), 'v0.11.5\n');
  assert.match(run('detect', '--user', user, '--repo', repo), /판별: 못 함 \(VERSION 파일의 v0\.11\.5이 tag에 없음\)/);
});

test('the secretary id is kept: an update never replaces it, and one in lower case is written again in upper case', () => {
  const { repo, user, run, read } = setup();
  fs.writeFileSync(path.join(user, ID_FILE), 'my01\r\n');
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v0.11.0', '--work', work);
  assert.equal(read(ID_FILE), 'MY01\n');
  assert.match(out, /비서 고유 번호: MY01 \(그대로, \.secretary-id\)/);
  assert.deepEqual(ensureId(user), { id: 'MY01', created: false });
  // Same letters as src/core/secretary-id.ts (the secretary makes the same kind of id).
  assert.equal(ID_ALPHABET, 'BCDFGHJKMNPQRSTVWXZ23456789');
});

test('overwrite takes the new version whole; a moved file the user changed alone moves as it is', () => {
  const { repo, user, run, read, has } = setup();
  // The user changed text.ts too; the new version changed it as well (both sides) — overwrite it.
  fs.writeFileSync(path.join(user, 'src', 'text.ts'), 'text mine\n');
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  run('apply', '--user', user, '--repo', repo, '--base', 'v0.11.0', '--work', work);
  assert.ok(has('src/text.ts'), 'asked first');
  run('resolve', '--user', user, '--work', work, '--file', 'src/memory/text.ts', '--take', 'new');
  assert.equal(read('src/memory/text.ts'), 'text 11\n');
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
  // The user got a v0.11.0 built a little differently from tag v0.11.0: a.txt and gone.txt were other bytes. The list says so.
  fs.writeFileSync(path.join(user, 'a.txt'), 'a rebuilt\n');
  fs.writeFileSync(path.join(user, 'gone.txt'), 'g rebuilt\n');
  const hashOf = (p: string) => fileHash(fs.readFileSync(path.join(user, p)));
  fs.writeFileSync(path.join(user, LIST_FILE), JSON.stringify({ version: 'v0.11.0', files: Object.fromEntries(['a.txt', 'gone.txt', 'package.json'].map((p) => [p, hashOf(p)])) }));
  // The detect line counts what the user changed by hash.
  const detect = run('detect', '--user', user, '--repo', repo);
  assert.match(detect, /판별: v0\.11\.0 \(VERSION 파일\)/);
  assert.match(detect, /파일 목록\(release-files\.json\): v0\.11\.0, 목록 3개 중 사용자가 고친 것 0개, 지운 것 0개/);
  const plan = run('plan', '--user', user, '--repo', repo, '--base', 'v0.11.0');
  // a.txt: the new version's, not a question; gone.txt: deleted, not a question.
  assert.match(plan, /새 버전으로 바꿈\(사용자가 안 고친 파일\): \d+개\n(?: {2}- [^\n]+\n)*? {2}- a\.txt\n/);
  assert.match(plan, /지움\(새 버전에서 없어졌고 사용자가 안 고침\): 1개\n {2}- gone\.txt/);
  assert.match(plan, /파일 목록\(release-files\.json\) 해시로 사용자가 안 고친 것으로 본 파일: 2개/);
  // Without the list the same files are questions.
  fs.renameSync(path.join(user, LIST_FILE), path.join(user, 'list.bak'));
  const without = run('plan', '--user', user, '--repo', repo, '--base', 'v0.11.0');
  assert.match(without, /물어볼 것: 사용자도 새 버전도 고침[^\n]*\n(?: {2}- [^\n]+\n)*? {2}- a\.txt\n/);
  assert.match(without, /물어볼 것: 새 버전에서 지운 파일을 사용자가 고쳤음[^\n]*\n {2}- gone\.txt/);
  fs.renameSync(path.join(user, 'list.bak'), path.join(user, LIST_FILE));
  // A list in the new version replaces the user's (never asked) and is not taken for a user file.
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  fs.writeFileSync(path.join(repo, LIST_FILE), JSON.stringify({ version: 'v0.13.0', files: {} }));
  g('add', '-A');
  g('commit', '-qm', 'v0.13.0');
  g('tag', 'v0.13.0');
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v0.11.0', '--work', work);
  assert.doesNotMatch(out, /- release-files\.json ·/);
  // Written once the questions are settled (the version marks come last).
  assert.equal(JSON.parse(read(LIST_FILE)).version, 'v0.11.0');
  run('resolve', '--user', user, '--work', work, '--rest');
  assert.equal(JSON.parse(read(LIST_FILE)).version, 'v0.13.0');
  assert.equal(read('a.txt'), 'a2\n');
});

// Without it: an update writes the new version's copy of an optional feature's skill at the place the release ships it,
// beside the user's own at the other place, or moves the skill of a user who turned the feature on out of reach; or a
// user's edit to the skill is lost.
test('an optional feature’s skill is updated at the place the user’s own features.json gives it (.agents/skills on, .agents/skills-off off)', () => {
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    }
  };
  const features = (enabled: boolean) => `${JSON.stringify({ features: [{ id: 'calendar', enabled, files: ['.agents/skills/calendar/'] }] })}\n`;
  const old = '---\nname: calendar\ndescription: 일정\n---\n# 일정\n\n1. 넣는다\n가\n나\n다\n';
  const now = `${old}2. 확인한다\n`;
  const v11 = { 'package.json': '{}\n', VERSION: 'v0.11.0\n', 'features.json': features(false), '.agents/skills-off/calendar/SKILL.md': old };
  g('init', '-q');
  put(repo, v11);
  g('add', '-A');
  g('commit', '-qm', 'v0.11.0');
  g('tag', 'v0.11.0');
  put(repo, { VERSION: 'v0.12.0\n', '.agents/skills-off/calendar/SKILL.md': now });
  g('add', '-A');
  g('commit', '-qm', 'v0.12.0');
  g('tag', 'v0.12.0');
  const script = path.join(PROJECT_ROOT, 'scripts', 'update.mjs');
  const user = (files: Record<string, string>, gone: string[] = []) => {
    const dir = tempDir();
    put(dir, { ...v11, ...files });
    for (const f of gone) fs.rmSync(path.join(dir, f), { recursive: true });
    const run = (...a: string[]) => execFileSync(process.execPath, [script, ...a], { encoding: 'utf8', stdio: 'pipe' });
    const work = /WORK=(.+)/.exec(run('backup', '--user', dir))![1].trim();
    const out = run('apply', '--user', dir, '--repo', repo, '--base', 'v0.11.0', '--work', work);
    const read = (p: string) => (fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8') : undefined);
    return { dir, out, read, run, work };
  };

  // Off and unchanged: the new copy at the off place, nothing in .agents/skills.
  const a = user({});
  assert.equal(a.read('.agents/skills-off/calendar/SKILL.md'), now);
  assert.ok(!fs.existsSync(path.join(a.dir, '.agents', 'skills', 'calendar')));

  // Off with the user's edit and a file of the user's: the edit is asked about at the off place, the file stays.
  const b = user({ '.agents/skills-off/calendar/SKILL.md': old.replace('1. 넣는다', '1. 넣는다(내 방식)'), '.agents/skills-off/calendar/references/mine.md': '내 메모\n' });
  assert.equal(b.read('.agents/skills-off/calendar/references/mine.md'), '내 메모\n');
  assert.match(b.out, /\.agents\/skills-off\/calendar\/SKILL\.md · [^\n]*깨끗이 합쳐짐/);
  b.run('resolve', '--user', b.dir, '--work', b.work, '--file', '.agents/skills-off/calendar/SKILL.md', '--take', 'merge');
  assert.equal(b.read('.agents/skills-off/calendar/SKILL.md'), now.replace('1. 넣는다', '1. 넣는다(내 방식)'));
  assert.ok(!fs.existsSync(path.join(b.dir, '.agents', 'skills', 'calendar')));

  // Turned on by the user (skill-links moved the folder to .agents/skills): it stays there and gets the new text.
  const c = user({ 'features.json': features(true), '.agents/skills/calendar/SKILL.md': old }, ['.agents/skills-off']);
  assert.equal(c.read('.agents/skills/calendar/SKILL.md'), now);
  assert.ok(!fs.existsSync(path.join(c.dir, '.agents', 'skills-off', 'calendar')));
  assert.match(c.read('features.json')!, /"enabled":true/);
});

// 없으면 놓치는 실수: features.json이 부딪혀 스크립트 추천(merge-new)대로 정하면 사용자가 켠 기능(phone-push)이 꺼진다(v0.11.0 준비 시험에서 나옴).
// 또는 사용자가 손대지 않은 기능까지 옛 값으로 되돌려 새 버전이 바꾼 값을 막거나, 다른 기능의 예약 작업 id를 그 기능으로 잘못 읽는다.
test('what the user turned on or off in features.json stays after any choice; a value left as shipped follows the new version', () => {
  const user = tempDir();
  const work = tempDir();
  // memory-core's task id is "calendar" (an id of another feature before calendar's own entry).
  const entry = (id: string, enabled: boolean | undefined, d = 'd', task = id) =>
    `    {\n      "id": "${id}",\n      "description": "${d} (\\"id\\": \\"x\\" {)",\n${enabled === undefined ? '' : `      "enabled": ${enabled},\n`}      "files": [],\n      "scheduledTasks": [{ "id": "${task}", "name": "x" }]\n    }`;
  const list = (...entries: string[]) => `{\n  "features": [\n${entries.join(',\n')}\n  ]\n}\n`;
  const core = (d = 'd') => entry('memory-core', undefined, d, 'calendar');
  fs.mkdirSync(path.join(work, 'files'), { recursive: true });
  fs.mkdirSync(path.join(work, 'base'), { recursive: true });
  // Installed: phone-push off, calendar and idle-jobs on. The user turned phone-push on and calendar off, left idle-jobs.
  fs.writeFileSync(path.join(work, 'base', 'features.json'), list(core(), entry('phone-push', false), entry('calendar', true), entry('idle-jobs', true)));
  fs.writeFileSync(path.join(work, 'files', 'features.json'), list(core(), entry('phone-push', true), entry('calendar', false), entry('idle-jobs', true)));
  // Settled with the new version's side (merge-new): new descriptions, the new version's values, idle-jobs now shipped off.
  const settled = list(core('d2'), entry('phone-push', false, 'd2'), entry('calendar', true, 'd2'), entry('idle-jobs', false, 'd2'));
  fs.writeFileSync(path.join(user, 'features.json'), settled);
  assert.deepEqual(carryFeatureStates(user, work), ['phone-push: "enabled": true (사용자가 정해 둔 대로)', 'calendar: "enabled": false (사용자가 정해 둔 대로)']);
  assert.equal(fs.readFileSync(path.join(user, 'features.json'), 'utf8'), list(core('d2'), entry('phone-push', true, 'd2'), entry('calendar', false, 'd2'), entry('idle-jobs', false, 'd2')));
  assert.deepEqual(carryFeatureStates(user, work), [], 'nothing left to carry');
  // Without the installed version's copy every value of the user's counts as the user's.
  fs.rmSync(path.join(work, 'base'), { recursive: true });
  fs.writeFileSync(path.join(user, 'features.json'), settled);
  assert.deepEqual(carryFeatureStates(user, work).length, 3);
  assert.match(fs.readFileSync(path.join(user, 'features.json'), 'utf8'), /"id": "idle-jobs",[^}]*"enabled": true/);
});

// 없으면 놓치는 실수: 올린 뒤 workspace-links를 사람이 따로 해야 하고, 빠뜨리면 공간 규칙이 옛 형식으로 남는다.
test('finish: runs workspace-links and lists the workspaces it could not fix to ask', () => {
  const user = tempDir();
  fs.writeFileSync(path.join(user, 'package.json'), '{}');
  // The user's own command (the new version's code in the user folder): one workspace fixed, one not.
  fs.mkdirSync(path.join(user, 'src'));
  const cli = (body: string) => fs.writeFileSync(path.join(user, 'src', 'cli.ts'), `if (process.argv[2] !== 'workspace-links') process.exit(3);\n${body}\n`);
  cli("console.log('고침: C:\\\\w\\\\a (번호가 다름)');\nconsole.log('못 고침: C:\\\\w\\\\b (비슷하지만 다른 줄)');\nconsole.log('공간 2개 중 고친 것 1개 (x)');");
  const finish = () => spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'update.mjs'), 'finish', '--user', user], { encoding: 'utf8' });
  let r = finish();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /작업 공간\(workspace-links\): 고침: C:\\w\\a/);
  assert.match(r.stdout, /물어볼 공간\(workspace-links가 못 고침\): \n {2}- C:\\w\\b \(비슷하지만 다른 줄\)\n/);
  assert.match(r.stdout, /ASK_WORKSPACES=1/);
  // A failing command is told and the exit code says so.
  cli("console.error('boom'); process.exit(1);");
  r = finish();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /작업 공간\(workspace-links\): 실패 — boom/);
});

// 없으면 놓치는 실수: 사용자가 workspaces/_skills에 깔린 배포판 공통 스킬을 고쳐도 업데이트가 비서 폴더의 설치 원본(common-skills/)만 보고
// 넘어가 새 판이 오지 않거나, 반대로 _skills의 사용자 수정을 묻지 않고 덮어쓴다.
test('a shipped common skill: the copy in _skills is updated like a secretary file (asked when both changed), the secretary folder copy follows the new version', () => {
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    }
  };
  const S = 'common-skills/common-a';
  const v11 = { 'package.json': '{}\n', VERSION: 'v0.11.0\n', [`${S}/SKILL.md`]: 'top\nA\nB\nC\nend\n', [`${S}/references/r.md`]: 'r1\n', [`${S}/references/mine.md`]: 'm1\n' };
  g('init', '-q');
  put(repo, v11);
  g('add', '-A');
  g('commit', '-qm', 'v0.11.0');
  g('tag', 'v0.11.0');
  put(repo, { VERSION: 'v0.12.0\n', [`${S}/SKILL.md`]: 'top\nA\nB\nC\nend new\n', [`${S}/references/r.md`]: 'r2\n', [`${S}/references/added.md`]: 'n\n' });
  g('add', '-A');
  g('commit', '-qm', 'v0.12.0');
  g('tag', 'v0.12.0');
  // The user folder as installed (its common-skills/ untouched) and its workspaces/_skills copy, changed by the user.
  const base = tempDir();
  const user = path.join(base, 'secretary');
  put(user, v11);
  const skills = path.join(base, 'workspaces', '_skills', 'common-a');
  put(skills, { 'SKILL.md': 'mine\nA\nB\nC\nend\n', 'references/r.md': 'r1\n', 'references/mine.md': 'm1 mine\n' });
  const env = { ...process.env, SECRETARY_WORKSPACE_ROOT: path.join(base, 'workspaces') };
  const run = (...a: string[]) => execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'update.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe', env });
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  assert.equal(fs.readFileSync(path.join(work, 'skills-files', 'common-a', 'references', 'mine.md'), 'utf8'), 'm1 mine\n', 'the _skills copy is backed up');
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v0.11.0', '--work', work);
  const read = (p: string) => fs.readFileSync(path.join(skills, ...p.split('/')), 'utf8');
  assert.equal(read('references/r.md'), 'r2\n', 'not changed by the user: the new version');
  assert.equal(read('references/added.md'), 'n\n');
  assert.equal(read('references/mine.md'), 'm1 mine\n', 'changed by the user only: kept');
  assert.equal(read('SKILL.md'), 'mine\nA\nB\nC\nend\n', 'both changed: nothing written before the user decides');
  assert.match(out, /- \.\.\/workspaces\/_skills\/common-a\/SKILL\.md · [^\n]*깨끗이 합쳐짐/);
  // The secretary folder's copy is only what an install copies from: always the new version, never asked.
  assert.equal(fs.readFileSync(path.join(user, S, 'SKILL.md'), 'utf8'), 'top\nA\nB\nC\nend new\n');
  assert.doesNotMatch(out, /- common-skills\/common-a\/SKILL\.md · /);
  run('resolve', '--user', user, '--work', work, '--file', '../workspaces/_skills/common-a/SKILL.md', '--take', 'merge');
  assert.equal(read('SKILL.md'), 'mine\nA\nB\nC\nend new\n');
  assert.ok(fs.existsSync(path.join(work, 'merged', 'workspaces', '_skills', 'common-a', 'SKILL.md')), 'the copies stay in the work folder');
});

// 없으면 놓치는 실수: 설정 JSON(공통 스킬 목록·공급자·허용 권한)에서 사용자와 새 버전이 같은 목록 끝에 한 줄씩 더하면 줄 합치기가 부딪히고,
// 스크립트 추천(새 버전 쪽)을 "나머지는 추천대로"로 받으면 사용자가 켠 공통 스킬·더한 공급자가 조용히 빠진다.
test('a settings JSON both sides added to is merged by key: both sides’ entries stay, a value both changed keeps the user’s', () => {
  // Lists by item, objects by key, entries with an id matched by it.
  const jb = { default: 'a', skills: ['s1'], providers: { a: { effort: 'high' } }, features: [{ id: 'f1', enabled: true, files: ['x'] }] };
  const ju = { default: 'mine', skills: ['s1', 'u1'], providers: { a: { effort: 'high' }, mine: { type: 'm' } }, features: [{ id: 'f1', enabled: false, files: ['x'] }] };
  const jt = { default: 'new', skills: ['s1', 't1'], providers: { a: { effort: 'max' } }, features: [{ id: 'f1', enabled: true, files: ['x', 'y'] }, { id: 'f2', files: [] }], added: 1 };
  const m = mergeJson(jb, ju, jt);
  assert.deepEqual(m.value, { default: 'mine', skills: ['s1', 't1', 'u1'], providers: { a: { effort: 'max' }, mine: { type: 'm' } }, features: [{ id: 'f1', enabled: false, files: ['x', 'y'] }, { id: 'f2', files: [] }], added: 1 });
  assert.deepEqual(m.clashes, ['default']);
  assert.equal((mergeJson(jb, ju, jt, 'theirs').value as { default: string }).default, 'new');
  // What one side removed and the other left goes.
  assert.deepEqual(mergeJson({ l: ['a', 'b'] }, { l: ['a'] }, { l: ['a', 'b', 'c'] }).value, { l: ['a', 'c'] });
  // Written in the new version's indent; package.json keeps the new version's value; no JSON, no merge.
  const t = mergeJsonText('package.json', '{\n "v": 1\n}\n', '{\n "v": 2\n}\n', '{\n "v": 3,\n "w": 1\n}\n')!;
  assert.equal(t.text, '{\n "v": 3,\n "w": 1\n}\n');
  assert.equal(mergeJsonText('a.json', '{', '{}', '{}'), null);

  // Through apply and "the rest as recommended": the user's common skill stays, the new version's comes.
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), c);
    }
  };
  const list = (skills: string[]) => `${JSON.stringify({ about: 'x', skills }, null, 2)}\n`;
  const v11 = { 'package.json': '{}\n', VERSION: 'v0.11.0\n', 'common-skills.json': list(['common-a']) };
  g('init', '-q');
  put(repo, v11);
  g('add', '-A');
  g('commit', '-qm', 'v0.11.0');
  g('tag', 'v0.11.0');
  put(repo, { VERSION: 'v0.12.0\n', 'common-skills.json': list(['common-a', 'common-new']) });
  g('add', '-A');
  g('commit', '-qm', 'v0.12.0');
  g('tag', 'v0.12.0');
  const user = tempDir();
  put(user, { ...v11, 'common-skills.json': list(['common-a', 'common-mine']) });
  const run = (...a: string[]) => execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'update.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe' });
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v0.11.0', '--work', work);
  assert.match(out, /- common-skills\.json · [^\n]*줄로는 부딪힌 곳 1군데, JSON 키 단위로 합침[^\n]*고를 것: keep\/new\/merge\/merge-mine\/merge-new\/edited · 추천: merge/);
  run('resolve', '--user', user, '--work', work, '--rest');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(user, 'common-skills.json'), 'utf8')).skills, ['common-a', 'common-new', 'common-mine']);
  assert.equal(fs.readFileSync(path.join(user, 'VERSION'), 'utf8'), 'v0.12.0\n');
});

// 없으면 놓치는 실수: 업데이트 도우미는 받은 저장소에서 npm install 없이 도는데, 그것이 import하는 src 파일 하나가 패키지(better-sqlite3 등)를
// import하면 사용자 PC의 업데이트가 첫 명령에서 "Cannot find package"로 멈춘다. 시험은 node_modules가 있는 폴더에서 돌아 그래도 통과한다.
test('the update script and every file it imports load without packages (a received repository has no node_modules)', () => {
  // Every import, followed from scripts/update.mjs: node: built-ins or files of this folder only (type-only imports are erased).
  const seen = new Set<string>();
  const packages: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
      if (m[2]) continue;
      const spec = m[3] ?? m[4];
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        packages.push(`${path.relative(PROJECT_ROOT, file)}: ${spec}`);
        continue;
      }
      visit(path.resolve(path.dirname(file), spec));
    }
  };
  visit(path.join(PROJECT_ROOT, 'scripts', 'update.mjs'));
  assert.ok(seen.size > 3, 'it follows the src imports');
  assert.deepEqual(packages, [], 'scripts/update.mjs가 import하는 파일은 node: 기본 모듈과 상대 경로만 import한다');
  // And for real: a copy of this folder without node_modules loads it (the usage line, not a missing package).
  const copy = tempDir();
  fs.cpSync(PROJECT_ROOT, copy, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git)$/.test(s) && !fs.lstatSync(s).isSymbolicLink() });
  const r = spawnSync(process.execPath, [path.join(copy, 'scripts', 'update.mjs')], { cwd: copy, encoding: 'utf8' });
  assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/, r.stderr);
  assert.match(r.stderr, /usage: node scripts\/update\.mjs/);
});