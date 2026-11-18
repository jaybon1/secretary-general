/**
 * What the prompt hook (cli hook prompt) adds to each question, in the order it appears in the context.
 * Each feature puts its notice here: one function that returns '' when it has nothing to say. Which feature
 * a notice belongs to is in features.json; notices of a feature turned off there are not run (core/features.ts).
 * The board runs before the rest (it catches up other sessions' transcripts and may wait for a
 * rewrite), so the others see the conversation it logged.
 */
import fs from 'node:fs';
import { boardContext } from '../session-continuity/situation-board-notice.ts';
import { BOARD_WAIT_MS } from '../session-continuity/situation-board.ts';
import { SEARCH_TIMEOUT_MS } from '../semantic-search/client.ts';
import { PROJECT_ROOT, PROMPT_HOOK_BUDGET_MS } from '../core/config.ts';
import { contextNudge } from './context-size-nudge.ts';
import { lastContextTokens } from '../core/transcript.ts';
import { promptContext } from './prompt-memory.ts';
import { labelNotice } from '../store/open-questions.ts';
import { guardWarnNotice } from '../mistake-guards/stop-guard.ts';
import { purgeNotice } from '../log/purge.ts';
import { rewindNotice } from '../log/rewind.ts';
import { disabledItems } from '../core/features.ts';
import { consolidateNotice, consolidateNudge } from '../memory/consolidate-notice.ts';
import { setupReminder } from '../setup/setup-check.ts';
import type { Store } from '../store/store.ts';
import { applyGuardOverride } from '../usage/usage-guard-override.ts';
import { routingContext } from '../usage/subscription-routing.ts';
import { watchNotice } from '../workspace/watch-check.ts';
import { jobStallNotice } from '../workspace/job-stalls.ts';
import { todoNotice } from '../todo-summary/todo-summary.ts';
import { NOTICE } from '../core/names.ts';
import { hookErrorNotice, noteHookError, stopFailureNotice } from '../core/hook-errors.ts';

/**
 * How long the board may wait for its rewrite (at most BOARD_WAIT_MS): what the prompt hook's budget
 * (PROMPT_HOOK_BUDGET_MS, counted from the hook's time limit: core/config.ts PROMPT_HOOK_TIMEOUT_S) leaves after the time already
 * spent and one memory search that runs after it (SEARCH_TIMEOUT_MS). Until 2026-11-18 the board could wait the whole
 * 300 s and the search's 30 s came on top, past the 330 s limit, which cuts the hook and every notice with it.
 */
export function boardWaitMs(elapsedMs = process.uptime() * 1000): number {
  return Math.max(0, Math.min(BOARD_WAIT_MS, PROMPT_HOOK_BUDGET_MS - elapsedMs - SEARCH_TIMEOUT_MS));
}

export interface PromptInput {
  store: Store;
  prompt: string;
  sessionId?: string;
  transcriptPath?: string;
}

export interface PromptNotice {
  name: string;
  run: (c: PromptInput) => string | Promise<string>;
  /** Runs before the others (its place in the output stays where it is listed). */
  first?: boolean;
}

export const PROMPT_NOTICES: PromptNotice[] = [
  // This session's Stop hook failed after its last prompt (it has nowhere to say so itself): told once.
  { name: NOTICE.stopHookError, run: (c) => stopFailureNotice(c.sessionId) },
  { name: NOTICE.usageGuardOverride, run: (c) => applyGuardOverride(c.prompt) },
  { name: NOTICE.subscriptionRouting, run: () => routingContext() },
  { name: NOTICE.setupCheck, run: () => setupReminder() },
  { name: NOTICE.watchMissing, run: (c) => watchNotice(c.store) },
  // Feature 'delegate': jobs a tool cut as stalled that no prompt was told of yet (job-stalls.jsonl in the records folder).
  { name: NOTICE.jobStall, run: () => jobStallNotice() },
  {
    name: NOTICE.contextSize,
    run: (c) => {
      const tokens = c.transcriptPath && fs.existsSync(c.transcriptPath) ? lastContextTokens(c.transcriptPath) : 0;
      return c.sessionId ? contextNudge(c.store, c.sessionId, tokens) : '';
    },
  },
  { name: NOTICE.memoryConsolidation, run: (c) => (c.sessionId ? consolidateNotice(c.store, c.sessionId, c.prompt) || consolidateNudge(c.store, c.sessionId) : '') },
  // Before the board and the memory injection: a branch dropped by a rewind must not be read, even once.
  { name: NOTICE.rewind, first: true, run: (c) => rewindNotice(c.store, c.transcriptPath) },
  // Rows the user deleted directly with `purge-log --confirm` (no turn told the secretary): told once, numbers only.
  // An approval code's deletion is told in its own turn (purgeDone) and leaves nothing here.
  { name: NOTICE.purge, run: (c) => purgeNotice(c.store) },
  {
    name: NOTICE.situationBoard,
    first: true,
    run: (c) => (c.sessionId ? boardContext(c.store, c.sessionId, boardWaitMs(), c.prompt, { transcriptPath: c.transcriptPath }) : ''),
  },
  { name: NOTICE.memoryCore, run: (c) => promptContext(c.store, c.prompt, c.sessionId, c.transcriptPath) },
  // Feature 'mistake-guards': what the last answer's checks still found, and the session's next question label (after the
  // board, which relabels carried questions on a new session's first prompt).
  { name: NOTICE.answerCheckWarn, run: (c) => (c.sessionId ? guardWarnNotice(c.store, c.sessionId) : '') },
  { name: NOTICE.questionLabel, run: (c) => (c.sessionId ? labelNotice(c.store, c.sessionId) : '') },
  // Feature 'todo-summary': what waits on the user, for an answer whose closing list is "없음" (after the board, which
  // relabels carried questions on a new session's first prompt), and the secretary's own actions that came due.
  { name: NOTICE.todoSummary, run: (c) => (c.sessionId ? todoNotice(c.store, c.sessionId) : '') },
];

/** The notices whose feature is on in root's features.json (all of them without the file). */
export function activeNotices(root = PROJECT_ROOT, notices = PROMPT_NOTICES): PromptNotice[] {
  const off = disabledItems('notices', root);
  return notices.filter((n) => !off.has(n.name));
}

/**
 * All notices for one question, joined in list order. A notice that throws is left out alone: the others (the memory
 * injection above all) still go out, the failure is recorded (core/hook-errors.ts) and one tag line, first, names what is
 * missing, so the secretary does not read a missing notice as nothing to tell.
 */
export async function promptNotices(c: PromptInput, notices = activeNotices()): Promise<string> {
  const out = new Map<PromptNotice, string>();
  const failed: string[] = [];
  for (const n of [...notices.filter((n) => n.first), ...notices.filter((n) => !n.first)]) {
    try {
      out.set(n, await n.run(c));
    } catch (err) {
      failed.push(n.name);
      noteHookError('prompt', err, n.name);
    }
  }
  const lines = notices.map((n) => out.get(n)).filter(Boolean);
  if (failed.length) lines.unshift(hookErrorNotice(`질문 훅에서 안내 ${failed.length}개가 실패해 이번 질문에 빠졌어요: ${failed.join(', ')}`));
  return lines.join('\n');
}
