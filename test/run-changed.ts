/**
 * npm run test:changed (feature 'setup-check'): only the tests of what changed, through test/run-tests.mjs (the same %TEMP%
 * and leftover-file checks as npm test). What changed: `git diff --name-only` from where this branch left main (--base
 * <ref> for another) to the working tree, and the untracked files. Which tests, by kind of file (2026-11-12 decision, research
 * 20261112-secretary-slimming chapter 4):
 *
 *   docs only (AGENTS.md, README, .agents/**.md)  DOC_TESTS, and test/release-build/ for AGENTS.md (the release's copy)
 *   features.json                                 LIST_TESTS
 *   release-src/, scripts/release-build/          test/release-build.test.ts and test/release-build/
 *   an original file a release patch names        those release tests too, beside what its kind calls for (patchedNames)
 *   a test file                                   it, test/release-build.test.ts and test/release-build/ (the release patches tests)
 *   shared code (SHARED_DIRS: src/core/, src/store/)  everything: any feature may lean on it
 *   a feature's file (features.json files)        that feature's tests and CORE_TESTS, ps1-syntax for a .ps1 (memory-core's
 *                                                 other files too: the hooks' entry, the MCP tools, the log… go by feature and import)
 *   anything else (no feature, test helpers, package.json, settings)  everything (the safe side)
 *
 * And for any changed src or scripts file, every test that reaches it through imports, directly or through other files
 * (testReach, test/import-graph.ts: the import graph read from the source text), so a test kept under another feature
 * than the file it reads still runs. What no import shows (a .ps1 a test starts) goes by its feature alone, as before.
 *
 * The first line says what runs and why. While working use this; before merging into main and before a release, the whole
 * npm test (secretary-dev skill). `--list` prints the choice without running it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testReach } from './import-graph.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const t = (name: string) => `test/${name}.test.ts`;
export const DOC_TESTS = ['wording', 'skill-spec', 'prompt-notices', 'release-build', 'features', 'staff', 'idle-jobs', 'watch'].map(t);
export const LIST_TESTS = ['features', 'names', 'release-build', 'this-secretary', 'legacy-names'].map(t);
export const CORE_TESTS = ['memory', 'ingest', 'mcp'].map(t);
export const RELEASE_TESTS = [t('release-build'), 'test/release-build/*.test.ts'];
const PS1_TEST = t('ps1-syntax');
/** The folders every feature leans on (2026-11-12 decision: only these, the rest of memory-core goes by feature and import). */
export const SHARED_DIRS = ['src/core/', 'src/store/'];

interface FeatureFiles {
  id: string;
  files: string[];
}

export interface Plan {
  /** Run everything (npm test), with the reason. */
  all: string | null;
  /** Test files (and the release folder's glob) to run, in order. */
  tests: string[];
  /** Per changed file: what it is taken as. */
  why: Array<{ file: string; as: string }>;
}

const isDoc = (f: string) => /\.md$/i.test(f) && (f === 'AGENTS.md' || f === 'CLAUDE.md' || /^README/i.test(f) || f.startsWith('.agents/'));
const isRelease = (f: string) => f.startsWith('release-src/') || f.startsWith('scripts/release-build/') || f === 'bin/release-build.mjs';

/** A feature's test files: its test/*.test.ts entries, and a test folder as its glob. */
const testsOf = (f: FeatureFiles) => f.files.filter((p) => p.startsWith('test/') && (p.endsWith('.test.ts') || p.endsWith('/'))).map((p) => (p.endsWith('/') ? `${p}*.test.ts` : p));

/**
 * The original files the release patches (release-src/edits/e*.py: rep, cut, write) name: a quoted file path in a patch,
 * whole or as the end of a path (`D + 'who-and-brief.md'`, its folder in a variable). When one of them changes, the patch may
 * no longer fit (a line it looks for gone, a file it overwrites changed), so the release tests run too. A quoted path in a
 * patch's new text counts as well: it only adds the release tests (the safe side).
 */
