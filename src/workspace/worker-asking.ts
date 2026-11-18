/**
 * A work session that ended its turn on a [질문] waits for the user, so its task goes to asking (the user's call, 2026-11-14).
 * The watcher (scripts/worker/watch-worker.ps1) runs `node src/cli.ts worker-asking` when it sees the session idle and
 * hands it the session's config folder; the transcript is found there (core/transcript.ts findSessionTranscript), its
 * end read, and the task changed. Only a running task changes: one already done, failed, cancelled or asking is left as it is.
 *
 * The transcript, not the `claude logs` screen: an answer longer than the screen (a question with many choices) scrolls
 * off the screen text, and what stays is mixed with the status lines, so the [질문] line was not there to read.
 */
import type { Store } from '../store/store.ts';
import { findSessionTranscript, lastReply, parseLines, tailLines, WORKER_TAIL_BYTES } from '../core/transcript.ts';

/** A work session's question starts with [질문] (workspace/rules-text.ts QUESTION_FIRST_RULE). */
const QUESTION_START = /^\s*\[질문\]/;

/**
 * Whether the last answer in the transcript lines starts with [질문]: the last text block of the last answer that has
 * text (its lines gathered by message.id). Answers with only a tool call or thinking are skipped; a prompt typed after
 * the [질문] means the session went on, so an older [질문] is not the last answer. Lines of sub-agents (isSidechain) do not count.
 */
export function lastAnswerAsks(lines: string[]): boolean {
  const reply = lastReply(parseLines(lines.map((l) => l.trim())), { withText: true, untilPrompt: true });
  return !!reply && QUESTION_START.test(reply.texts[reply.texts.length - 1]);
}

/** Whether a task's session_ref ("bg:" and the short id, or the full id) names the session `id` (short or full, "bg:" or not). */
export function refMatches(ref: string | null, id: string): boolean {
  const a = (ref ?? '').replace(/^bg:/, '').trim().toLowerCase();
  const b = id.replace(/^bg:/, '').trim().toLowerCase();
  if (a.length < 8 || b.length < 8) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * When the transcript of session `id` (found under the config folder `configDir`; `sessionId`, the full uuid, when the
 * watcher knows it) ends on a [질문], the running tasks of that session go to asking. Returns the lines to print (none
 * when nothing changed: no transcript, a read failure, no [질문], no task, or the task not running).
 */
export function markAskingFromTranscript(store: Store, id: string, configDir: string, sessionId?: string): string[] {
  let asks = false;
  try {
    const file = findSessionTranscript(configDir, id, sessionId);
    asks = !!file && lastAnswerAsks(tailLines(file, WORKER_TAIL_BYTES));
  } catch {
    return [];
  }
  if (!asks) return [];
  const out: string[] = [];
  for (const t of store.listTasks({ status: 'running', limit: 1000 })) {
    if (!refMatches(t.session_ref, id)) continue;
    store.updateTask(t.id, { status: 'asking' });
    out.push(`업무${t.id}(${t.title})의 상태를 질문 대기(asking)로 바꿨어요. 업무 세션의 마지막 답이 [질문]이에요.`);
  }
  return out;
}

/**
 * A message went to session `id` (send-worker.ps1 after '보냄' or '깨워서 보냄'): its tasks waiting on a [질문] (asking)
 * go back to running, so the summaries show it working again and the watcher is relaunched for it. Only asking tasks
 * change. Returns the lines to print (none when nothing changed).
 */
export function markAnswered(store: Store, id: string): string[] {
  const out: string[] = [];
  for (const t of store.listTasks({ status: 'asking', limit: 1000 })) {
    if (!refMatches(t.session_ref, id)) continue;
    store.updateTask(t.id, { status: 'running' });
    out.push(`업무${t.id}(${t.title})의 상태를 질문 대기에서 진행 중(running)으로 되돌렸어요.`);
  }
  return out;
}
