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
import { openQuestionKeys, openQuestionLines, type ClosedQuestion, type QuestionKeys } from './open-questions.ts';
import { finishJob, jobRunning as recordRunning, readJob as readRecord, type JobRecord } from '../staff/job-record.ts';
import { runJobScript, stripSessionLine } from '../staff/launch.ts';
import { fixStaffFolder, readStaff, recordStaffRun } from '../staff/staff.ts';
import { renderMainAgenda, type LogEntry, type Store } from '../store/store.ts';
import { formatLocal, nowIso } from '../core/kst-time.ts';
import { CLI, STAFF } from '../core/names.ts';
import { NO_MODEL_ENV } from '../core/no-model-calls.ts';
import { featureOn, readFeatures } from '../core/features.ts';

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
/**
 * The board's sections in order: the format the rewrite is given, and what checkHeadings holds its answer to. Renaming one
 * here is enough: a board written with the old names gets the new ones by place (2026-11-12, Haiku copied the old heading).
 */
export const BOARD_HEADINGS = ['지금 주제', '진행 중인 사항', '사용자의 실행·확인·결정이 필요한 사항', '보류한 사항', '정한 사항', '비서가 확인할 사항', '풀린 듯한 질문', '바뀐 듯한 안건'];
const HEADING_LINE = /^##\s/;
export interface Board {
  text: string;
  lastLogId: number;
  updatedAt: string;
}
export interface Job extends JobRecord {
  chunks?: number;
  /** Claude Code version the rewrite ran on. */
  version?: string;
  /** Headings that were not the format's: what was renamed, or why they were left (also in the staff member's runs file). */
  headings?: string[];
  /** Question lines marked closed, or held from a mark in bulk (markClosedQuestions; also in the runs file). */
  questions?: string[];
}

/** A question label at the front of a board line: "- J: …", "- AP. …", "- F(새PC UAC 단계): …", "- **A(옛 G, #1234).** …". */
const QUESTION_LINE = /^\s*[-*]\s+\**([A-Z]{1,2})(?:\s?\([^()\n]{0,60}\))?\**\s*[:.：]/;
/** Put after a closed question line when why it closed is not known (a record written before the reason was kept). */
export const NOT_OPEN_MARK = '(끝난 듯, 답 없는 질문 목록에 없음)';
/** Lines already marked: the board's own "(끝난 듯, #N)" in any wording, or a mark of ours that does not say it. */
const ALREADY_MARKED = /끝난 듯|답 없는 질문 목록에서 빠짐/;

/**
 * The mark for a closed question, with why it closed and the row that shows it, so the secretary reads it right (fix C12
 * of the 2026-11-13 source review): "(끝난 듯: 사용자가 답함 #1234)". A question that only ran out of time or whose talk
 * was deleted is not called done: the board model drops "(끝난 듯" lines on its next rewrite, and those were never answered.
 */
export function closedMark(c: ClosedQuestion | undefined): string {
  switch (c?.reason) {
    case 'answered':
      return `(끝난 듯: 사용자가 답함${c.evidence ? ` #${c.evidence}` : ''})`;
    case 'not-in-list':
      return `(끝난 듯: 비서 답의 남은 질문에서 빠짐${c.evidence ? ` #${c.evidence}` : ''})`;
    case 'expired':
      return '(답 없는 질문 목록에서 빠짐: 7일 지남, 답 확인 안 됨)';
    case 'purged':
      return '(답 없는 질문 목록에서 빠짐: 물은 대화를 지움)';
    default:
      return NOT_OPEN_MARK;
  }
}

/**
 * The model keeps a question the user has answered as an open line (seen on the next board in the evaluation of
 * 2026-11-13): under "사용자의 실행·확인·결정이 필요한 사항", a line that starts with the label of a question the
 * open-question list (open-questions.ts, kept by the Stop hook) has closed gets closedMark, left in place like the board's
 * own "(끝난 듯, #N)" so the secretary checks before it goes (a line already marked is left as it is).
 *
 * - Only labels of questions really asked and closed (the closed records) are marked, so a line like "- PC: …" or
 *   "- UI: …" that only looks like a label is left alone (C12). A label open now, or the label an open question had in an
 *   earlier session (formerly), is open.
 * - No marks in bulk (C13): when the open list is empty, or every labelled line of the section would be marked (two or
 *   more), only the lines the user answered by label are marked; the rest are held (returned in `held`). That is the
 *   shape a deleted or rewound conversation, or a closing list that forgot its step, leaves; hindsight likewise leaves a
 *   page alone when all its evidence vanished at once. A real "all settled" still shows: the board model marks lines from
 *   the talk itself, and the user's answers are marked here.
 *
 * The log id a line cites is not used: one message asks several questions, so citing it says nothing about which is still
 * open (one message can ask one question and report others done). Lines under other headings (a question put on hold, say) are left alone.
 */
