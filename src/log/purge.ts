/**
 * "비서 대화 삭제": the user deletes chosen conversation rows from the secretary DB, e.g. a turn that makes every
 * model call fail once it is read back (memory injection, the board, search_log). Two ways in: a fixed phrase
 * ("비서 대화 삭제 2턴", "비서 대화 삭제 #120-#135"; before 2026-11-06 "대화 지워 …"), and `node src/cli.ts purge-log` run directly by the user or the secretary.
 * - The phrase is not blocked (a block reason does not show on the phone): the prompt hook hands it to the
 *   secretary with only an order to run `purge-log preview …` once and pass its output on, and nothing else
 *   (no memories, board or notices). The preview lists the rows (id, who, length, word count) with each word's
 *   first letter (log/purge-initials.ts: never the text, no model call) and ends in a 6-character approval code.
 * - The user sends just that code (within 30 minutes): the prompt hook deletes without the model, if the rows
 *   and memories are still the ones the code was made for. The code message still reaches the secretary, with only
 *   the result (ids, times, roles, lengths, memory numbers: purgeDone) and the order to pass it on; no next-prompt notice.
 * - The phrase, its preview answer, the code message and its result answer are not conversation: turns are counted without them,
 *   so a preview does not shift the next one's target, and they are never in a list.
 *
 * What a deletion does (deleteLogRows, also used for a branch a rewind abandoned, log/rewind.ts):
 * - The rows are copied into a separate SQLite file, backups/error/purged-log-error.db (the "quarantine"),
 *   inside SQLite (ATTACH + INSERT … SELECT): their text never passes through this program's output. The file
 *   is append-only (triggers) and only a temporary keep: missing, it is made again; the user may delete it any time.
 * - In the main DB the rows and their search index go (freed pages zeroed, index merged, WAL written back), their
 *   identifiers go on purged_log_ids (no content) so ingest never logs them again, memories saved in those turns
 *   are invalidated, a board that had read them is emptied for a rewrite, and open questions asked in them leave
 *   the list. raw_log ids are never handed out again (AUTOINCREMENT), so no watermark moves.
 * - Transcript files are not touched.
 *
 * Nothing reads the quarantine except restorePurged (run directly from the CLI): not search, recall, the board,
 * the injection or any MCP tool. Lists and reports give row ids, times, roles and lengths, never the text (the
 * preview adds only each word's first letter).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boardReflects, resetBoardAfterPurge } from '../session-continuity/situation-board.ts';
import { dropQuestionsFrom } from '../session-continuity/open-questions.ts';
import { transaction } from '../store/schema.ts';
import { ingestTranscript } from './ingest-transcript.ts';
import type { LogRowInfo, Store } from '../store/store.ts';
import { QUEUED_PREFIX } from '../store/conversation-log.ts';
import { formatLocal, nowIso } from '../core/kst-time.ts';
import { indexText } from '../memory/search-terms.ts';
import { catchUpTranscripts, transcriptDirs } from './catch-up.ts';
import { CLI, TAG } from '../core/names.ts';

export const QUARANTINE_FILE = 'purged-log-error.db';
export const PURGE_REASON = '사용자가 지운 대화에서 저장됨';
/** A preview's state, keyed by its approval code. */
const CODE_PREFIX = 'purge_code:';
/** Every code handed out lately: a message holding just one of them is not conversation (turn counting). */
const CODES_KEY = 'purge_codes';
/** The "확인" previews of before (no longer used): dropped when met. */
const OLD_PENDING_PREFIX = 'purge_pending:'; // legacy-name: purge-pending-prefix
const NOTICE_KEY = 'purge_notice';
/** An approval code older than this deletes nothing. */
export const CODE_MAX_MS = 30 * 60 * 1000;
/** Codes are remembered this long for turn counting, and a preview's state this long for "already used/expired". */
const CODES_KEEP_MS = 30 * 24 * 3600 * 1000;
const STATE_KEEP_MS = 24 * 3600 * 1000;
const CODE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const CODE_RE = /^[0-9a-z]{6}$/;
export const MAX_TURNS = 20;
export const MAX_ROWS = 400;
/** Rows listed one by one in a preview; the rest are counted. */
export const LIST_ROWS = 30;
/** Memories count as saved in the deleted turns only inside their time span (guards against another session's saves). */
const WINDOW_BEFORE_MS = 60 * 1000;
const WINDOW_AFTER_MS = 5 * 60 * 1000;
/** Other sessions' transcripts written in the last minute may be mid-turn; older ones are caught up first. */
const CATCH_UP_IDLE_MS = 60 * 1000;
/** A compaction summary is logged as a user row; it is not a turn the user started. */
const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
const CMD_MAX_CHARS = 60;

export type PurgeSpec = { kind: 'turns'; n: number } | { kind: 'turn'; id: number } | { kind: 'range'; from: number; to: number };

export interface PurgeCommand {
  /** Missing when the phrase was meant as the command but its target could not be read. */
  spec?: PurgeSpec;
}

/** One logged row, without its text. */
export interface RowInfo extends LogRowInfo {
  /** A user prompt that starts a turn (not a compaction summary, not a picked answer, not a message sent mid-turn). */
  prompt: boolean;
}

export interface PurgePlan {
  spec: PurgeSpec;
  sessionId: string;
  rows: RowInfo[];
  /** Rows of other sessions inside an id range: left alone. */
  otherSession: number;
  /** Still-valid memories saved in these turns. */
  memoryIds: number[];
  boardReset: boolean;
  questions: string[];
  notes: string[];
}

