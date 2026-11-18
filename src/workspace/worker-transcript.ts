/**
 * What the work-session scripts (scripts/worker/) read from a work session's transcript, through
 * `node src/cli.ts worker-transcript <what> <config folder> <work session id> [<session uuid>]`: the scripts never read
 * the JSONL themselves, so it is read and tested in one place (core/transcript.ts).
 *
 * - answer: the session's last answer as it wrote it (worker-logs.ps1). The `claude logs` screen keeps only what fits
 *   on the screen, redrawn again and again, so a long answer (a [질문] with many choices) loses its start there.
 * - context: the last model call's size in tokens (worker-lib.ps1 Get-SessionContext).
 * - path: the transcript's path.
 * - received (with --text <글>): '있음' when a line of the transcript carries the text (send-worker.ps1 checks that the line
 *   pointing at the message file reached the session, whatever record the message came in as), else '없음'; then the path.
 * The watcher (watch-worker.ps1) reads how far the session wrote and its last steps through `worker-status`
 * (workspace/worker-status.ts) instead, with the rest of its verdict.
 * Nothing is printed, and the exit code is 2, when the transcript is not found or has nothing of the kind.
 */
import { formatLocal } from '../core/kst-time.ts';
import { findSessionTranscript, lastContextTokens, lastReply, parseLines, tailLines, WORKER_TAIL_BYTES } from '../core/transcript.ts';

export const WORKER_TRANSCRIPT_WHAT = ['answer', 'context', 'path', 'received'] as const;
export type WorkerTranscriptWhat = (typeof WORKER_TRANSCRIPT_WHAT)[number];

/** Whether any string in the record holds `text` (a message may come in as a user line, a queued one or an attachment). */
function holds(v: unknown, text: string): boolean {
  if (typeof v === 'string') return v.includes(text);
  if (Array.isArray(v)) return v.some((x) => holds(x, text));
  if (v && typeof v === 'object') return Object.values(v).some((x) => holds(x, text));
  return false;
}

/** Whether a whole line of the transcript's tail carries `text`. */
export function transcriptHolds(file: string, text: string): boolean {
  return parseLines(tailLines(file, WORKER_TAIL_BYTES, { wholeOnly: true })).some((r) => holds(r, text));
}

/** The lines to print for `what`; null when the transcript is not found or holds nothing of the kind. */
export function workerTranscript(what: WorkerTranscriptWhat, configDir: string, id: string, sessionId?: string, text?: string): string[] | null {
  const file = findSessionTranscript(configDir, id, sessionId);
  if (!file) return null;
  if (what === 'path') return [file];
  if (what === 'received') return [text && transcriptHolds(file, text) ? '있음' : '없음', file];
  if (what === 'context') {
    const tokens = lastContextTokens(file, WORKER_TAIL_BYTES);
    return tokens ? [String(tokens)] : null;
  }
  const reply = lastReply(parseLines(tailLines(file, WORKER_TAIL_BYTES, { wholeOnly: true })), { withText: true });
  if (!reply) return null;
  const when = reply.timestamp ? `${formatLocal(reply.timestamp, false, true)} KST` : '시각 모름';
  const head = `[업무 세션의 마지막 답 · ${when}${reply.synthetic ? ' · 앱이 쓴 줄(사용량 한도·API 오류)' : ''} · 대화 기록: ${file}]`;
  return [head, reply.texts.join('\n\n').trim()];
}
