import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';

/** The vague Korean word the rules ban (it says something is done without saying who), spelled from code points so this file does not carry it. */
const VAGUE = String.fromCodePoint(0xc190, 0xc73c, 0xb85c);
/** The same vague phrase in English code comments, also built from parts so this file does not carry it. */
const VAGUE_EN = new RegExp(`\\b${'by'}\\s+${'hand'}\\b`, 'i');
/** The one line allowed to name it: the rule that bans it (AGENTS.md, and its copy for the release). */
const RULE_LINE = '누가 하는지 흐린 말';
/** Folders that are not the secretary's own text (a copy outside git: the release folder the release test builds). */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', 'backups', 'models', 'output']);

/** The repository's files: git's list, or every file under the folder outside git. */
function files(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(PROJECT_ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(rel);
        return e.isFile() ? [rel] : [];
      });
    return walk('');
  }
}

// 없으면 놓치는 실수: 규칙·안내·코드 글에 누가 하는지 흐린 말("손"+"으로", 영어 주석의 같은 말)이 다시 들어가, 사용자나 다른 모델이 사람이 할 일로 읽는다.
test('wording: no vague who-does-it word (Korean or English) anywhere but the rule line that bans it', () => {
  const found: string[] = [];
  for (const rel of files()) {
    const full = path.join(PROJECT_ROOT, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes(VAGUE) && !VAGUE_EN.test(line)) return;
      if (path.basename(rel) === 'AGENTS.md' && line.includes(RULE_LINE)) return;
      found.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(found, [], `"${VAGUE}"(영어 주석은 ${VAGUE_EN.source}) 대신 "비서가 직접", "사용자가 직접"(원본은 호칭으로), "프로그램이 저절로"처럼 주어로 쓴다`);
});
