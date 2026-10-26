/**
 * The situation board: one running summary of where things stand across secretary sessions
 * (topic, work in flight, what each side is waiting on, parked items, decisions, next steps).
 * A new session (startup or /clear) starts a background rewrite — the previous board plus every
 * conversation logged since — by Haiku (effort medium) on the same Claude subscription, through run-job. The session's first
 * prompt waits for it and injects the board, so the new session wakes up knowing the situation.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { carryOverQuestions, continuityContext, openQuestionLines } from './continuity.ts';
import { ingestTranscript } from './ingest.ts';
import type { LogEntry, Store } from './store.ts';
import { formatLocal, nowIso } from './text.ts';

const BOARD_KEY = 'situation_board';
const JOB_KEY = 'board_job';
const PENDING_PREFIX = 'board_pending:';
/** A job older than this per chunk is treated as dead (killed, crashed) and may be replaced. */
const JOB_STALE_MS = 4 * 60 * 1000;
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
/** The first prompt waits for the rewrite to finish; this only guards a stuck job (hook timeout 330 s). */
export const BOARD_WAIT_MS = 5 * 60 * 1000;
/** Conversation fed to one rewrite (roughly 100k tokens of Korean); a bigger backlog is read in chunks. */
const INPUT_MAX_CHARS = 150_000;
const SUMMARY_LINE = /^\s*요약\s*[:：]\s*(.+)$/m;
/** First words of the prompt the handoff skill opens a new session with. */
export const HANDOFF_MARK = '[이전 비서 세션에서 넘긴 맥락]';
/** Other sessions' transcripts untouched this long are caught up at session start; younger ones may be mid-turn. */
const CATCH_UP_MIN_IDLE_MS = 10 * 60 * 1000;
const CATCH_UP_MAX_AGE_MS = 24 * 3600 * 1000;

interface Board {
  text: string;
  lastLogId: number;
  updatedAt: string;
}
interface Job {
  pid?: number;
  startedAt: string;
  chunks?: number;
  done?: boolean;
  ok?: boolean;
  error?: string;
  ms?: number;
}

export function readBoard(store: Store): Board | undefined {
  const raw = store.getMeta(BOARD_KEY);
  return raw ? (JSON.parse(raw) as Board) : undefined;
}
function readJob(store: Store): Job | undefined {
  const raw = store.getMeta(JOB_KEY);
  return raw ? (JSON.parse(raw) as Job) : undefined;
}
function jobRunning(job: Job | undefined): boolean {
  return !!job && !job.done && Date.now() - Date.parse(job.startedAt) < JOB_STALE_MS * Math.max(1, job.chunks ?? 1);
}