export function patchedNames(root = ROOT): string[] {
  const dir = path.join(root, 'release-src', 'edits');
  let names: string[] = [];
  try {
    for (const f of fs.readdirSync(dir).filter((n) => /^e.*\.py$/.test(n))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/['"]([\w.\-/]+\.[A-Za-z0-9]+)['"]/g)) names.push(m[1]);
    }
  } catch {
    names = [];
  }
  return [...new Set(names)];
}

const isPatched = (file: string, names: readonly string[]) => names.some((n) => file === n || file.endsWith(`/${n}`));

/** Which tests the changed files call for. `exists` says whether a test file is there (a deleted one is not run). */
export function pickTests(
  changed: string[],
  features: FeatureFiles[],
  exists: (file: string) => boolean = () => true,
  imports: Record<string, string[]> = {},
  patched: readonly string[] = [],
): Plan {
  const tests = new Set<string>();
  const why: Plan['why'] = [];
  const add = (xs: string[]) => xs.forEach((x) => tests.add(x));
  let all: string | null = null;
  for (const file of changed) {
    const importers = Object.keys(imports).filter((test) => imports[test].includes(file));
    add(importers);
    const fits = !isRelease(file) && isPatched(file, patched);
    if (fits) add(RELEASE_TESTS);
    const more = `${importers.length ? ` + 이 파일에 import로 닿는 테스트 ${importers.length}개` : ''}${fits ? ' + 배포판(패치가 고치는 원본)' : ''}`;
    if (isRelease(file)) {
      add(RELEASE_TESTS);
      why.push({ file, as: '배포판' });
    } else if (isDoc(file)) {
      add(DOC_TESTS);
      if (file === 'AGENTS.md') add(RELEASE_TESTS);
      why.push({ file, as: file === 'AGENTS.md' ? '문서(AGENTS.md, 배포판 사본 대조 포함)' : `문서${fits ? ' + 배포판(패치가 고치는 원본)' : ''}` });
    } else if (file === 'features.json') {
      add(LIST_TESTS);
      why.push({ file, as: '기능 목록' });
    } else if (/^test\/.*\.test\.ts$/.test(file)) {
      if (exists(file)) tests.add(file);
      add(RELEASE_TESTS);
      why.push({ file, as: '테스트 파일' });
    } else if (SHARED_DIRS.some((d) => file.startsWith(d))) {
      all ??= `${file}이(가) 공용 코드(${SHARED_DIRS.join('·')})라`;
      why.push({ file, as: '전체(공용 코드)' });
    } else {
      const owner = file.startsWith('test/') ? undefined : features.find((f) => f.files.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p)));
      if (!owner) {
        all ??= `${file}이(가) ${file.startsWith('test/') ? '테스트 공용 파일이라' : '어느 기능에도 안 속해서'}`;
        why.push({ file, as: '전체' });
        continue;
      }
      const own = testsOf(owner);
      add(own);
      add(CORE_TESTS);
      if (/\.ps1$/i.test(file)) tests.add(PS1_TEST);
      why.push({ file, as: `기능 ${owner.id}${own.length ? '' : '(그 기능의 테스트 없음, 핵심만)'}${/\.ps1$/i.test(file) ? ' + ps1 구문' : ''}${more}` });
    }
  }
  return { all, tests: [...tests].filter((x) => x.includes('*') || exists(x)), why };
}

/** Files changed since this branch left `base` (committed, staged, not staged, untracked); null outside git or without `base`. */
export function changedFiles(base = 'main', cwd = ROOT): string[] | null {
  const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const mb = git('merge-base', base, 'HEAD');
  if (mb.status !== 0) return null;
  const diff = git('diff', '--name-only', mb.stdout.trim());
  const untracked = git('ls-files', '--others', '--exclude-standard');
  if (diff.status !== 0 || untracked.status !== 0) return null;
  return [...new Set(`${diff.stdout}\n${untracked.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].sort();
}

function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf('--base');
  const base = i >= 0 ? args[i + 1] : 'main';
  const listOnly = args.includes('--list');
  const changed = changedFiles(base);
  let plan: Plan;
  if (!changed) plan = { all: `git에서 ${base}과(와) 비교하지 못해서`, tests: [], why: [] };
  else {
    const features = (JSON.parse(fs.readFileSync(path.join(ROOT, 'features.json'), 'utf8')) as { features: FeatureFiles[] }).features;
    plan = pickTests(changed, features, (f) => fs.existsSync(path.join(ROOT, f)), testReach(), patchedNames());
  }
  const n = changed?.length ?? 0;
  const release = plan.tests.includes(RELEASE_TESTS[1]);
  let files: string[];
  if (plan.all) {
    files = release ? ['test/*.test.ts', RELEASE_TESTS[1]] : [];
    console.log(`test:changed: 전체를 돌려요 — ${plan.all} (안전한 쪽). 바뀐 파일 ${n}개${release ? ', 배포판 테스트(test/release-build/)도' : ''}`);
  } else if (!plan.tests.length) {
    console.log(`test:changed: 돌릴 테스트 없음 — ${base} 뒤로 바뀐 파일 ${n}개`);
    return;
  } else {
    files = plan.tests;
    const kinds = [...new Set(plan.why.map((w) => w.as))].join(', ');
    console.log(`test:changed: 테스트 ${files.length}개를 돌려요 — 바뀐 파일 ${n}개(${kinds}): ${files.map((f) => f.replace(/^test\//, '').replace(/\.test\.ts$/, '')).join(', ')}`);
  }
  for (const w of plan.why) console.log(`  ${w.file} → ${w.as}`);
  if (listOnly) return;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'run-tests.mjs'), ...files], { cwd: ROOT, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
