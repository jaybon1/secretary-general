/**
 * What a new secretary session is told about where things stand: on its first prompt, the situation board with
 * the raw conversation logged after it (boardContext, waiting for a rewrite only when that tail is too long), why a
 * rewrite failed (failureNote: after a Claude Code update this is how a broken `claude -p` shows), and the plain
 * pointers to the previous session when there is no fresh board (continuityContext).
 */
import { estimateTokens } from '../core/token-estimate.ts';
import { formatLocal } from '../core/kst-time.ts';
import { catchUpTranscripts } from '../log/catch-up.ts';
import type { LogEntry, Store } from '../store/store.ts';
import { runningTaskLines } from '../workspace/watch-check.ts';
import { carryOverQuestions, openQuestionLines } from './open-questions.ts';
import { BOARD_RAW_MAX_TOKENS, BOARD_WAIT_MS, boardChunks, formatRows, OK_VERSION_KEY, PENDING_PREFIX, readBoard, readJob, readPending, spawnBoardJob, waitForJob, type Board, type Job } from './situation-board.ts';
import { NOTICE, TAG } from '../core/names.ts';
import { boardDecisionLines } from './board-decisions.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';

/** First words of the prompt the session-handoff skill opens a new session with. */
export const HANDOFF_MARK = '[이전 비서 세션에서 넘긴 맥락]';

/**
 * UserPromptSubmit: on the first prompt of a new session, inject the board plus the raw conversation
 * logged after it, and start a rewrite in the background. Only when that raw tail is over
 * BOARD_RAW_MAX_TOKENS (or there is no board yet) does it bring the board up to date and wait for it
 * (or the plain continuity pointers if that failed). '' for every later prompt, and for a handoff
 * prompt: that session runs sessionHandoffWake itself once the old session is archived.
 */
export async function boardContext(
  store: Store,
  sessionId: string,
  waitMs = BOARD_WAIT_MS,
  prompt = '',
  {
    transcriptPath,
    catchUp = catchUpTranscripts,
    spawnJob = spawnBoardJob,
  }: { transcriptPath?: string; catchUp?: typeof catchUpTranscripts; spawnJob?: (store: Store) => void } = {},
): Promise<string> {
  const pendingKey = PENDING_PREFIX + sessionId;
  const pending = store.getMeta(pendingKey);
  if (!pending) return '';
  store.deleteMeta(pendingKey);
  // After a compaction the session goes on: its questions keep their labels, its own talk is the one before.
  const { compact } = readPending(pending);
  if (prompt.trimStart().startsWith(HANDOFF_MARK)) return '';
  const started = Date.now();
  catchUp(store, transcriptPath);
  const current = readBoard(store);
  const tail = current ? store.logAfter(current.lastLogId) : [];
  // An emptied board (deleted conversation) is no board: wait for its rewrite like a first one.
  if (current?.text && estimateTokens(formatRows(tail)) <= BOARD_RAW_MAX_TOKENS) {
    if (tail.length) spawnJob(store);
    const job = readJob(store);
    store.logUsage('board_wait', 0, { session: sessionId, ok: true, waitedMs: Date.now() - started, raw: tail.length, chunks: null, jobMs: null, error: null });
    const failure = job?.done && !job.ok ? failureNote(job, store.getMeta(OK_VERSION_KEY)) : '';
    return [boardBlock(store, current, tail, sessionId, compact), failure].filter(Boolean).join('\n');
  }
  // A rewrite already running may have read the log before the latest turns; let it finish first.
  await waitForJob(store, waitMs);
  if (boardChunks(store, readBoard(store)).length > 0) {
    spawnJob(store);
    await waitForJob(store, waitMs - (Date.now() - started));
  }
  const job = readJob(store);
  const saved = readBoard(store);
  const board = saved?.text ? saved : undefined;
  const fresh = !!board && boardChunks(store, board).length === 0;
  store.logUsage('board_wait', 0, { session: sessionId, ok: fresh, waitedMs: Date.now() - started, chunks: job?.chunks ?? null, jobMs: job?.ms ?? null, error: job?.error ?? null });
  if (!board || !fresh) {
    const fallback = continuityContext(store, sessionId, compact);
    const note = board ? `\n(아래는 ${formatLocal(board.updatedAt)}의 옛 상황판 — 그 뒤 일은 빠져 있다)\n${board.text}` : '';
    const failure = job?.done && !job.ok ? failureNote(job, store.getMeta(OK_VERSION_KEY)) : '';
    if (!fallback && !note) return failure;
    return `${fallback}${note}\n상황판 갱신이 ${job?.done ? '실패' : '늦어'} 위 정보만 있다. 첫 답 맨 위에 \`> 이어서: …\`로 파악한 상황을 한 줄 적는다.${failure ? `\n${failure}` : ''}`;
  }
  return boardBlock(store, board, [], sessionId, compact);
}