/** SessionStart: mark this session as waiting for the board and start a rewrite unless one is running. */
export function startBoardUpdate(store: Store, sessionId: string): void {
  // Sessions that never got a first prompt leave their flag behind; drop those older than a day.
  for (const { key, value } of store.metaWithPrefix(PENDING_PREFIX)) if (Date.now() - Date.parse(value) > 24 * 3600 * 1000) store.deleteMeta(key);
  store.setMeta(PENDING_PREFIX + sessionId, nowIso());
  if (jobRunning(readJob(store))) return;
  store.setMeta(JOB_KEY, JSON.stringify({ startedAt: nowIso() } satisfies Job));
  const child = spawn(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'cli.ts'), 'board-update'], {
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

export function boardPrompt(board: Board | undefined, rows: BoardRow[], openQuestions: string[], notes: string[] = []): string {
  const convo = rows
    .map((r) => {
      const part = r.part ? ` (${r.part.index}/${r.part.count} 부분)` : '';
      return `[#${r.id} ${formatLocal(r.created_at)} 세션 ${r.session_id.slice(0, 8)} ${r.role === 'user' ? '사용자' : '비서'}${part}]\n${r.content}`;
    })
    .join('\n\n');
  return [
    '너는 개인 비서의 "상황판"을 고쳐 쓰는 정리 담당이다. 도구를 쓰지 말고, 아래 형식의 상황판 글만 출력한다(앞뒤 설명 없이).',
    '상황판은 새 비서 세션이 맨 처음 읽고 "지금 무슨 일이 어디까지 됐는지" 바로 아는 데 쓴다. 비서는 사용자의 개인 비서다.',
    '',
    '규칙:',
    '- [직전 상황판]을 바탕으로 [새 대화]를 반영해 새 판을 쓴다. 새 대화에서 끝난 일은 지우거나 "정한 것"으로 짧게 옮기고, 아직 안 끝난 일은 남긴다.',
    '- 대화에 나온 것만 쓴다. 짐작은 쓰지 않는다. 각 줄 끝에 근거 대화 번호를 (#1234)처럼 단다.',
    '- 특히 놓치지 말 것: 비서가 사용자에게 부탁한 행동(실행, 확인, 결정), 사용자가 비서에게 시킨 일, 나중에 이야기하자고 미룬 것(질문 기호가 있으면 기호와 내용 함께).',
    '- 시각은 한국시간 24시 표기. 1,500자 안팎. 항목이 없으면 "없음".',
    '- 비밀번호·키 같은 민감정보는 쓰지 않는다.',
    '',
    '형식:',
    '요약: <지금 상황 한 줄, 60자 안팎>',
    '## 지금 주제',
    '## 진행 중',
    '## 부탁하고 기다리는 것',
    '## 보류',
    '## 정한 것',
    '## 다음 행동',
    '',
    '[직전 상황판]',
    board ? board.text : '(없음 — 처음 만든다)',
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
  const text = output.replace(/\n?\((?:새 세션|이어 부름)\) 세션:.*$/s, '').trim();
  return SUMMARY_LINE.test(text) ? text.slice(text.search(SUMMARY_LINE)).trim() : null;
}

function runJob(promptFile: string): Promise<string> {
  const script = path.join(PROJECT_ROOT, 'scripts', 'run-job.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Model', 'haiku', '-Effort', 'medium', '-New', '-PromptFile', promptFile];
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`.slice(0, 500))) : resolve(stdout),
    );
  });
}

/**
 * Background worker (cli board-update): rewrite the board chunk by chunk, saving after each so a
 * later failure keeps the earlier progress, and record how it went.
 */
export async function runBoardUpdate(store: Store, notes: string[] = []): Promise<Job> {
  const started = Date.now();
  let board = readBoard(store);
  const chunks = boardChunks(store, board);
  const job: Job = { pid: process.pid, startedAt: new Date(started).toISOString(), chunks: chunks.length };
  store.setMeta(JOB_KEY, JSON.stringify(job));
  const finish = (ok: boolean, error?: string): Job => {
    const done = { ...job, done: true, ok, error, ms: Date.now() - started };
    store.setMeta(JOB_KEY, JSON.stringify(done));
    return done;
  };
  if (chunks.length === 0) return finish(true);
  const file = path.join(os.tmpdir(), `secretary-board-${process.pid}.txt`);
  try {
    for (const [i, rows] of chunks.entries()) {
      fs.writeFileSync(file, boardPrompt(board, rows, openQuestionLines(store), notes), 'utf8');
      const text = parseBoard(await runJob(file));
      if (!text) return finish(false, `상황판 형식이 아닌 답 (${i + 1}/${chunks.length}번째 덩어리)`);
      board = { text, lastLogId: coveredLogId(rows), updatedAt: nowIso() };
      store.setMeta(BOARD_KEY, JSON.stringify(board));
    }
    return finish(true);
  } catch (err) {
    return finish(false, (err as Error).message);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * UserPromptSubmit: on the first prompt of a session that started a rewrite, wait for it and
 * inject the board (or the plain continuity pointers if it failed). '' for every later prompt,
 * and for a handoff prompt: that session runs handoffWake itself once the old session is archived.
 */
export async function boardContext(store: Store, sessionId: string, waitMs = BOARD_WAIT_MS, prompt = ''): Promise<string> {
  const pendingKey = PENDING_PREFIX + sessionId;
  if (!store.getMeta(pendingKey)) return '';
  store.deleteMeta(pendingKey);
  if (prompt.trimStart().startsWith(HANDOFF_MARK)) return '';
  const started = Date.now();
  await waitForJob(store, waitMs);
  const job = readJob(store);
  const board = readBoard(store);
  const fresh = !!job?.done && job.ok;
  store.logUsage('board_wait', 0, { session: sessionId, ok: fresh, waitedMs: Date.now() - started, chunks: job?.chunks ?? null, jobMs: job?.ms ?? null, error: job?.error ?? null });
  if (!board || !fresh) {
    const fallback = continuityContext(store, sessionId);
    const note = board ? `\n(아래는 ${formatLocal(board.updatedAt)}의 옛 상황판 — 그 뒤 일은 빠져 있다)\n${board.text}` : '';
    return fallback || note ? `${fallback}${note}\n상황판 갱신이 ${job?.done ? '실패' : '늦어'} 위 정보만 있다. 첫 답 맨 위에 \`> 이어서: …\`로 파악한 상황을 한 줄 적는다.` : '';
  }
  return boardBlock(store, board);
}

async function waitForJob(store: Store, waitMs: number): Promise<void> {
  const until = Date.now() + waitMs;
  while (jobRunning(readJob(store)) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
}

function boardBlock(store: Store, board: Board): string {
  return [
    '<secretary-board>',
    `상황판 (${formatLocal(board.updatedAt)} 갱신, 대화 #${board.lastLogId}까지 반영). 근거 번호는 search_log(log_id)로 펼친다.`,
    board.text,
    ...carryOverQuestions(store),
    '이 세션의 첫 답 맨 위에 `> 이어서: …`로 상황판에서 읽은 지금 상황을 한 줄 적는다(사용자가 틀린 곳을 바로 고칠 수 있게).',
    '</secretary-board>',
  ].join('\n');
}

/** This project's transcript folders under the Claude config dir (CLAUDE_CONFIG_DIR, else ~/.claude). */
export function transcriptDirs(): string[] {
  const name = PROJECT_ROOT.replace(/[^A-Za-z0-9]/g, '-');
  const roots = new Set([process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean) as string[]);
  return [...roots].map((r) => path.join(r, 'projects', name)).filter((d) => fs.existsSync(d));
}

/**
 * SessionStart: log what other sessions' Stop hooks missed, e.g. a turn cut off because the
 * session was archived mid-turn. Transcripts touched in the last few minutes are left alone.
 */
export function catchUpTranscripts(store: Store, currentPath?: string): number {
  let added = 0;
  const now = Date.now();
  for (const dir of transcriptDirs()) {
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      if (!f.endsWith('.jsonl') || (currentPath && path.resolve(file) === path.resolve(currentPath))) continue;
      // One unreadable file (deleted or locked mid-scan) must not cost the session its profile injection.
      try {
        const age = now - fs.statSync(file).mtimeMs;
        if (age >= CATCH_UP_MIN_IDLE_MS && age <= CATCH_UP_MAX_AGE_MS) added += ingestTranscript(store, file).added;
      } catch (err) {
        process.stderr.write(`[secretary] catch-up skipped ${f}: ${(err as Error).message}\n`);
      }
    }
  }
  return added;
}

/**
 * cli handoff-wake: the new session, after archiving the old one, logs the old session's
 * last turn, rewrites the board and gets it back to read.
 */
export async function handoffWake(store: Store, oldSessionId: string): Promise<string> {
  const files = transcriptDirs().map((d) => path.join(d, `${oldSessionId}.jsonl`)).filter((f) => fs.existsSync(f));
  if (files.length === 0) return `옛 세션 ${oldSessionId}의 대화 기록 파일을 찾지 못했다.`;
  const added = files.reduce((n, f) => n + ingestTranscript(store, f).added, 0);
  await waitForJob(store, BOARD_WAIT_MS);
  // Archiving happens before this call and is not in any transcript, so tell the rewrite.
  const job = await runBoardUpdate(store, [`${formatLocal(nowIso())} 새 세션이 옛 세션(대화 기록 ${oldSessionId.slice(0, 8)})이 멈춘 것을 확인하고 보관했다. 넘기기는 끝났다.`]);
  const board = readBoard(store);
  if (!board || !job.ok) return `상황판 갱신 실패: ${job.error ?? '상황판 없음'}`;
  return `(옛 세션 대화 ${added}개를 새로 저장함)\n${boardBlock(store, board)}`;
}
