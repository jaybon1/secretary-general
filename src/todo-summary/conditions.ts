/**
 * The conditions of action memories that code can check by itself (feature todo-summary), no model: a date come, a
 * delegated task finished (tasks), a commit in main (git merge-base --is-ancestor), a question the user answered (the open-question
 * list's closed record). A waiting condition found met is marked 'met' by the prompt hook; a 'text' condition is left to the board model and the
 * secretary. Run by the prompt hook before it builds the summary (todo-summary.ts).
 */
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../core/config.ts';
import { formatLocal } from '../core/kst-time.ts';
import { questionAnswered, resolveQuestionCondition } from '../store/open-questions.ts';
import { dueDate, type LiveAction, type Store } from '../store/store.ts';

/** Whether `hash` is in the main branch of the secretary's own repository; false when git cannot tell. */
export function commitInMain(hash: string, root = PROJECT_ROOT): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', hash, 'main'], { cwd: root, stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export interface ConditionDeps {
  now?: number;
  commitInMain?: (hash: string) => boolean;
}

/**
 * Whether one action's condition is met now (undefined: code cannot tell, a text condition or none). The secretary's own
 * action with a due date and no condition counts as a date condition: the secretary is told when it comes.
 */
export function conditionMet(store: Store, a: LiveAction, deps: ConditionDeps = {}): boolean | undefined {
  const row = a.action;
  const today = formatLocal(deps.now ?? Date.now(), true);
  if (row && !row.cond_kind && row.owner === 'secretary' && row.due_at) return dueDate(row.due_at) <= today;
  if (!row?.cond_kind || !row.cond_value) return undefined;
  switch (row.cond_kind) {
    case 'date':
      return dueDate(row.cond_value) <= today;
    case 'task_done': {
      const t = store.getTask(Number(row.cond_value));
      return !!t && t.status !== 'ready' && t.status !== 'running' && t.status !== 'asking';
    }
    case 'commit_in_main':
      return (deps.commitInMain ?? commitInMain)(row.cond_value);
    case 'question_answered': {
      // Met only when the user answered it (the user's call, 2026-11-18): a question that left the list unanswered
      // (expired after a week, left out of the closing list, deleted) is not an answer. Kept by the row that asked it.
      return questionAnswered(store, row.cond_value);
    }
    default:
      return undefined;
  }
}

/**
 * Marks every live action whose condition code finds met (and not yet marked met). Returns the ones it marked, each
 * once: the secretary is told about its own (todo-summary.ts dueNotice).
 */
export function markMetConditions(store: Store, deps: ConditionDeps = {}): LiveAction[] {
  const marked: LiveAction[] = [];
  for (const a of store.liveActions()) {
    if (!a.action || a.action.state === 'met') continue;
    // A question's label saved by a writer that did not turn it into the asking row (the consolidation, action-set): turned now.
    if (a.action.cond_kind === 'question_answered' && a.action.cond_value) {
      const c = resolveQuestionCondition(store, { kind: a.action.cond_kind, value: a.action.cond_value });
      if (c.value !== a.action.cond_value) a.action = store.setAction(a.id, { condition: c, state: a.action.state, by: 'prompt-hook', logId: a.action.marked_log_id });
    }
    if (conditionMet(store, a, deps) !== true) continue;
    a.action = store.setAction(a.id, { state: 'met', by: 'prompt-hook' });
    marked.push(a);
  }
  return marked;
}