export function markClosedQuestions(text: string, keys: QuestionKeys | undefined): { text: string; marked: string[]; held: string[] } {
  if (!keys) return { text, marked: [], held: [] };
  const lines = text.split('\n');
  const found: Array<{ i: number; label: string; closed: ClosedQuestion }> = [];
  let labelled = 0;
  let inUserSection = false;
  for (const [i, line] of lines.entries()) {
    if (HEADING_LINE.test(line)) {
      inUserSection = line.replace(/^##\s+/, '').trim() === BOARD_HEADINGS[2];
      continue;
    }
    const label = inUserSection ? QUESTION_LINE.exec(line)?.[1] : undefined;
    if (!label) continue;
    labelled++;
    if (ALREADY_MARKED.test(line) || keys.labels.has(label)) continue;
    const closed = keys.closed.get(label);
    if (closed) found.push({ i, label, closed });
  }
  const bulk = keys.openCount === 0 || (found.length >= 2 && found.length === labelled);
  const marked: string[] = [];
  const held: string[] = [];
  for (const f of found) {
    if (bulk && f.closed.reason !== 'answered') {
      held.push(f.label);
      continue;
    }
    lines[f.i] = `${lines[f.i].trimEnd()} ${closedMark(f.closed)}`;
    marked.push(f.label);
  }
  return { text: lines.join('\n'), marked, held };
}

/** A board's `## ` headings held to BOARD_HEADINGS: the text with them renamed, what was renamed, or why it was not. */
export interface HeadingCheck {
  text: string;
  renamed: string[];
  problem?: string;
}

/**
 * Renames a board's headings that are not the format's, by place. Only when there are as many headings as the format has
 * and every heading the format knows stands in its own place: then an unknown one can only be the old name of the heading
 * that belongs there. Anything else (one missing, one added, two swapped) would put lines under the wrong heading, so the
 * text is left as it is and `problem` says why.
 */
export function checkHeadings(text: string): HeadingCheck {
  const lines = text.split('\n');
  const at = lines.flatMap((l, i) => (HEADING_LINE.test(l) ? [i] : []));
  const found = at.map((i) => lines[i].replace(/^##\s+/, '').trim());
  if (found.length === BOARD_HEADINGS.length && found.every((h, i) => h === BOARD_HEADINGS[i])) return { text, renamed: [] };
  const misplaced = found.some((h, i) => h !== BOARD_HEADINGS[i] && BOARD_HEADINGS.includes(h));
  if (found.length !== BOARD_HEADINGS.length || misplaced) {
    return { text, renamed: [], problem: `제목이 형식과 달라 못 고침(${found.length}개, 형식은 ${BOARD_HEADINGS.length}개): ${found.join(' / ')}` };
  }
  const renamed: string[] = [];
  at.forEach((line, k) => {
    if (found[k] === BOARD_HEADINGS[k]) return;
    renamed.push(`${found[k]} → ${BOARD_HEADINGS[k]}`);
    lines[line] = `## ${BOARD_HEADINGS[k]}`;
  });
  return { text: lines.join('\n'), renamed };
}

/** What a heading check leaves for the record; none when the headings were the format's. */
function headingNotes(check: HeadingCheck, where: string): string[] {
  if (check.problem) return [`${where}: ${check.problem}`];
  return check.renamed.length ? [`${where}: 제목 고침 ${check.renamed.join(', ')}`] : [];
}

/** True when the saved board still has headings of an older format that checkHeadings can rename (no model needed). */
export function boardHeadingsStale(store: Store): boolean {
  const text = readBoard(store)?.text;
  return !!text && checkHeadings(text).renamed.length > 0;
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
 * SessionStart (a new session, /clear or a compaction): mark this session as waiting for the board. The rewrite itself
 * starts on the first prompt: a remote server opens its next session ahead of time, and /clear can be followed by talk
 * on the other server, so a board written now would miss everything said before that prompt.
 */
export function startBoardUpdate(store: Store, sessionId: string, source?: string): void {
  // Sessions that never got a first prompt leave their flag behind; drop those older than a day.
  for (const { key, value } of store.metaWithPrefix(PENDING_PREFIX)) if (Date.now() - Date.parse(readPending(value).at) > 24 * 3600 * 1000) store.deleteMeta(key);
  store.setMeta(PENDING_PREFIX + sessionId, source === 'compact' ? `${COMPACT_MARK}${nowIso()}` : nowIso());
}

/**
 * A compaction (decided 2026-11-12) waits for the board too, but the session goes on: its open questions keep their labels
 * (mistake-guards/question-labels.ts) and its own earlier talk is "this session", not the last one. The flag's value says so.
 */
const COMPACT_MARK = 'compact ';

/** A waiting flag's value: when it was set and whether a compaction set it. */
export function readPending(value: string): { at: string; compact: boolean } {
  return value.startsWith(COMPACT_MARK) ? { at: value.slice(COMPACT_MARK.length), compact: true } : { at: value, compact: false };
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

/**
 * Right after an update (the secretary-update skill, `situation-board-update --detach`): starts a rewrite in the background
 * so the next session already reads the board in the new format, unless the board feature is off, models are not to be
 * called here (the tests' mark) or there is nothing to do. Says what it did.
 */
export function spawnBoardJobAfterUpdate(store: Store, env: NodeJS.ProcessEnv = process.env, root?: string): string {
  const feature = (readFeatures(root) ?? []).find((f) => f.id === 'session-continuity');
  if (feature && !featureOn(feature)) return '상황판 다시 쓰기 건너뜀: 상황판 기능이 꺼져 있어요.';
  if (env[NO_MODEL_ENV]) return `상황판 다시 쓰기 건너뜀: 모델을 부르지 않는 환경이에요(${NO_MODEL_ENV}).`;
  if (boardJobRunning(store)) return '상황판 다시 쓰기가 이미 돌고 있어요.';
  if (!boardBehind(store) && !boardHeadingsStale(store)) return '상황판이 이미 새 형식이고 그 뒤 대화도 없어요. 다시 쓰지 않았어요.';
  spawnBoardJob(store);
  return '상황판 다시 쓰기를 뒤에서 시작했어요. 끝나면 새 세션의 첫 질문에 새 형식의 상황판이 붙어요.';
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

export function boardPrompt(board: Board | undefined, rows: BoardRow[], openQuestions: string[], notes: string[] = [], mainAgenda = ''): string {
  const convo = formatRows(rows);
  return [
    '너는 개인 비서의 "상황판"을 고쳐 쓰는 정리 담당이다. 아래 형식의 상황판 글만 출력한다(앞뒤 설명 없이).',
    '상황판은 새 비서 세션이 맨 처음 읽고 "지금 무슨 일이 어디까지 됐는지" 바로 아는 데 쓴다. 비서는 사용자의 개인 비서다.',
    '',
    '규칙:',
    '- [직전 상황판]을 바탕으로 [새 대화]를 반영해 새 판을 쓴다. 아직 안 끝난 일은 남긴다.',
    '- "진행 중인 사항"·"사용자의 실행·확인·결정이 필요한 사항"·"비서가 확인할 사항"의 줄은 모두 남긴다. [새 대화]에서 사용자가 답했거나 끝났다고(비서가 했다고) 보이면 그 줄 끝에 "(끝난 듯, #1234)"처럼 근거 번호를 붙인다. 빼는 일은 비서가 확인해서 한다.',
    '- [직전 상황판]에서 이미 "(끝난 듯, …)"이 붙은 줄은, [새 대화]에서 비서가 아직 안 끝났다고 한 것이 아니면 지운다(오래 남을 결정이면 "정한 사항"으로 짧게 옮긴다).',
    '- 대화에 나온 것만 쓴다. 각 줄 끝에 근거 대화 번호를 (#1234)처럼 단다.',
    '- 특히 챙길 것: 비서가 사용자에게 부탁한 행동(실행, 확인, 결정), 사용자가 비서에게 시킨 일, 나중에 이야기하자고 미룬 것(질문 알파벳이 있으면 알파벳과 내용 함께).',
    '- "## 비서가 확인할 사항"에는 비서가 할 일·확인할 일만 쓰고, 줄마다 확인할 때를 대괄호로 맨 앞에 적는다. 지금 바로 할 일은 "- [지금] 서브에이전트 결과 검수 뒤 main 합치기 (#1234)", 무엇이 끝난 뒤로 미룬 일은 "- [비서 수정이 main에 합쳐진 뒤] 연습용 v7 설치 시험 꺼내기 (#1234)"처럼 그 조건을 그대로 적는다. 사용자가 하실 일은 "## 사용자의 실행·확인·결정이 필요한 사항"에만 쓴다.',
    '- [직전 상황판]의 "## 비서가 확인할 사항"에서 [지금]이 아닌 줄은, [새 대화]에서 그 조건이 채워졌다고 보이면(예: 합쳤다는 말, 커밋) 대괄호를 [지금]으로 바꾸고 줄 끝에 "(조건 채워진 듯, #1234)"처럼 근거 번호를 붙인다. 확실하지 않으면 그대로 둔다. 비서가 확인해서 꺼낸다.',
    '- [답 없는 질문 목록]의 질문 중 [새 대화]에서 사용자가 이미 답한 것으로 보이는 것은 "## 풀린 듯한 질문"에 "- C (#1234): 근거 한 줄"처럼 목록의 알파벳 그대로 적는다. 확실한 것만 적는다. 목록에서 지우는 일은 비서가 확인해서 한다.',
    '- 빠짐없이 정확히 쓰되, 한 줄에 한 사실을 짧게 쓰고, 한 내용은 한 항목에만 쓰고, 기억에 이미 저장된 결정은 한 줄 요지와 근거 번호만 쓴다. 끝난 일·풀린 질문은 뺀다(위 세 항목의 끝난 줄만 "(끝난 듯, …)"을 붙여 한 번 남긴다).',
    '- 안건(주요 현안의 한 줄, 몇 달 가는 프로젝트 단위)의 상태(진행 중/사용자 차례/보류/운영 중)는 상황판에 쓰지 않는다. 그 상태는 [주요 현안]에 있고 비서가 고친다. [새 대화]에서 안건의 상태가 [주요 현안]과 달라진 듯하거나 [주요 현안]에 없는 안건이 시작된 듯하면 "## 바뀐 듯한 안건"에만 "- 이름: 보류 → 진행 중 (#1234)"처럼 근거 번호와 함께 적는다(새 일은 "- 이름: 없음 → 진행 중 (#번호)").',
    '- 시각은 한국시간 24시 표기. 항목이 없으면 "없음".',
    '- 비밀번호·키 같은 민감정보는 쓰지 않는다(상황판은 DB에 남고 새 세션마다 비서 대화에 붙는다).',
    '',
    '형식:',
    '요약: <지금 상황 한 줄>',
    ...BOARD_HEADINGS.map((h) => `## ${h}`),
    '',
    '[직전 상황판]',
    board?.text ? board.text : '(없음 — 처음 만든다)',
    '',
    '[주요 현안] (읽기만)',
    mainAgenda || '(비어 있음)',
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
  const headings: string[] = [];
  const questions: string[] = [];
  const finish = (ok: boolean, error?: string): Job => {
    if (ok && version) store.setMeta(OK_VERSION_KEY, version);
    const done = finishJob(store, JOB_KEY, job, ok, error, { version, ...(headings.length ? { headings } : {}), ...(questions.length ? { questions } : {}) });
    if (chunks.length || headings.length) {
      recordStaffRun(boardWorker(), { at: nowIso(), ok, chunks: chunks.length, ms: done.ms, pid: process.pid, ...(error ? { error: error.slice(0, 300) } : {}), ...(headings.length ? { headings } : {}), ...(questions.length ? { questions } : {}) });
    }
    return done;
  };
  if (chunks.length === 0) {
    // Nothing new was said, but the format's headings may have changed since the board was written: rename them in place.
    const check = board?.text ? checkHeadings(board.text) : undefined;
    if (board && check?.renamed.length) store.setJson(BOARD_KEY, { ...board, text: check.text });
    if (check) headings.push(...headingNotes(check, '새 대화 없음, 저장된 판'));
    return finish(true);
  }
  const file = path.join(os.tmpdir(), `secretary-board-${process.pid}.txt`);
  try {
    // Its folder and role (workspaces/_staff/situation-board) are made here when missing, so a new install needs no step first.
    fixStaffFolder(boardWorker());
    version = await (deps.claudeVersion ?? claudeVersion)();
    for (const [i, rows] of chunks.entries()) {
      fs.writeFileSync(file, boardPrompt(board, rows, openQuestionLines(store), notes, renderMainAgenda(store.mainAgenda())), 'utf8');
      const out = await (deps.runJob ?? runJob)(file);
      const answer = parseBoard(out);
      if (!answer) return finish(false, `상황판 형식이 아닌 답 (${i + 1}/${chunks.length}번째 부분): ${out.trim().slice(0, 300)}`);
      // Conversation was deleted while this ran: what it read may include it. The next rewrite starts over.
      if ((store.getMeta(RESET_KEY) ?? '') > job.startedAt) return finish(true);
      // The model may copy the previous board's old headings (2026-11-12): renamed by place, or kept as written and recorded.
      const check = checkHeadings(answer);
      headings.push(...headingNotes(check, `${i + 1}/${chunks.length}번째 부분`));
      // Question lines the open-question list no longer holds are marked, not dropped (markClosedQuestions).
      const closed = markClosedQuestions(check.text, openQuestionKeys(store));
      if (closed.marked.length) questions.push(`질문 줄 끝남 표시(${i + 1}/${chunks.length}번째 부분): ${closed.marked.join(', ')}`);
      if (closed.held.length) questions.push(`질문 줄 한꺼번에 표시 안 함(답 없는 질문 목록이 비었거나 모든 질문 줄이 해당, ${i + 1}/${chunks.length}번째 부분): ${closed.held.join(', ')}`);
      board = { text: closed.text, lastLogId: coveredLogId(rows), updatedAt: nowIso() };
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
