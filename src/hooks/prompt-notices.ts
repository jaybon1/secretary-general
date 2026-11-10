/**
 * What the prompt hook (cli hook prompt) adds to each question, in the order it appears in the context.
 * Each feature puts its notice here: one function that returns '' when it has nothing to say. Which feature
 * a notice belongs to is in features.json; notices of a feature turned off there are not run (setup/features.ts).
 * The board runs before the rest (it catches up other sessions' transcripts and may wait for a
 * rewrite), so the others see the conversation it logged.
 */
import fs from 'node:fs';
import { boardContext } from '../session-continuity/situation-board-notice.ts';
import { PROJECT_ROOT } from '../core/config.ts';
import { contextNudge, lastContextTokens } from './context-size-nudge.ts';
import { promptContext } from './prompt-memory.ts';
import { labelNotice } from '../mistake-guards/question-labels.ts';
import { guardWarnNotice } from '../mistake-guards/stop-guard.ts';
import { purgeNotice } from '../log/purge.ts';
import { rewindNotice } from '../log/rewind.ts';
import { disabledItems } from '../setup/features.ts';
import { consolidateNotice, consolidateNudge } from '../memory/consolidate-notice.ts';
import { setupReminder } from '../setup/setup-check.ts';
import type { Store } from '../store/store.ts';
import { applyGuardOverride } from '../usage/usage-guard-override.ts';
import { routingContext } from '../usage/subscription-routing.ts';
import { watchNotice } from '../workspace/watch-check.ts';
import { NOTICE } from '../core/names.ts';

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
  { name: NOTICE.usageGuardOverride, run: (c) => applyGuardOverride(c.prompt) },
  { name: NOTICE.subscriptionRouting, run: () => routingContext() },
  { name: NOTICE.setupCheck, run: () => setupReminder() },
  { name: NOTICE.watchMissing, run: (c) => watchNotice(c.store) },
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
    run: (c) => (c.sessionId ? boardContext(c.store, c.sessionId, undefined, c.prompt, { transcriptPath: c.transcriptPath }) : ''),
  },
  { name: NOTICE.memoryCore, run: (c) => promptContext(c.store, c.prompt, c.sessionId, c.transcriptPath) },
  // Feature 'mistake-guards': what the last answer's checks still found, and the session's next question label (after the
  // board, which relabels carried questions on a new session's first prompt).
  { name: NOTICE.answerCheckWarn, run: (c) => (c.sessionId ? guardWarnNotice(c.store, c.sessionId) : '') },
  { name: NOTICE.questionLabel, run: (c) => (c.sessionId ? labelNotice(c.store, c.sessionId) : '') },
];

/** The notices whose feature is on in root's features.json (all of them without the file). */
export function activeNotices(root = PROJECT_ROOT, notices = PROMPT_NOTICES): PromptNotice[] {
  const off = disabledItems('notices', root);
  return notices.filter((n) => !off.has(n.name));
}

/** All notices for one question, joined in list order. */
export async function promptNotices(c: PromptInput, notices = activeNotices()): Promise<string> {
  const out = new Map<PromptNotice, string>();
  for (const n of [...notices.filter((n) => n.first), ...notices.filter((n) => !n.first)]) out.set(n, await n.run(c));
  return notices
    .map((n) => out.get(n))
    .filter(Boolean)
    .join('\n');
}
