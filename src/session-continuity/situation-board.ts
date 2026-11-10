/**
 * The situation board: one running summary of where things stand across secretary sessions
 * (topic, work in flight, what each side is waiting on, parked items, decisions, next steps).
 * A rewrite — the previous board plus every conversation logged since — is done by a small model
 * (Haiku on account a) in the background: by the idle jobs once talk has paused (idle/idle-jobs.ts),
 * and after a new session's first prompt. That prompt does not wait for it: it gets the board plus the
 * raw conversation logged after it, and waits for a rewrite only when that raw tail is too long.
 * What the session is then told is in situation-board-notice.ts; the handoff wake-up in session-handoff.ts.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertModelCallsAllowed } from '../core/no-model-calls.ts';
import { scriptPath } from '../core/paths.ts';
import { openQuestionLines } from './open-questions.ts';
import { finishJob, jobRunning as recordRunning, readJob as readRecord, type JobRecord } from '../staff/job-record.ts';
import { runJobScript, stripSessionLine } from '../staff/launch.ts';
import { fixStaffFolder, readStaff, recordStaffRun } from '../staff/staff.ts';
import { renderBigWork, type LogEntry, type Store } from '../store/store.ts';
import { formatLocal, nowIso } from '../core/kst-time.ts';
import { CLI, STAFF } from '../core/names.ts';

const BOARD_KEY = 'situation_board';
const JOB_KEY = 'board_job';
/** Claude Code version of the last rewrite that succeeded; a failure after an update hints at a -p default change (e.g. --bare). */
export const OK_VERSION_KEY = 'board_ok_claude_version';
/** Set at session start for a session whose first prompt gets the board (situation-board-notice.ts boardContext). */
export const PENDING_PREFIX = 'board_pending:';
/** When a board was emptied because conversation it had read was deleted; a rewrite started before that does not save. */
const RESET_KEY = 'board_reset_at';
/** After such a reset the rewrite builds the board again from this many of the newest remaining rows. */
const RESET_REREAD_ROWS = 300;
/** The rewrite is the staff member situation-board (src/staff/situation-board.json: model, tools, time per chunk; its folder workspaces/_staff/situation-board). */
export const BOARD_STAFF = STAFF.situationBoard;
const boardWorker = () => readStaff(BOARD_STAFF);
/** Time one chunk may take (the staff member's limit). */
const runTimeoutMs = () => boardWorker().timeoutMinutes * 60_000;
/** A job older than this per chunk (the limit and a minute) is treated as dead (killed, crashed) and may be replaced. */
const jobStaleMs = () => runTimeoutMs() + 60_000;
/** The first prompt waits for the rewrite to finish; this only guards a stuck job (hook timeout 330 s). */
export const BOARD_WAIT_MS = 5 * 60 * 1000;
/** Conversation fed to one rewrite (roughly 100k tokens of Korean); a bigger backlog is read in chunks. */
const INPUT_MAX_CHARS = 150_000;
/** Raw conversation after the board that a first prompt gets as is; a longer tail waits for a rewrite. */
export const BOARD_RAW_MAX_TOKENS = 8_000;
const SUMMARY_LINE = /^\s*요약\s*[:：]\s*(.+)$/m;
export interface Board {
  text: string;
  lastLogId: number;
  updatedAt: string;
}
export interface Job extends JobRecord {
  chunks?: number;
  /** Claude Code version the rewrite ran on. */
  version?: string;
}

export function readBoard(store: Store): Board | undefined {
  return store.getJson<Board>(BOARD_KEY);
}
export function readJob(store: Store): Job | undefined {
  return readRecord<Job>(store, JOB_KEY);
}
/** True when the board has read conversation from `logId` on (deleting it must empty the board). */
export function boardReflects(store: Store, logId: number): boolean {
  const board = readBoard(store);
  return !!board?.text && board.lastLogId >= logId;
}

/**
 * After conversation rows were deleted (log/purge.ts deleteLogRows: "비서 대화 삭제" or a rewind): a board that had read
 * them is emptied, so their content is not carried on, and the next rewrite (idle jobs, or a new session's first
 * prompt) builds it again from the last RESET_REREAD_ROWS remaining rows. Returns whether it was emptied.
 */
