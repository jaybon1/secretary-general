// npm test (and npm run test:dist): node --test on the given files (default test/*.test.ts), every test process set up
// by test/env.ts first. %TEMP% (TEMP, TMP) is a fresh folder of this run, so what the tests make in it is theirs alone;
// afterwards the run fails if anything is left in it or is new in the repository (git status, ignored files included),
// and says what. The folder itself goes in the end.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2);
if (!files.length) files.push('test/*.test.ts');

/** The repository's untracked and ignored entries (other worktrees under .claude/worktrees/ left out); null outside git. */
function repoEntries() {
  const r = spawnSync('git', ['status', '--porcelain=v1', '--ignored', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return new Set(
    r.stdout
      .split('\0')
      .filter((e) => /^(\?\?|!!) /.test(e))
      .map((e) => e.slice(3))
      .filter((p) => !p.startsWith('.claude/worktrees/')),
  );
}

const before = repoEntries();
const runDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-testrun-')));
const env = { ...process.env, TEMP: runDir, TMP: runDir };
// Run under another node --test (the release test runs this one): report here, not to that runner.
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--import', './test/env.ts', '--test', ...files], { cwd: ROOT, stdio: 'inherit', env });

const problems = [];
const left = fs.readdirSync(runDir);
if (left.length) problems.push(`%TEMP%에 남은 것 ${left.length}개: ${left.join(', ')}`);
if (before) {
  const after = repoEntries() ?? new Set();
  const added = [...after].filter((p) => !before.has(p));
  if (added.length) problems.push(`저장소에 새로 생긴 것 ${added.length}개: ${added.join(', ')}`);
}
try {
  fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
} catch {
  problems.push(`시험 %TEMP% 폴더를 못 지움: ${runDir}`);
}
if (problems.length) console.error(`\n시험 뒤 흔적(남기지 않게 고친다):\n- ${problems.join('\n- ')}`);
else console.log(`\n시험 뒤 흔적 없음 (%TEMP% 시험 폴더 비었음${before ? ', 저장소 새 파일 없음' : ', git 밖이라 저장소는 안 봄'})`);
process.exitCode = r.status !== 0 ? (r.status ?? 1) : problems.length ? 1 : 0;