export interface PurgeResult {
  quarantine: string;
  deleted: number[];
  forgotten: number[];
  boardReset: boolean;
  questions: string[];
}

// ---- the phrase ---------------------------------------------------------------

/** The phrase, with every space taken out (2026-11-06: was "대화 지워 …", made strict so it never fires by chance). */
export const PHRASE = '비서 대화 삭제';
const PHRASE_RE = /^비서대화삭제(?:(\d{1,3})턴|#(\d{1,9})|#(\d{1,9})-#(\d{1,9}))?$/;

/**
 * The prompt as a delete command (always a preview), or null for anything else. Only the whole message, with every
 * space taken out (around and inside), exactly "비서대화삭제" then "N턴", "#120" or "#120-#135": "비서 대화 삭제 2턴",
 * "비서대화삭제#120", "비서 대화 삭제 #135-#120". The phrase alone ("비서 대화 삭제") is still the command, so the
 * secretary can answer with how to write it. Anything around it, and the old "대화 지워 …", is ordinary talk.
 */
export function parsePurgeCommand(prompt: string): PurgeCommand | null {
  const m = PHRASE_RE.exec(prompt.normalize('NFC').replace(/\s+/g, ''));
  if (!m) return null;
  if (m[1]) return { spec: { kind: 'turns', n: Number(m[1]) } };
  if (m[2]) return { spec: { kind: 'turn', id: Number(m[2]) } };
  if (m[3]) {
    const [a, b] = [Number(m[3]), Number(m[4])];
    return { spec: { kind: 'range', from: Math.min(a, b), to: Math.max(a, b) } };
  }
  return {};
}

/** The target as a command-line argument: no '#', which PowerShell reads as a comment. */
export function specArg(spec: PurgeSpec): string {
  return spec.kind === 'turns' ? `${spec.n}턴` : spec.kind === 'turn' ? `${spec.id}` : `${spec.from}-${spec.to}`;
}

/** "2턴" / "마지막 2턴" · "#120" (the turn holding it) · "#120-#135" or "120~135" (those rows, '#' optional). */
export function parseSpec(text: string): PurgeSpec | undefined {
  const s = text.replace(/\s+/g, ' ').trim();
  let m = /^(?:마지막 ?)?(\d{1,3}) ?(?:턴|turns?|t)$/i.exec(s);
  if (m) return { kind: 'turns', n: Number(m[1]) };
  m = /^#?(\d{1,9})$/.exec(s);
  if (m) return { kind: 'turn', id: Number(m[1]) };
  m = /^#?(\d{1,9}) ?[-~] ?#?(\d{1,9})$/.exec(s);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return { kind: 'range', from: Math.min(a, b), to: Math.max(a, b) };
  }
  return undefined;
}

export function specText(spec: PurgeSpec): string {
  return spec.kind === 'turns' ? `${spec.n}턴` : spec.kind === 'turn' ? `#${spec.id}` : `#${spec.from}-#${spec.to}`;
}

export const USAGE = [
  '쓰는 법(띄어쓰기는 상관없고, 앞뒤에 다른 글자 없이 이 문구만 보내요):',
  `- ${PHRASE} 2턴 → 마지막 2턴(이 세션에 지울 대화가 없으면 바로 앞 세션)`,
  `- ${PHRASE} #120 → #120이 든 턴 하나`,
  `- ${PHRASE} #120-#135 → #120의 세션에서 그 범위의 줄`,
  '먼저 지울 줄마다 단어 첫 글자(40개까지)와 승인 코드(영숫자 6글자)를 보여 줘요. 30분 안에 그 코드만 보내면 지워요.',
].join('\n');

// ---- choosing rows --------------------------------------------------------------

const INFO_SQL = `SELECT id, session_id, message_uuid, role, length(content) AS chars, created_at,
  (role = 'user' AND substr(content, 1, ${SUMMARY_PREFIX.length}) != '${SUMMARY_PREFIX}' AND substr(content, 1, 7) != '[선택 응답]'
    AND substr(content, 1, ${QUEUED_PREFIX.length}) != '${QUEUED_PREFIX}') AS prompt,
  CASE WHEN role = 'user' AND length(content) <= ${CMD_MAX_CHARS} THEN content END AS short
  FROM raw_log`;

type InfoRow = Omit<RowInfo, 'prompt'> & { prompt: number; short: string | null };

/** Approval codes handed out lately. */
function issuedCodes(store: Store): Set<string> {
  return new Set((store.getJson<Array<{ code: string; at: string }>>(CODES_KEY) ?? []).map((c) => c.code));
}

/** A prompt that is a delete command or an approval code: it, and its answer, are not conversation. */
function isCommandText(text: string, codes: Set<string>): boolean {
  return parsePurgeCommand(text) !== null || codes.has(text.trim());
}

/**
 * One session's rows in order, minus the "command turns": a delete phrase or an approval code and the rows that
 * follow it up to the next prompt (the preview answer). `skipped` counts what was left out.
 */
function sessionInfo(store: Store, sessionId: string): { rows: RowInfo[]; skipped: RowInfo[] } {
  const raw = store.db.prepare(`${INFO_SQL} WHERE session_id = ? ORDER BY id`).all(sessionId) as unknown as InfoRow[];
  const codes = issuedCodes(store);
  const rows: RowInfo[] = [];
  const skipped: RowInfo[] = [];
  let inCommand = false;
  for (const { short, ...r } of raw) {
    const info = { ...r, prompt: r.prompt === 1 };
    if (info.prompt) inCommand = short !== null && isCommandText(short, codes);
    (inCommand ? skipped : rows).push(info);
  }
  return { rows, skipped };
}