export function resetBoardAfterPurge(store: Store, minLogId: number): boolean {
  if (!boardReflects(store, minLogId)) return false;
  const nth = store.db.prepare('SELECT id FROM raw_log ORDER BY id DESC LIMIT 1 OFFSET ?').get(RESET_REREAD_ROWS - 1) as { id: number } | undefined;
  store.setJson(BOARD_KEY, { text: '', lastLogId: (nth?.id ?? 1) - 1, updatedAt: nowIso() } satisfies Board);
  store.setMeta(RESET_KEY, nowIso());
  return true;
}

export function boardJobRunning(store: Store): boolean {
  return jobRunning(readJob(store));
}
function jobRunning(job: Job | undefined): boolean {
  return recordRunning(job, jobStaleMs() * Math.max(1, job?.chunks ?? 1));
}

/**
 * SessionStart: mark this session as waiting for the board. The rewrite itself starts on the first
 * prompt: a remote server opens its next session ahead of time, and /clear can be followed by talk
 * on the other server, so a board written now would miss everything said before that prompt.
 */
export function startBoardUpdate(store: Store, sessionId: string): void {
  // Sessions that never got a first prompt leave their flag behind; drop those older than a day.
  for (const { key, value } of store.metaWithPrefix(PENDING_PREFIX)) if (Date.now() - Date.parse(value) > 24 * 3600 * 1000) store.deleteMeta(key);
  store.setMeta(PENDING_PREFIX + sessionId, nowIso());
}

