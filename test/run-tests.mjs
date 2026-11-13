// npm test (and npm run test:release-build): node --test on the given files (default test/*.test.ts), every test process set up
// by test/env.ts first. %TEMP% (TEMP, TMP) is a fresh folder of this run, so what the tests make in it is theirs alone;
// afterwards the run fails if anything is left in it or is new in the repository (git status, ignored files included),
// and says what. The folder itself goes in the end. A failed test is also written, with the time, to this secretary's
// test-failures.jsonl with the branch and commit (test/test-failures.ts); a problem with that record never changes the result.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// The usual report on the screen, and beside it the failed tests into a file of this run (outside %TEMP%: the tests' own).
const failed = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-testfail-')), 'failed.jsonl');
const reporters = ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${pathToFileURL(path.join(ROOT, 'test', 'test-failures.ts')).href}`, `--test-reporter-destination=${failed}`];
const r = spawnSync(process.execPath, ['--import', './test/env.ts', '--test', ...reporters, ...files], { cwd: ROOT, stdio: 'inherit', env });
try {
  const { appendFailures, failuresFile } = await import('./test-failures.ts');
  const record = await failuresFile();
  const n = appendFailures(failed, record);
  if (n) console.log(`\n실패한 테스트 ${n}개를 기록에 적음: ${record}`);
} catch {}
try {
  fs.rmSync(path.dirname(failed), { recursive: true, force: true, maxRetries: 3 });
} catch {}

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
  problems.push(`테스트 %TEMP% 폴더를 못 지움: ${runDir}`);
}
if (problems.length) console.error(`\n테스트 뒤 남은 임시 파일(남기지 않게 고친다):\n- ${problems.join('\n- ')}`);
else console.log(`\n테스트 뒤 남은 임시 파일 없음 (%TEMP% 테스트 폴더 비었음${before ? ', 저장소 새 파일 없음' : ', git 밖이라 저장소는 안 봄'})`);
// The old-names rows whose day has come, once more at the very end of a whole run (test/legacy-names.test.ts says them
// among its results; this is not a failure).
if (!process.argv[2]) {
  try {
    const { dueLegacyNames, removeWhen } = await import('../src/core/legacy-names.ts');
    const due = dueLegacyNames();
    if (due.length) {
      console.log(`\n옛 이름 읽기 다시 볼 날 지난 줄 ${due.length}개(실패 아님, src/core/legacy-names.ts):`);
      for (const r of due) console.log(`- ${r.id}(${r.checkBy}): ${r.old} → ${r.now}. 지울 조건: ${removeWhen(r)}`);
    }
  } catch {}
}
process.exitCode = r.status !== 0 ? (r.status ?? 1) : problems.length ? 1 : 0;
