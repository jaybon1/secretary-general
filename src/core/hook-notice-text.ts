/**
 * The words a hook hands the secretary, kept as files in .agents/hook-notices/ (one md per notice, a `## key` heading per
 * piece) instead of inside the hook code. Every CLI that reads the .agents folder (Claude Code through its hooks, Codex,
 * Antigravity) can be wired to the same text, and a CLI with no hook wired opens the file itself (AGENTS.md says so).
 * The hooks only read and attach: what the secretary is told to do is written in the md files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { NOTICE } from './names.ts';

export const HOOK_NOTICES_DIR = '.agents/hook-notices';

/**
 * Every (file, key) a hook reads, so a test can tell a renamed heading or a missing file (test/prompt-notices.test.ts).
 * The answer checks' pieces (answer-format.md) are listed where the checks are (mistake-guards/answer-check-table.ts
 * FORMAT_NOTICE_KEYS), so this shared code does not lean on that feature; the same test reads both.
 */
export const HOOK_NOTICE_KEYS: Record<string, string[]> = {
  [NOTICE.situationBoard]: ['reading'],
  'memory-consolidation-report': ['todo'],
  'semantic-search-misses': ['todo', 'ask'],
};

/** The text under `## key` in .agents/hook-notices/<name>.md (to the next `## `), '' when the file or the key is not there. */
export function hookNoticeText(name: string, key: string, root = PROJECT_ROOT): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, HOOK_NOTICES_DIR, `${name}.md`), 'utf8');
  } catch {
    return '';
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${key}`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}
