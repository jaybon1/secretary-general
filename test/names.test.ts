import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CHECK, CLI, FEATURE, NOTICE, STAFF, TAG, TASK } from '../src/core/names.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NAMES_FILE = path.join('src', 'core', 'names.ts');
/** The old-names table: its rows name features.json feature ids as data (test/legacy-names.test.ts checks them against features.json). */
const LEGACY_FILE = path.join('src', 'core', 'legacy-names.ts');

/** Every .ts file under src/ but names.ts and the old-names table, as [relative path, text]. */
function sources(): [string, string][] {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return walk(path.join(ROOT, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.relative(ROOT, f))
    .filter((f) => f !== NAMES_FILE && f !== LEGACY_FILE)
    .map((f) => [f.replaceAll('\\', '/'), fs.readFileSync(path.join(ROOT, f), 'utf8')]);
}

/** The code of a line: '' for a comment line, a trailing ` // …` cut off. */
function code(line: string): string {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  const c = line.search(/\s\/\/\s/);
  return c >= 0 ? line.slice(0, c) : line;
}

/**
 * The same word used as another kind of name on purpose (a folder or a SCRIPTS key, which names.ts does not hold):
 * "file|'value'" with why.
 */
const OTHER_MEANING = new Set([
  "src/workspace/skill-links.ts|'skills'", // the old skills/ folder
  "src/core/paths.ts|'dashboard'", // a SCRIPTS key (the bin entry dashboard.mjs), the same word as the feature
  "src/phone-push/ntfy.ts|'phone-push'", // the folder src/phone-push, the same word as the feature
]);

// [늘 남김] 다시 깨진 곳: 새 cli 명령·알림 id·점검 id를 names.ts에 넣지 않고 코드에 글자로 쓴 작업이 여러 번 있었다.
// 없으면 놓치는 실수: 이름을 names.ts에서 바꿨는데 코드 어딘가에 옛 글자 그대로 남아(알림 id·점검 id·cli 명령·주입 태그) 한쪽만 바뀐다.
test('names.ts: no cli command, notice id, check id, task id or tag written out again in src/', () => {
  const found: string[] = [];
  const values = (o: Record<string, string>) => [...new Set(Object.values(o))];
  const plain = [...values(CLI), ...values(NOTICE), ...values(CHECK), ...values(STAFF), ...values(FEATURE), ...values(TASK)];
  const cmds = values(CLI);
  const tags = values(TAG);
  for (const [file, text] of sources()) {
    text.split('\n').forEach((line, i) => {
      const c = code(line);
      if (!c) return;
      const at = `${file}:${i + 1}`;
      for (const v of plain) {
        for (const q of [`'${v}'`, `"${v}"`, `\`${v}\``]) if (c.includes(q) && !OTHER_MEANING.has(`${file}|${q.startsWith("'") ? q : `'${q}'`}`)) found.push(`${at} ${q}`);
      }
      for (const v of cmds) if (new RegExp(`cli\\.ts ${v}(?![\\w-])`).test(c) && !file.endsWith('common-skills.ts')) found.push(`${at} cli.ts ${v}`);
      for (const v of tags) if (c.includes(`<${v}>`) || c.includes(`</${v}>`)) found.push(`${at} <${v}>`);
      // A task id in an install-scheduled-tasks.ps1 command written out in a fix text (-Task idle-jobs).
      for (const v of values(TASK)) if (new RegExp(`-Task ${v}(?![\\w-])`).test(c)) found.push(`${at} -Task ${v}`);
    });
  }
  assert.deepEqual(found, [], 'names.ts의 이름을 쓴다(src/core/names.ts)');
});