/**
 * Why the rewrite (a `claude -p` run via run-job) failed. Right after a Claude Code update this is
 * how the secretary notices that -p broke, e.g. --bare becoming the default (no subscription login).
 */
export function failureNote(job: Job, okVersion: string | undefined): string {
  const lines = [`<${TAG.situationBoardFailure}>`, `상황판 갱신(run-job \`claude -p\`) 실패 이유: ${job.error ?? '알 수 없음'}`];
  if (job.version && okVersion && job.version !== okVersion) {
    lines.push(
      `Claude Code가 ${okVersion}에서 ${job.version}으로 바뀐 뒤 처음 실패했다. \`claude -p\` 기본 동작이 바뀌었을 수 있다(예: --bare 기본화로 구독 로그인을 읽지 않음). run-job과 상황판 갱신이 막혔을 수 있으니 첫 답에 이 사실과 오류를 알리고, run-job을 \`claude --bg\` 방식으로 옮길지 계획을 세워 묻는다.`,
    );
  } else {
    lines.push('첫 답에 실패 이유를 한 줄로 알린다.');
  }
  lines.push(`</${TAG.situationBoardFailure}>`);
  return lines.join('\n');
}

export function boardBlock(store: Store, board: Board, tail: LogEntry[] = [], sessionId?: string, compact = false): string {
  return [
    `<${TAG.situationBoard}>`,
    `상황판 (${formatLocal(board.updatedAt)} 갱신, 대화 #${board.lastLogId}까지 반영). 근거 번호는 search_log(log_id)로 조회한다.`,
    board.text,
    // Its open lines held to the decision memories (board-decisions.ts): the board never sees the memories.
    ...boardDecisionLines(store, board.text),
    ...(tail.length
      ? [
          `[상황판 뒤 대화 원문] (#${tail[0].id}~#${tail[tail.length - 1].id}, ${tail.length}개. 상황판에 아직 안 들어간 나중 일이니 상황판과 어긋나면 이것을 따른다. 상황판은 뒤에서 고쳐 쓰는 중)`,
          formatRows(tail),
          '[원문 끝]',
        ]
      : []),
    ...carryOverQuestions(store, sessionId, compact),
    ...runningTaskLines(store),
    // How to read the board: .agents/hook-notices/situation-board.md (the words live there, core/hook-notice-text.ts).
    hookNoticeText(NOTICE.situationBoard, 'reading'),
    `</${TAG.situationBoard}>`,
  ].join('\n');
}

const LAST_USER_LINES = 3;
const LAST_USER_CHARS = 100;
const LAST_MEMORY_IDS = 15;
const LAST_REPLY_TAIL_CHARS = 300;

function clipLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}
function clipTail(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(-n) : flat;
}

/**
 * New session (or /clear): where the last conversation left off, as pointers to expand; relabels open questions. After a
 * compaction the conversation to point at is this session's own, before it was compacted, and the labels stay.
 */
export function continuityContext(store: Store, currentSessionId?: string, compact = false): string {
  const own = compact && currentSessionId ? store.sessionTail(currentSessionId, 1)[0] : undefined;
  const prev = own ? { session_id: own.session_id, last_at: own.created_at } : store.lastOtherSession(currentSessionId);
  const open = openQuestionLines(store).length;
  const running = runningTaskLines(store);
  if (!prev && open === 0 && running.length === 0) return '';
  const lines = [`<${TAG.continuity}>`];
  if (prev) {
    const sid = prev.session_id.slice(0, 8);
    lines.push(`${own ? '압축 전 이 세션' : '직전 세션'} ${sid} (마지막 대화 ${formatLocal(prev.last_at)}). 사용자의 마지막 말:`);
    for (const u of store.sessionTail(prev.session_id, LAST_USER_LINES, 'user')) lines.push(`- "${clipLine(u.content, LAST_USER_CHARS)}"`);
    // The secretary's closing words usually say what it asked the user to do next.
    const [reply] = store.sessionTail(prev.session_id, 1, 'assistant');
    if (reply) lines.push(`비서의 마지막 답 끝: "…${clipTail(reply.content, LAST_REPLY_TAIL_CHARS)}"`);
    const ids = store.sessionMemoryIds(prev.session_id).slice(-LAST_MEMORY_IDS);
    if (ids.length) lines.push(`그 세션에서 저장한 기억: ${ids.map((i) => `#${i}`).join(' ')}`);
    lines.push(
      `사용자가 이어지는 이야기를 하면 search_log(session_id="${sid}")로 그 세션의 최근 대화를, recall(ids)로 기억을 조회해 확인하고 답한다.`,
    );
  }
  lines.push(...carryOverQuestions(store, currentSessionId, compact));
  lines.push(...running);
  lines.push(`</${TAG.continuity}>`);
  return lines.join('\n');
}
