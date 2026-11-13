/**
 * What the secretary's PreToolUse and PostToolUse hooks caught (feature 'mistake-guards'): the folder-place refusal
 * (pre-tool-hook.ts) and the repeat reminder (repeat-hook.ts). Those hooks never open the database (a tool call waits for
 * them), so each catch is one JSON line appended to a small file per session under the temp folder; the Stop hook takes the
 * session's lines when the turn ends and keeps them with the Stop checks in the turn record (turn_tools.guard, stop-guard.ts).
 * list_mistakes counts them (store guardHitSummary).
 *
 * Only the secretary's own session notes them (CLAUDE_PROJECT_DIR is this folder): a work session or run-job runs the same
 * repeat hook but has no secretary Stop hook to take its lines. Not here: the usage guard (the user's settings, every
 * session) and a work session's worker-folder-guard. Any failure is dropped without a word: noting never holds up a call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { nowIso } from '../core/kst-time.ts';
import type { GuardHit } from '../store/mistake-guards.ts';

/** Where the per-session files live; tests point it elsewhere (test/env.ts). */
export const HITS_DIR_ENV = 'SECRETARY_TEST_TOOL_HOOK_HITS_DIR';
export const hitsDir = () => process.env[HITS_DIR_ENV] || path.join(os.tmpdir(), 'secretary-tool-hook-hits');

/** Files of sessions quiet this long are removed when a new one is made (a session whose Stop hook never ran). */
const KEEP_MS = 7 * 86_400_000;

/** The guards these hooks hold, by the name the record uses (the check), with the user's word for it. */
export const TOOL_HOOK_GUARDS = {
  'folder-place': '폴더 쓰기 막기',
  repeat: '반복 작업 알림',
} as const;

const fileOf = (dir: string, sessionId: string) => path.join(dir, `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`);

const sameDir = (a: string, b: string) => {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Whether this hook runs for the secretary's own session (Claude Code sets CLAUDE_PROJECT_DIR for hook commands). */
export function inSecretarySession(projectDir = process.env.CLAUDE_PROJECT_DIR): boolean {
  return !!projectDir && sameDir(projectDir, PROJECT_ROOT);
}

/** Appends one catch to the session's file; never throws. */
export function noteToolHookHit(sessionId: string | undefined, hit: { hook: 'PreToolUse' | 'PostToolUse'; check: keyof typeof TOOL_HOOK_GUARDS; level: 'block' | 'warn'; tool: string }, dir = hitsDir()): void {
  try {
    if (!sessionId || !inSecretarySession()) return;
    const file = fileOf(dir, sessionId);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      for (const n of fs.readdirSync(dir)) {
        const f = path.join(dir, n);
        if (now - fs.statSync(f).mtimeMs > KEEP_MS) fs.rmSync(f, { force: true });
      }
    }
    const row: GuardHit = { check: hit.check, level: hit.level, hook: hit.hook, tool: hit.tool, at: nowIso() };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {}
}

/** The session's catches noted since the last take, and the file removed ([] when none, or on any failure). */
export function takeToolHookHits(sessionId: string, dir = hitsDir()): GuardHit[] {
  const file = fileOf(dir, sessionId);
  // Moved aside first: a line a hook appends meanwhile goes to a new file, kept for the next take.
  const taking = `${file}.${process.pid}.taking`;
  try {
    fs.renameSync(file, taking);
  } catch {
    return [];
  }
  try {
    return fs
      .readFileSync(taking, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          const h = JSON.parse(l) as GuardHit;
          return h && typeof h.check === 'string' && (h.level === 'block' || h.level === 'warn') ? [h] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  } finally {
    fs.rmSync(taking, { force: true });
  }
}