function sessionRows(store: Store, sessionId: string): RowInfo[] {
  return sessionInfo(store, sessionId).rows;
}

function sessionByPrefix(store: Store, prefix: string): string | undefined {
  return (store.db.prepare('SELECT session_id FROM raw_log WHERE session_id LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}%`) as { session_id: string } | undefined)
    ?.session_id;
}

export interface PlanOptions {
  /** The session the command came from (the hook) — "N턴" means its turns, if it has any. */
  sessionId?: string;
  /** A session id or its first characters (the CLI's --session). */
  sessionPrefix?: string;
  transcriptPath?: string;
  /** Where to look for a session's transcript (remember results); default: this project's transcript folders. */
  dirs?: string[];
}

/** What a command would delete, or why it cannot. Reads only ids, times, roles and lengths. */
export function planPurge(store: Store, spec: PurgeSpec, opts: PlanOptions = {}): PurgePlan | { error: string } {
  const notes: string[] = [];
  let sessionId: string | undefined;
  let rows: RowInfo[] = [];
  let otherSession = 0;
  if (spec.kind === 'turns') {
    if (spec.n < 1 || spec.n > MAX_TURNS) return { error: `턴 수는 1~${MAX_TURNS}만 돼요.` };
    if (opts.sessionPrefix) {
      sessionId = sessionByPrefix(store, opts.sessionPrefix);
      if (!sessionId) return { error: `세션 ${opts.sessionPrefix}의 대화 기록이 없어요.` };
    } else if (opts.sessionId && sessionRows(store, opts.sessionId).some((r) => r.prompt)) {
      sessionId = opts.sessionId;
    } else {
      sessionId = store.lastOtherSession(opts.sessionId)?.session_id;
      if (!sessionId) return { error: '지울 대화 기록이 없어요.' };
      if (opts.sessionId) notes.push('이 세션에는 지울 대화가 없어서 바로 앞 세션의 턴이에요.');
    }
    const all = sessionRows(store, sessionId);
    const starts = all.filter((r) => r.prompt);
    if (!starts.length) return { error: `세션 ${sessionId.slice(0, 8)}에 사용자 질문이 없어요.` };
    if (starts.length < spec.n) notes.push(`이 세션의 턴이 ${starts.length}개뿐이라 전부예요.`);
    const first = starts[Math.max(0, starts.length - spec.n)];
    rows = all.filter((r) => r.id >= first.id);
  } else if (spec.kind === 'turn') {
    const at = store.db.prepare('SELECT session_id FROM raw_log WHERE id = ?').get(spec.id) as { session_id: string } | undefined;
    if (!at) return { error: `대화 #${spec.id}이 없어요(이미 지웠거나 없는 번호).` };
    sessionId = at.session_id;
    const all = sessionRows(store, sessionId);
    if (!all.some((r) => r.id === spec.id)) return { error: `#${spec.id}은 대화 지우기 명령이나 그 미리 보기 줄이라 지울 대화가 아니에요.` };
    const start = all.filter((r) => r.prompt && r.id <= spec.id).at(-1)?.id ?? all[0].id;
    const end = all.find((r) => r.prompt && r.id > start)?.id ?? Infinity;
    rows = all.filter((r) => r.id >= start && r.id < end);
  } else {
    const at = store.db.prepare('SELECT session_id FROM raw_log WHERE id BETWEEN ? AND ? ORDER BY id LIMIT 1').get(spec.from, spec.to) as
      | { session_id: string }
      | undefined;
    if (!at) return { error: `#${spec.from}~#${spec.to}에 대화가 없어요.` };
    sessionId = at.session_id;
    const info = sessionInfo(store, sessionId);
    const inRange = (r: RowInfo) => r.id >= spec.from && r.id <= spec.to;
    rows = info.rows.filter(inRange);
    const commands = info.skipped.filter(inRange).length;
    if (commands) notes.push(`(그 범위에 낀 대화 지우기 명령·미리 보기 줄 ${commands}개는 빼요)`);
    otherSession = Number(
      (store.db.prepare('SELECT count(*) AS n FROM raw_log WHERE id BETWEEN ? AND ? AND session_id != ?').get(spec.from, spec.to, sessionId) as { n: number }).n,
    );
  }
  if (!rows.length) return { error: '지울 줄이 없어요.' };
  if (rows.length > MAX_ROWS) return { error: `한 번에 ${MAX_ROWS}줄까지만 지워요(지금 ${rows.length}줄). 범위를 나눠 주세요.` };

  const ids = rows.map((r) => r.id);
  return {
    spec,
    sessionId,
    rows,
    otherSession,
    memoryIds: turnMemories(store, sessionId, rows, opts),
    boardReset: boardReflects(store, ids[0]),
    questions: dropQuestionsFrom(store, ids, true),
    notes,
  };
}

/**
 * Still-valid memories saved in these turns: those linked to a deleted row (the Stop hook links a turn's saves
 * to its prompt) and those whose number a remember call in that stretch of the transcript returned (a turn that
 * ended in an error never reached its Stop hook). Both only inside the turns' time span.
 */
function turnMemories(store: Store, sessionId: string, rows: RowInfo[], opts: PlanOptions): number[] {
  const from = Date.parse(rows[0].created_at) - WINDOW_BEFORE_MS;
  const to = Date.parse(rows.at(-1)!.created_at) + WINDOW_AFTER_MS;
  const ids = JSON.stringify(rows.map((r) => r.id));
  const linked = store.db
    .prepare('SELECT id, created_at FROM memories WHERE valid_to IS NULL AND source_log_id IN (SELECT value FROM json_each(?))')
    .all(ids) as Array<{ id: number; created_at: string }>;
  const next = store.db.prepare('SELECT message_uuid FROM raw_log WHERE session_id = ? AND id > ? ORDER BY id LIMIT 1').get(sessionId, rows.at(-1)!.id) as
    | { message_uuid: string }
    | undefined;
  const said = rememberedIn(transcriptOf(sessionId, opts), rows[0].message_uuid, next?.message_uuid);
  const byId = store.db.prepare('SELECT id, created_at FROM memories WHERE id = ? AND valid_to IS NULL');
  const found = [...linked, ...said.flatMap((i) => byId.all(i) as Array<{ id: number; created_at: string }>)];
  const inSpan = found.filter((m) => {
    const t = Date.parse(m.created_at);
    return t >= from && t <= to;
  });
  return [...new Set(inSpan.map((m) => m.id))].sort((a, b) => a - b);
}

function transcriptOf(sessionId: string, opts: PlanOptions): string | undefined {
  if (opts.transcriptPath && path.basename(opts.transcriptPath) === `${sessionId}.jsonl` && fs.existsSync(opts.transcriptPath)) return opts.transcriptPath;
  for (const dir of opts.dirs ?? transcriptDirs()) {
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
}

/** Memory numbers the remember calls between two transcript messages returned ("기억 #1234 저장"). */
function rememberedIn(file: string | undefined, fromUuid: string, untilUuid?: string): number[] {
  if (!file) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const start = fromUuid.replace(/:recap$/, '');
  const stop = untilUuid?.replace(/:recap$/, '');
  const calls = new Set<string>();
  const ids = new Set<number>();
  let on = false;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let o: { uuid?: string; type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (o.uuid === start) on = true;
    if (stop && o.uuid === stop) break;
    if (!on || o.isSidechain || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content as Block[]) {
      if (o.type === 'assistant' && b?.type === 'tool_use' && b.id && b.name?.endsWith('__remember')) calls.add(b.id);
      if (o.type === 'user' && b?.type === 'tool_result' && b.tool_use_id && calls.has(b.tool_use_id) && !b.is_error) {
        const out = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c?.text ?? '').join('\n') : '';
        const m = /^기억 #(\d+) 저장/.exec(out.trim());
        if (m) ids.add(Number(m[1]));
      }
    }
  }
  return [...ids];
}

// ---- deleting -------------------------------------------------------------------

/** The quarantine file beside the DB: backups/error/, out of the daily backups (backup-db.ps1 reads backups/ itself only). */
export function quarantinePath(store: Store): string {
  return path.join(path.dirname(store.db.location() ?? '.'), 'backups', 'error', QUARANTINE_FILE);
}

const QUARANTINE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS purged.quarantined_log (
    seq          INTEGER PRIMARY KEY,
    log_id       INTEGER NOT NULL,
    session_id   TEXT NOT NULL,
    message_uuid TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    purged_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS purged.quarantined_log_uuid ON quarantined_log (message_uuid, seq);
  CREATE TRIGGER IF NOT EXISTS purged.quarantined_log_no_update BEFORE UPDATE ON quarantined_log
    BEGIN SELECT RAISE(ABORT, 'quarantined_log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS purged.quarantined_log_no_delete BEFORE DELETE ON quarantined_log
    BEGIN SELECT RAISE(ABORT, 'quarantined_log is append-only'); END;
`;

/** Runs `fn` with the quarantine attached as `purged` (made if missing unless `mustExist`). */
function withQuarantine<T>(store: Store, fn: () => T, mustExist = false): T {
  const file = quarantinePath(store);
  if (mustExist && !fs.existsSync(file)) throw new Error(`격리 DB가 없어요(지웠다면 되돌릴 수 없어요): ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store.db.prepare('ATTACH DATABASE ? AS purged').run(file);
  try {
    store.db.exec(QUARANTINE_SCHEMA);
    return fn();
  } finally {
    store.db.exec('DETACH DATABASE purged');
  }
}

/**
 * The one way rows leave raw_log, for "비서 대화 삭제" (executePurge) and for a branch a rewind abandoned
 * (log/rewind.ts cleanRewound); the two differ only in how they choose rows and memories. The rows are copied into
 * the quarantine first and committed there on their own, so a failure in between leaves them in both places
 * rather than in neither; then one transaction in the main DB removes them, blocks their identifiers and
 * invalidates the memories; then the file traces go, and the board and open questions that came from them.
 * With no rows, only the memories are invalidated.
 */
export function deleteLogRows(store: Store, logIds: number[], memoryIds: number[], reason: string): PurgeResult {
  const ids = [...new Set(logIds)].sort((a, b) => a - b);
  const at = nowIso();
  if (!ids.length) {
    const { forgotten } = store.dropLogRows([], memoryIds, reason, at);
    return { quarantine: '', deleted: [], forgotten, boardReset: false, questions: [] };
  }
  const json = JSON.stringify(ids);
  const present = Number((store.db.prepare('SELECT count(*) AS n FROM raw_log WHERE id IN (SELECT value FROM json_each(?))').get(json) as { n: number }).n);
  if (present !== ids.length) throw new Error(`지울 줄 ${ids.length}개 중 ${present}개만 남아 있어요. 목록을 다시 보세요.`);
  withQuarantine(store, () => {
    const copied = transaction(store.db, () =>
      Number(
        store.db
          .prepare(
            `INSERT INTO purged.quarantined_log (log_id, session_id, message_uuid, role, content, created_at, purged_at)
             SELECT id, session_id, message_uuid, role, content, created_at, ? FROM main.raw_log WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          )
          .run(at, json).changes,
      ),
    );
    if (copied !== ids.length) throw new Error(`격리 DB에 ${ids.length}줄 중 ${copied}줄만 옮겨져 지우지 않았어요.`);
  });
  // The text must not stay in the main DB file: freed pages are zeroed, the search index's old segments merged
  // away, and the WAL written back (best effort: an open reader can keep it from being emptied).
  const secure = (store.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete;
  store.db.exec('PRAGMA secure_delete = ON');
  // The board and open questions are rewritten inside the same window: their old text came from these rows.
  let forgotten: number[];
  let boardReset: boolean;
  let questions: string[];
  try {
    ({ forgotten } = store.dropLogRows(ids, memoryIds, reason, at));
    store.db.exec("INSERT INTO raw_log_fts (raw_log_fts) VALUES ('optimize')");
    boardReset = resetBoardAfterPurge(store, ids[0]);
    questions = dropQuestionsFrom(store, ids);
  } finally {
    store.db.exec(`PRAGMA secure_delete = ${secure ? 'ON' : 'OFF'}`);
  }
  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Busy: the next automatic checkpoint writes it back.
  }
  return { quarantine: quarantinePath(store), deleted: ids, forgotten, boardReset, questions };
}

/**
 * Deletes what a plan listed (deleteLogRows). With `notify` (the CLI run directly) the secretary is told on its next
 * prompt; the approval code's turn tells it right away instead (purgeDone), so it passes `false`.
 */
export function executePurge(store: Store, plan: PurgePlan, notify = true): PurgeResult {
  const result = deleteLogRows(store, plan.rows.map((r) => r.id), plan.memoryIds, PURGE_REASON);
  if (notify) {
    const ids = result.deleted;
    const pending = store.getJson<NoticeEntry[]>(NOTICE_KEY) ?? [];
    store.setJson(NOTICE_KEY, [...pending, { from: ids[0], to: ids.at(-1)!, rows: ids.length, forgotten: result.forgotten }]);
  }
  return result;
}

export interface RestoreRow {
  logId: number;
  /** The id it has again; another when its old id was taken by a newer row meanwhile. */
  newId?: number;
  role: string;
  chars: number;
  created_at: string;
  state: 'restore' | 'restored' | 'in-log';
}

/**
 * Puts quarantined rows (log ids from..to, the latest copy of each) back into the log and off the block list.
 * The text moves inside SQLite; only the search index needs it in memory here, and it is never printed.
 * Memories invalidated by the deletion stay invalidated, and the board is not rewritten for them.
 */
export function restorePurged(store: Store, from: number, to: number, dryRun = true): RestoreRow[] {
  return withQuarantine(
    store,
    () => {
      const rows = store.db
        .prepare(
          `SELECT q.seq, q.log_id, q.message_uuid, q.role, length(q.content) AS chars, q.created_at FROM purged.quarantined_log q
           WHERE q.log_id BETWEEN ? AND ? AND q.seq = (SELECT max(seq) FROM purged.quarantined_log WHERE message_uuid = q.message_uuid)
           ORDER BY q.log_id`,
        )
        .all(from, to) as Array<{ seq: number; log_id: number; message_uuid: string; role: string; chars: number; created_at: string }>;
      const inLog = store.db.prepare('SELECT 1 FROM main.raw_log WHERE message_uuid = ?');
      const out: RestoreRow[] = rows.map((r) => ({ logId: r.log_id, role: r.role, chars: r.chars, created_at: r.created_at, state: inLog.get(r.message_uuid) ? 'in-log' : 'restore' }));
      if (dryRun) return out;
      transaction(store.db, () => {
        const taken = store.db.prepare('SELECT 1 FROM main.raw_log WHERE id = ?');
        const insert = store.db.prepare(
          'INSERT INTO main.raw_log (id, session_id, message_uuid, role, content, created_at) SELECT ?, session_id, message_uuid, role, content, created_at FROM purged.quarantined_log WHERE seq = ?',
        );
        const text = store.db.prepare('SELECT content FROM main.raw_log WHERE id = ?');
        const index = store.db.prepare('INSERT INTO main.raw_log_fts (rowid, terms) VALUES (?, ?)');
        const unblock = store.db.prepare('DELETE FROM main.purged_log_ids WHERE message_uuid = ?');
        rows.forEach((r, i) => {
          if (out[i].state !== 'restore') return;
          const id = Number(insert.run(taken.get(r.log_id) ? null : r.log_id, r.seq).lastInsertRowid);
          index.run(id, indexText((text.get(id) as { content: string }).content));
          unblock.run(r.message_uuid);
          out[i] = { ...out[i], newId: id, state: 'restored' };
        });
      });
      return out;
    },
    true,
  );
}

// ---- what the user and the secretary see -----------------------------------------

const who = (role: string) => (role === 'user' ? '사용자' : '비서');
const when = (iso: string) => formatLocal(iso).slice(5);

/** One row in a list (purge preview, rewind-clean): id, time, who, length. Never the text. */
export function rowLine(r: LogRowInfo): string {
  return `- #${r.id} ${when(r.created_at)} ${who(r.role)} ${r.chars.toLocaleString('en-US')}자`;
}

function describe(plan: PurgePlan): string {
  const s = plan.spec;
  return s.kind === 'turns' ? `마지막 ${s.n}턴` : s.kind === 'turn' ? `#${s.id}이 든 턴` : `#${s.from}~#${s.to}`;
}

/** The plan as lines for the user: ids, times, roles and lengths only. */
export function formatPlan(plan: PurgePlan): string {
  const rows = plan.rows;
  const lines = [`대상: 세션 ${plan.sessionId.slice(0, 8)} · ${describe(plan)} · 줄 ${rows.length}개 (#${rows[0].id}~#${rows.at(-1)!.id})`, ...plan.notes];
  if (plan.otherSession) lines.push(`(그 범위에 낀 다른 세션 줄 ${plan.otherSession}개는 안 지워요)`);
  for (const r of rows.slice(0, LIST_ROWS)) lines.push(rowLine(r));
  if (rows.length > LIST_ROWS) lines.push(`- … 외 ${rows.length - LIST_ROWS}줄`);
  lines.push(`무효 처리할 기억(그 턴에 저장된 것): ${plan.memoryIds.map((i) => `#${i}`).join(', ') || '없음'}`);
  lines.push(`상황판: ${plan.boardReset ? '이 대화를 이미 읽었으니 비우고 다시 써요' : '그대로'}`);
  lines.push(`남은 질문에서 뺄 것: ${plan.questions.join(', ') || '없음'}`);
  return lines.join('\n');
}

export function formatResult(r: PurgeResult): string {
  return [
    `지운 줄 ${r.deleted.length}개 (#${r.deleted[0]}~#${r.deleted.at(-1)}), 무효 처리한 기억: ${r.forgotten.map((i) => `#${i}`).join(', ') || '없음'}`,
    `상황판: ${r.boardReset ? '비웠어요(쉬는 시간이나 새 세션 첫 질문 때 다시 써요)' : '그대로'} · 남은 질문에서 뺀 것: ${r.questions.join(', ') || '없음'}`,
    `지운 줄 보관(격리 DB, 비서는 읽지 않고 언제 지워도 돼요): ${r.quarantine}`,
  ].join('\n');
}

/** One preview line for a row: id, who, length, then what follows it (its word count and first letters). Never the text. */
export function previewRowLine(r: LogRowInfo, tail = ''): string {
  return `#${r.id} ${who(r.role)} ${r.chars.toLocaleString('en-US')}자${tail}`;
}

export interface PreviewLines {
  /** What follows each listed row's length (the first LIST_ROWS), in order: " · 6단어 — 대 삭 …" (log/purge-initials.ts). */
  rows?: string[];
  /** What follows each "기억 #id" (one per plan.memoryIds): " 30자 · 5단어 — …". */
  memories?: string[];
}

/** The preview the secretary passes on: rows and memories (with first letters), what else changes, the code. */
export function formatPreview(plan: PurgePlan, code: string, s: PreviewLines = {}): string {
  const rows = plan.rows;
  const lines = ['[대화 지우기 미리 보기] 아직 안 지웠어요.', `대상: 세션 ${plan.sessionId.slice(0, 8)} · ${describe(plan)} · 줄 ${rows.length}개 (#${rows[0].id}~#${rows.at(-1)!.id})`, ...plan.notes];
  if (plan.otherSession) lines.push(`(그 범위에 낀 다른 세션 줄 ${plan.otherSession}개는 안 지워요)`);
  rows.slice(0, LIST_ROWS).forEach((r, i) => lines.push(previewRowLine(r, s.rows?.[i])));
  if (rows.length > LIST_ROWS) lines.push(`… 외 ${rows.length - LIST_ROWS}줄(목록 생략)`);
  if (!plan.memoryIds.length) lines.push('무효 처리할 기억(그 턴에 저장된 것): 없음');
  else {
    lines.push(`무효 처리할 기억(그 턴에 저장된 것) ${plan.memoryIds.length}개:`);
    plan.memoryIds.forEach((id, i) => lines.push(`기억 #${id}${s.memories?.[i] ?? ''}`));
  }
  lines.push(`상황판: ${plan.boardReset ? '이 대화를 이미 읽었으니 비우고 다시 써요' : '그대로'}`);
  lines.push(`남은 질문에서 뺄 것: ${plan.questions.join(', ') || '없음'}`);
  lines.push(`승인 코드: ${code}`);
  lines.push(`지우려면 ${CODE_MAX_MS / 60000}분 안에 이 코드만 보내세요(앞뒤에 다른 글자 없이). 안 지우려면 그냥 두면 돼요.`);
  return lines.join('\n');
}

// ---- approval codes --------------------------------------------------------------------

/** Where a preview's rows were chosen from, so the code's check chooses them the same way. */
export interface PreviewOrigin {
  /** The session the phrase came from: "N턴" counts its turns, or the session before when it has none. */
  here?: string;
  /** A session id or its first characters (the CLI's --session). */
  sessionPrefix?: string;
}

interface CodeState extends PreviewOrigin {
  code: string;
  /** sha256 of the rows, the memories and the nonce: the code is its first 6 bytes in [0-9a-z]. */
  hash: string;
  nonce: string;
  spec: PurgeSpec;
  rows: number[];
  memories: number[];
  at: string;
  /** When the code deleted. */
  used?: string;
}

function bindHash(rows: number[], memories: number[], nonce: string): string {
  return createHash('sha256').update(JSON.stringify({ rows, memories, nonce })).digest('hex');
}

function codeOf(hash: string): string {
  return Array.from(Buffer.from(hash, 'hex').subarray(0, 6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/**
 * Stores what a preview listed and returns its approval code: 6 characters of [0-9a-z] from a hash of exactly
 * those row and memory ids (plus a nonce, so each preview gets its own). Old states and codes are pruned.
 */
export function issuePurgeCode(store: Store, plan: PurgePlan, origin: PreviewOrigin = {}, now = Date.now()): string {
  for (const { key } of store.metaWithPrefix(OLD_PENDING_PREFIX)) store.deleteMeta(key);
  for (const { key, value } of store.metaWithPrefix(CODE_PREFIX)) {
    let at = 0;
    try {
      at = Date.parse((JSON.parse(value) as CodeState).at);
    } catch {
      // unreadable: dropped
    }
    if (!(now - at <= STATE_KEEP_MS)) store.deleteMeta(key);
  }
  const rows = plan.rows.map((r) => r.id);
  const memories = [...plan.memoryIds];
  let state: CodeState | undefined;
  for (let i = 0; i < 20 && !state; i++) {
    const nonce = randomBytes(8).toString('hex');
    const hash = bindHash(rows, memories, nonce);
    const code = codeOf(hash);
    if (!store.getJson(CODE_PREFIX + code)) state = { code, hash, nonce, spec: plan.spec, ...origin, rows, memories, at: new Date(now).toISOString() };
  }
  if (!state) throw new Error('승인 코드를 만들지 못했어요.');
  store.setJson(CODE_PREFIX + state.code, state);
  const codes = (store.getJson<Array<{ code: string; at: string }>>(CODES_KEY) ?? []).filter((c) => now - Date.parse(c.at) <= CODES_KEEP_MS);
  store.setJson(CODES_KEY, [...codes, { code: state.code, at: state.at }].slice(-500));
  return state.code;
}

// ---- the prompt hook --------------------------------------------------------------------

export interface HookDeps {
  catchUp?: (store: Store, currentPath?: string) => void;
  dirs?: string[];
  now?: () => number;
}

/**
 * What the prompt hook does instead of its usual notices: `context` goes to the secretary alone, with no
 * memories, board or other notices. Nothing is blocked (a block reason does not show on the phone): an approval
 * code deletes in the hook, without the model, and the secretary is then only told to pass the result on.
 */
export type HookAction = { context: string };

/** A turn that ended in an error never reached its Stop hook: log it first, so it can be listed (and blocked). */
function catchUp(store: Store, transcriptPath: string | undefined, deps: HookDeps): void {
  if (transcriptPath && fs.existsSync(transcriptPath)) ingestTranscript(store, transcriptPath);
  (deps.catchUp ?? ((s, p) => catchUpTranscripts(s, p, CATCH_UP_IDLE_MS)))(store, transcriptPath);
}

/** The order the secretary gets with a delete phrase: run the preview once and pass on what it prints. */
export function previewOrder(spec: PurgeSpec, sessionId?: string): string {
  const cmd = `node src/cli.ts ${CLI.purgeLog} preview ${specArg(spec)}${sessionId ? ` --here ${sessionId}` : ''}`;
  return [
    `<${TAG.purgePreview}>`,
    '사용자가 "비서 대화 삭제" 미리 보기를 청했다(이 질문에는 기억·상황판·알림을 붙이지 않았다). 아래 명령을 비서 폴더에서 한 번만 돌리고(모델을 부르지 않아 몇 초면 끝난다), 출력을 원문 그대로 전한다. 지울 대화의 내용을 짐작하거나 기억·대화 기록 도구로 찾아보지 않고, 다른 일은 하지 않는다(결과는 훅이 이미 다 붙여 주었고, 지울 대화를 도구로 다시 찾아 읽으면 오류를 부르던 내용을 다시 불러올 수 있기 때문이다).',
    cmd,
    `</${TAG.purgePreview}>`,
  ].join('\n');
}

/**
 * Prompt hook, before anything else. A delete phrase: the order to run the preview (or, with an unreadable
 * target, to pass on how to write it). An approval code (the whole message, spaces around it aside): deletes
 * what its preview listed if that is still exactly what the preview would list, else tells the secretary why
 * nothing was deleted. null for anything else, the usual notices then follow.
 */
export function purgeHook(store: Store, prompt: string, sessionId?: string, transcriptPath?: string, deps: HookDeps = {}): HookAction | null {
  const typed = prompt.trim();
  if (CODE_RE.test(typed)) {
    const state = store.getJson<CodeState>(CODE_PREFIX + typed);
    if (state) return approve(store, state, sessionId, transcriptPath, deps);
  }
  const cmd = parsePurgeCommand(prompt);
  if (!cmd) return null;
  if (!cmd.spec) {
    return { context: `<${TAG.purgePreview}>사용자가 "비서 대화 삭제" 명령을 지울 대상 없이 보냈다. 도구를 쓰지 말고 아래 쓰는 법을 그대로 전한다(쓰는 법은 훅이 이미 다 붙여 주었고, 지울 대화를 도구로 다시 찾아 읽으면 오류를 부르던 내용을 다시 불러올 수 있기 때문이다).\n${USAGE}\n</${TAG.purgePreview}>` };
  }
  try {
    catchUp(store, transcriptPath, deps);
  } catch {
    // The preview lists what is logged; a failed catch-up only means a missing turn may not be listed.
  }
  return { context: previewOrder(cmd.spec, sessionId) };
}

function approve(store: Store, state: CodeState, sessionId: string | undefined, transcriptPath: string | undefined, deps: HookDeps): HookAction {
  const again = `다시 지우려면 '${PHRASE} ${specText(state.spec)}'부터 보내세요`;
  const tell = (why: string) => ({
    context: `<${TAG.purgeCode}>사용자가 보낸 "${state.code}"는 대화 지우기 승인 코드인데, ${why} 이 질문에는 기억·상황판을 붙이지 않았다. 도구를 쓰지 말고(알릴 것은 이 안내에 다 있고, 지울 대화를 도구로 다시 찾아 읽으면 오류를 부르던 내용을 다시 불러올 수 있기 때문이다) 그 사실과 "${again}." 한 줄만 전한다.</${TAG.purgeCode}>`,
  });
  const now = (deps.now ?? Date.now)();
  if (state.used) return tell(`${formatLocal(state.used)}에 이미 그 코드로 지웠다. 이번에는 아무것도 안 지웠다.`);
  if (now - Date.parse(state.at) > CODE_MAX_MS) return tell(`만든 지 ${CODE_MAX_MS / 60000}분이 지나 아무것도 안 지웠다.`);
  try {
    catchUp(store, transcriptPath, deps);
    const plan = planPurge(store, state.spec, { sessionId: state.here, sessionPrefix: state.sessionPrefix, transcriptPath, dirs: deps.dirs });
    if ('error' in plan || bindHash(plan.rows.map((r) => r.id), plan.memoryIds, state.nonce) !== state.hash) {
      return tell('미리 본 뒤 지울 대화나 기억이 바뀌어 아무것도 안 지웠다.');
    }
    const result = executePurge(store, plan, false);
    store.setJson(CODE_PREFIX + state.code, { ...state, used: nowIso() } satisfies CodeState);
    return { context: purgeDone(plan, result, plan.sessionId === sessionId) };
  } catch (err) {
    return tell(`지우다 실패해 아무것도 안 지웠거나 일부만 지웠을 수 있다(오류: ${(err as Error).message}).`);
  }
}

/**
 * The approval code's turn: deleted already (in the hook), the secretary only passes the result on. Ids, times,
 * roles and lengths, memory numbers, the board and open questions: never a row's text. This is the only word
 * of that deletion the secretary gets (no next-prompt notice).
 */
export function purgeDone(plan: PurgePlan, r: PurgeResult, sameSession: boolean): string {
  const rows = plan.rows;
  const lines = [`[대화 지우기] 지웠어요. 세션 ${plan.sessionId.slice(0, 8)} · ${describe(plan)}`];
  for (const row of rows.slice(0, LIST_ROWS)) lines.push(rowLine(row));
  if (rows.length > LIST_ROWS) lines.push(`- … 외 ${rows.length - LIST_ROWS}줄`);
  lines.push(formatResult(r));
  if (sameSession) lines.push('이 세션 맥락에 그 대화가 아직 남아 있으면 /clear 하거나 그 앞으로 되감기하세요(DB 정리는 다음 세션이 다시 읽지 않게 하는 것).');
  return [
    `<${TAG.purgeDone}>`,
    '사용자가 보낸 메시지는 대화 지우기 승인 코드였고, 질문 훅이 이미 지웠다(이 질문에는 기억·상황판·알림을 붙이지 않았다). 도구를 쓰지 말고 아래 결과를 원문 그대로 전한다. 지운 대화의 내용을 짐작하거나 되묻지 않고, 다른 일은 하지 않는다(결과는 훅이 이미 다 붙여 주었고, 지운 대화를 도구로 다시 찾아 읽으면 오류를 부르던 내용을 다시 불러올 수 있기 때문이다).',
    ...lines,
    `</${TAG.purgeDone}>`,
  ].join('\n');
}

interface NoticeEntry {
  from: number;
  to: number;
  rows: number;
  forgotten: number[];
}

/** Next prompt: the secretary is told once what was deleted (numbers only), since the deleting turn never reached it. */
export function purgeNotice(store: Store): string {
  const pending = store.getJson<NoticeEntry[]>(NOTICE_KEY);
  if (!pending?.length) return '';
  store.setJson(NOTICE_KEY, []);
  const what = pending.map((p) => `#${p.from}~#${p.to}(${p.rows}줄)`).join(', ');
  const ids = [...new Set(pending.flatMap((p) => p.forgotten))].map((i) => `#${i}`).join(', ');
  const mem = ids ? `, 그 턴의 기억 ${ids}를 무효 처리` : '';
  return `<${TAG.purge}>사용자가 "비서 대화 삭제" 명령으로 대화 기록 ${what}를 지웠다${mem}. 지운 대화는 따로 보관됐고 비서는 읽지 않는다. 그 내용을 짐작하거나 되묻지 않는다(지운 대화를 다시 찾아 읽으면 오류를 부르던 내용을 다시 불러올 수 있기 때문이다). 답 끝("다음 행동" 위)에 "대화 ${what}를 지웠어요${ids ? `(기억 ${ids} 무효 처리)` : ''}." 한 줄을 붙인다.</${TAG.purge}>`;
}
