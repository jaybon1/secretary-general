import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/config.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain .mjs script without types
import { PROTECTED, classify, detectVersion, normalize, restyle } from '../scripts/update.mjs';

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

test('line ends and a BOM do not count as a change, and come back in the user style', () => {
  assert.equal(normalize('﻿a\r\nb\r\n'), 'a\nb\n');
  assert.equal(classify(normalize('x\r\n'), normalize('﻿x\n'), normalize('y\n')), 'replace');
  assert.equal(restyle('a\nb\n', 'a\r\n', 'a\n'), 'a\r\nb\r\n');
  assert.equal(restyle('a\n', 'a\n', '﻿a\n'), '﻿a\n');
  assert.equal(restyle('a\n', undefined, 'a\n'), 'a\n');
});

test('the installed version is the one most files match; close or low rates are not clear', () => {
  const v = (tag: string, files: Record<string, string>) => ({ tag, files: new Map(Object.entries(files)) });
  const versions = [v('v1', { a: '1', b: '1', c: '1' }), v('v2', { a: '1', b: '2', c: '2', d: '2' }), v('v3', { a: '3', b: '2', c: '2', d: '2' })];
  const user = (files: Record<string, string>) => (p: string) => files[p];
  const r = detectVersion(versions, user({ a: '1', b: '2', c: '2', d: 'mine' }));
  assert.equal(r.best, 'v2');
  assert.equal(r.clear, true);
  assert.deepEqual(r.rates.map((x: { rate: number }) => Math.round(x.rate * 100)), [33, 75, 50]);
  // A tie goes to the newer version but is not clear.
  const tie = detectVersion([v('v1', { a: '1' }), v('v2', { a: '1' })], user({ a: '1' }));
  assert.equal(tie.best, 'v2');
  assert.equal(tie.clear, false);
  assert.equal(detectVersion(versions, user({ a: 'x', b: 'x', c: 'x', d: 'x' })).clear, false);
});

test('personal data, downloads and local settings are never part of an update', () => {
  for (const p of ['secretary.db', 'secretary.db-wal', 'secretary.db.setup.json', 'secretary.db.embedder-failures.log', 'backups/x.db', 'models/a/b.onnx', 'node_modules/x/package.json', '.claude/settings.local.json', 'scripts/my.local.json', '.git/config', 'keys/a.env'])
    assert.ok(PROTECTED.test(p), p);
  for (const p of ['AGENTS.md', 'src/db.ts', '.claude/settings.json', '.claude/skills/update/SKILL.md', 'VERSION']) assert.ok(!PROTECTED.test(p), p);
});

test('an update keeps user edits, takes new ones, and holds a clash back as a question', () => {
  const repo = tempDir();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a]);
  const put = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    }
  };
  g('init', '-q');
  const v1 = { 'package.json': '{}\n', 'AGENTS.md': 'rule 1\nrule 2\nrule 3\n', 'a.txt': 'a\n', 'gone.txt': 'g\n', 'clash.txt': 'one\nA\nB\nC\nend\n', 'clash2.txt': 'one\nA\nB\nC\nend\n' };
  put(repo, v1);
  g('add', '-A');
  g('commit', '-qm', 'v1');
  g('tag', 'v1');
  fs.rmSync(path.join(repo, 'gone.txt'));
  put(repo, { 'AGENTS.md': 'rule 1\nrule 2\nrule 3\nrule 4\n', 'a.txt': 'a2\n', 'new.txt': 'n\n', 'clash.txt': 'two\nA\nB\nC\nend2\n', 'clash2.txt': 'two\nA\nB\nC\nend2\n', VERSION: 'v2\n' });
  g('add', '-A');
  g('commit', '-qm', 'v2');
  g('tag', 'v2');

  const user = tempDir();
  put(user, { ...v1, 'AGENTS.md': 'my rule\nrule 1\nrule 2\nrule 3\n', 'clash.txt': 'mine\nA\nB\nC\nend\n', 'clash2.txt': 'mine\nA\nB\nC\nend\n', 'secretary.db': 'DB' });
  const script = path.join(PROJECT_ROOT, 'scripts', 'update.mjs');
  const run = (...a: string[]) => execFileSync(process.execPath, [script, ...a], { encoding: 'utf8', stdio: 'pipe' });

  assert.match(run('detect', '--user', user, '--repo', repo), /BASE=v1/);
  const work = /WORK=(.+)/.exec(run('backup', '--user', user))![1].trim();
  assert.equal(fs.readFileSync(path.join(work, 'files', 'AGENTS.md'), 'utf8'), 'my rule\nrule 1\nrule 2\nrule 3\n');
  assert.ok(!fs.existsSync(path.join(work, 'files', 'secretary.db')));

  const out = run('apply', '--user', user, '--repo', repo, '--base', 'v1', '--work', work);
  const read = (p: string) => fs.readFileSync(path.join(user, p), 'utf8');
  assert.equal(read('AGENTS.md'), 'my rule\nrule 1\nrule 2\nrule 3\nrule 4\n');
  assert.equal(read('a.txt'), 'a2\n');
  assert.equal(read('new.txt'), 'n\n');
  assert.equal(read('VERSION'), 'v2\n');
  assert.ok(!fs.existsSync(path.join(user, 'gone.txt')));
  assert.equal(read('secretary.db'), 'DB');
  // The clash waits: the user's file is untouched, the marked-up merge is in the work folder.
  assert.equal(read('clash.txt'), 'mine\nA\nB\nC\nend\n');
  assert.match(out, /남은 부딪힘: 2개/);
  assert.match(fs.readFileSync(path.join(work, 'conflicts', 'clash.txt'), 'utf8'), /^<<<<<<< 내 것\nmine\n=======\ntwo\n>>>>>>> 새 버전\nA\nB\nC\nend2\n$/);
  assert.throws(() => run('resolve', '--user', user, '--work', work, '--file', 'clash.txt', '--take', 'edited'), /표시/);
  // Either choice settles only the clash; the part that merged cleanly (end2) comes along.
  assert.match(run('resolve', '--user', user, '--work', work, '--file', 'clash.txt', '--take', 'mine'), /남은 부딪힘: clash2\.txt/);
  assert.equal(read('clash.txt'), 'mine\nA\nB\nC\nend2\n');
  // A Windows-style path names the same file.
  assert.match(run('resolve', '--user', user, '--work', work, '--file', '.\\clash2.txt', '--take', 'new'), /남은 부딪힘: 없음/);
  assert.equal(read('clash2.txt'), 'two\nA\nB\nC\nend2\n');
  assert.match(run('detect', '--user', user, '--repo', repo), /BASE=v2/);
  assert.match(run('plan', '--user', user, '--repo', repo, '--base', 'v2'), /이미 최신/);
});