/** Starts a detached rewrite unless one is running. */
export function spawnBoardJob(store: Store): void {
  if (jobRunning(readJob(store))) return;
  // The detached rewrite calls claude: refused under the tests' mark before anything is recorded or started.
  assertModelCallsAllowed(CLI.situationBoardUpdate);
  store.setJson(JOB_KEY, { startedAt: nowIso() } satisfies Job);
  const child = spawn(process.execPath, ['--no-warnings', scriptPath('cli'), CLI.situationBoardUpdate], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/** A logged message, or one piece of a message longer than a whole chunk. */
export type BoardRow = LogEntry & { part?: { index: number; count: number } };

/** The conversation the next rewrite reads: everything after the board, oldest first, in chunks under the cap. */
export function boardChunks(store: Store, board: Board | undefined, maxChars = INPUT_MAX_CHARS): BoardRow[][] {
  const chunks: BoardRow[][] = [];
  let chunk: BoardRow[] = [];
  let total = 0;
  for (const row of store.logAfter(board?.lastLogId ?? 0)) {
    const count = Math.ceil(row.content.length / maxChars) || 1;
    for (let index = 1; index <= count; index++) {
      const content = row.content.slice((index - 1) * maxChars, index * maxChars);
      if (chunk.length && total + content.length > maxChars) {
        chunks.push(chunk);
        chunk = [];
        total = 0;
      }
      chunk.push(count > 1 ? { ...row, content, part: { index, count } } : row);
      total += content.length;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/** The last log id a chunk fully covers; a message cut off mid-way is read again next time. */
function coveredLogId(rows: BoardRow[]): number {
  const last = rows[rows.length - 1];
  return last.part && last.part.index < last.part.count ? last.id - 1 : last.id;
}

/** Logged messages as the rewrite and the first prompt read them: a header line with the log id, then the text. */
export function formatRows(rows: BoardRow[]): string {
  return rows
    .map((r) => {
      const part = r.part ? ` (${r.part.index}/${r.part.count} 부분)` : '';
      return `[#${r.id} ${formatLocal(r.created_at)} 세션 ${r.session_id.slice(0, 8)} ${r.role === 'user' ? '사용자' : '비서'}${part}]\n${r.content}`;
    })
    .join('\n\n');
}

/** True when conversation was logged after the board (or there is conversation but no board yet). */
export function boardBehind(store: Store): boolean {
  return boardChunks(store, readBoard(store)).length > 0;
}

export function boardPrompt(board: Board | undefined, rows: BoardRow[], openQuestions: string[], notes: string[] = [], bigWork = ''): string {
  const convo = formatRows(rows);
  return [
    '너는 개인 비서의 "상황판"을 고쳐 쓰는 정리 담당이다. 도구를 쓰지 말고, 아래 형식의 상황판 글만 출력한다(앞뒤 설명 없이).',
    '상황판은 새 비서 세션이 맨 처음 읽고 "지금 무슨 일이 어디까지 됐는지" 바로 아는 데 쓴다. 비서는 사용자의 개인 비서다.',
    '',
    '규칙:',
    '- [직전 상황판]을 바탕으로 [새 대화]를 반영해 새 판을 쓴다. 아직 안 끝난 일은 남긴다.',
    '- "진행 중"·"부탁하고 기다리는 것"·"비서가 확인할 것"의 줄은 지우지 않는다. [새 대화]에서 사용자가 답했거나 끝났다고(비서가 했다고) 보이면 그 줄 끝에 "(끝난 듯, #3247)"처럼 근거 번호를 붙여 남긴다. 비서가 확인해서 뺀다.',
    '- [직전 상황판]에서 이미 "(끝난 듯, …)"이 붙은 줄은, [새 대화]에서 비서가 아직 안 끝났다고 한 것이 아니면 지운다(오래 남을 결정이면 "정한 것"으로 짧게 옮긴다).',
    '- 대화에 나온 것만 쓴다. 짐작은 쓰지 않는다. 각 줄 끝에 근거 대화 번호를 (#1234)처럼 단다.',
    '- 특히 놓치지 말 것: 비서가 사용자에게 부탁한 행동(실행, 확인, 결정), 사용자가 비서에게 시킨 일, 나중에 이야기하자고 미룬 것(질문 기호가 있으면 기호와 내용 함께).',
    '- "## 비서가 확인할 것"에는 비서가 할 일·확인할 일만 쓰고, 줄마다 확인할 때를 대괄호로 맨 앞에 적는다. 지금 바로 할 일은 "- [지금] 서브에이전트 결과 검수 뒤 main 합치기 (#5020)", 무엇이 끝난 뒤로 미룬 일은 "- [비서 수정이 main에 합쳐진 뒤] 연습용 v7 설치 시험 꺼내기 (#5015)"처럼 그 조건을 그대로 적는다. 미룬 일을 [지금]으로 쓰지 않는다. 사용자가 하실 일은 이 칸에 쓰지 않고 "## 부탁하고 기다리는 것"에만 쓴다.',
    '- [직전 상황판]의 "## 비서가 확인할 것"에서 [지금]이 아닌 줄은, [새 대화]에서 그 조건이 채워졌다고 보이면(예: 합쳤다는 말, 커밋) 대괄호를 [지금]으로 바꾸고 줄 끝에 "(조건 채워진 듯, #5031)"처럼 근거 번호를 붙인다. 확실하지 않으면 그대로 둔다. 비서가 확인해서 꺼낸다.',
    '- [답 없는 질문 목록]의 질문 중 [새 대화]에서 사용자가 이미 답한 것으로 보이는 것은 "## 풀린 듯한 질문"에 "- C (#2975): 근거 한 줄"처럼 목록의 기호 그대로 적는다. 확실하지 않으면 적지 않는다. 목록에서 지우는 일은 비서가 확인해서 한다.',
    '- 빠뜨리지 않게 정확히 쓰되, 한 줄에 한 사실을 짧게 쓰고, 같은 내용을 두 칸에 쓰지 않으며, 기억에 이미 저장된 결정은 한 줄 요지와 근거 번호만 쓴다. 끝난 일·풀린 질문은 남기지 않는다(위 세 칸의 끝난 줄만 "(끝난 듯, …)"을 붙여 한 번 남긴다).',
    '- 큰 일(몇 달 가는 프로젝트 단위)의 상태(진행 중/사용자 차례/보류/운영 중)는 상황판에 쓰지 않는다. 그 상태는 [큰 일 판]에 있고 비서가 고친다. [새 대화]에서 큰 일의 상태가 [큰 일 판]과 달라진 듯하거나 판에 없는 큰 일이 시작된 듯하면 "## 큰 일 바뀐 듯"에만 "- 이름: 보류 → 진행 중 (#4210)"처럼 근거 번호와 함께 적는다(새 일은 "- 이름: 없음 → 진행 중 (#번호)").',
    '- 시각은 한국시간 24시 표기. 항목이 없으면 "없음".',
    '- 비밀번호·키 같은 민감정보는 쓰지 않는다.',
    '',
    '형식:',
    '요약: <지금 상황 한 줄>',
    '## 지금 주제',
    '## 진행 중',
    '## 부탁하고 기다리는 것',
    '## 보류',
    '## 정한 것',
    '## 비서가 확인할 것',
    '## 풀린 듯한 질문',
    '## 큰 일 바뀐 듯',
    '',
    '[직전 상황판]',
    board?.text ? board.text : '(없음 — 처음 만든다)',
    '',
    '[큰 일 판] (읽기만. 상황판에 옮겨 쓰지 않는다)',
    bigWork || '(비어 있음)',
    '',
    '[답 없는 질문 목록(비서 답에서 자동 추출)]',
    openQuestions.length ? openQuestions.join('\n') : '(없음)',
    '',
    ...(notes.length ? ['[대화 밖에서 확인된 사실] (대화보다 나중 일이므로 이것을 따른다)', ...notes, ''] : []),
    `[새 대화] (오래된 것부터 ${rows.length}개)`,
    convo || '(없음)',
  ].join('\n');
}

/** Strips run-job's trailing session line; null if the text is not a board. */
export function parseBoard(output: string): string | null {
  const text = stripSessionLine(output);
  return SUMMARY_LINE.test(text) ? text.slice(text.search(SUMMARY_LINE)).trim() : null;
}

function runJob(promptFile: string): Promise<string> {
  // The staff member's values (account a, Haiku, no tools) are in src/staff/situation-board.json; it runs in its own folder.
  return runJobScript(['-Staff', BOARD_STAFF], promptFile, runTimeoutMs());
}

function claudeVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    assertModelCallsAllowed('claude --version');
    execFile('claude', ['--version'], { timeout: 30_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim().split(/\s/)[0] || undefined),
    );
  });
}

/** What a rewrite runs (tests put fakes in): one run-job per chunk, and the Claude Code version it ran on. */
export interface BoardDeps {
  runJob?: (promptFile: string) => Promise<string>;
  claudeVersion?: () => Promise<string | undefined>;
}

/**
 * Background worker (cli situation-board-update): rewrite the board chunk by chunk, saving after each so a
 * later failure keeps the earlier progress, and record how it went.
 */
export async function runBoardUpdate(store: Store, notes: string[] = [], deps: BoardDeps = {}): Promise<Job> {
  let board = readBoard(store);
  const chunks = boardChunks(store, board);
  const job: Job = { pid: process.pid, startedAt: nowIso(), chunks: chunks.length };
  store.setJson(JOB_KEY, job);
  let version: string | undefined;
  const finish = (ok: boolean, error?: string): Job => {
    if (ok && version) store.setMeta(OK_VERSION_KEY, version);
    const done = finishJob(store, JOB_KEY, job, ok, error, { version });
    if (chunks.length) recordStaffRun(boardWorker(), { at: nowIso(), ok, chunks: chunks.length, ms: done.ms, pid: process.pid, ...(error ? { error: error.slice(0, 300) } : {}) });
    return done;
  };
  if (chunks.length === 0) return finish(true);
  const file = path.join(os.tmpdir(), `secretary-board-${process.pid}.txt`);
  try {
    // Its folder and role (workspaces/_staff/situation-board) are made here when missing, so a new install needs no step first.
    fixStaffFolder(boardWorker());
    version = await (deps.claudeVersion ?? claudeVersion)();
    for (const [i, rows] of chunks.entries()) {
      fs.writeFileSync(file, boardPrompt(board, rows, openQuestionLines(store), notes, renderBigWork(store.bigWork())), 'utf8');
      const out = await (deps.runJob ?? runJob)(file);
      const text = parseBoard(out);
      if (!text) return finish(false, `상황판 형식이 아닌 답 (${i + 1}/${chunks.length}번째 덩어리): ${out.trim().slice(0, 300)}`);
      // Conversation was deleted while this ran: what it read may include it. The next rewrite starts over.
      if ((store.getMeta(RESET_KEY) ?? '') > job.startedAt) return finish(true);
      board = { text, lastLogId: coveredLogId(rows), updatedAt: nowIso() };
      store.setJson(BOARD_KEY, board);
    }
    return finish(true);
  } catch (err) {
    return finish(false, (err as Error).message);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function waitForJob(store: Store, waitMs: number): Promise<void> {
  const until = Date.now() + waitMs;
  while (jobRunning(readJob(store)) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
}
