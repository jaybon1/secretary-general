/**
 * Archives Claude Code transcripts (JSONL) into raw_log. Runs from the Stop hook,
 * so the conversation is recorded without the model spending any tokens on it. Branches abandoned
 * by a rewind are removed right after each read (log/rewind.ts).
 */
import fs from 'node:fs';
import { cleanRewound } from './rewind.ts';
import type { LogEntry, Store } from '../store/store.ts';
import { redactSecrets } from '../core/secret-mask.ts';
import { HOOK_FEEDBACK } from '../mistake-guards/last-turn.ts';
import { promptSource, relayedLogText } from '../hooks/prompt-sender.ts';
import { QUEUED_PREFIX } from '../store/conversation-log.ts';

type Entry = Omit<LogEntry, 'id'>;

/**
 * prompt: what the user typed · queued: what the user typed while the turn was running (it does not start a turn) ·
 * answer: the user's picks in an AskUserQuestion · text: assistant prose · recap: the assistant's end-of-turn summary (wrap_up).
 */
type Kind = 'prompt' | 'queued' | 'answer' | 'text' | 'recap';
type Parsed = Entry & { kind: Kind };

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: { recap?: unknown; ask?: unknown };
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
  toolUseResult?: { questions?: unknown; answers?: Record<string, unknown>; annotations?: Record<string, { notes?: string }> };
  attachment?: QueuedCommand;
  /** Who sent a user line: a message from another session is a meta line with kind 'peer'. */
  origin?: { kind?: string };
}

/**
 * A message that came in while a turn was running. Claude Code writes it only as an `attachment` line of type
 * `queued_command` (never as a `user` line), besides `queue-operation` lines (enqueue, then remove) that carry the same
 * text: the attachment is the one read, so it is stored once. `origin.kind` says who sent it: 'human' (typed by the person),
 * 'peer' (another session or a subagent's report, `<agent-message …>`), 'task-notification' (a background task's end).
 */
interface QueuedCommand {
  type?: string;
  prompt?: unknown;
  commandMode?: string;
  origin?: { kind?: string };
  /** When it was sent (enqueued); the line's own timestamp can be later. */
  timestamp?: string;
}

/** Harness-generated user turns (slash-command plumbing, reminders), not things the user said. */
const SYNTHETIC_PREFIXES = ['[Request interrupted', '<command-', '<local-command-', '<system-reminder>', '<bash-', '<task-notification>'];

/**
 * One transcript line → zero or more archive entries. A line normally holds a
 * single content block, but older formats can mix text and tool calls, so a
 * recap gets its own derived uuid.
 */
export function parseTranscriptLine(line: string): Parsed[] {
  let o: TranscriptLine;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (o.type === 'attachment') return parseQueued(o);
  if (o.type === 'user' && o.isMeta) return parseRelayed(o);
  if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain) return [];
  if (!o.uuid || !o.sessionId) return [];
  const base = { session_id: o.sessionId, role: o.type as LogEntry['role'], created_at: o.timestamp ?? new Date().toISOString() };
  const content = o.message?.content;

  if (o.type === 'user') {
    const answer = formatAnswers(o.toolUseResult);
    if (answer) return [{ ...base, message_uuid: o.uuid, content: answer, kind: 'answer' }];
    // Other user arrays are tool results: not something the user said.
    if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return [];
    const text = blockText(content).trim();
    // A Stop hook's reason for going on is not something the user said, and does not start a turn: the answer written
    // after it replaces the one sent back (or, mistake-guards/stop-guard.ts 'fill', is logged with it: AnswerOverride below).
    if (notSaid(text)) return [];
    return [{ ...base, message_uuid: o.uuid, content: text, kind: 'prompt' }];
  }

  const out: Parsed[] = [];
  const text = blockText(content).trim();
  if (text) out.push({ ...base, message_uuid: o.uuid, content: text, kind: 'text' });
  const recap = Array.isArray(content) ? content.map(formatRecap).find(Boolean) : undefined;
  if (recap) out.push({ ...base, message_uuid: text ? `${o.uuid}:recap` : o.uuid, content: recap, kind: 'recap' });
  return out;
}

/**
 * A meta user line is the harness's or another session's, not the person's, except a message from another session
 * that carries the person's words (hooks/prompt-sender.ts relayedLogText): that one is their question and starts a turn,
 * kept as relayedLogText writes it. Subagent reports and other sessions' messages stay out.
 */
function parseRelayed(o: TranscriptLine): Parsed[] {
  if (o.isSidechain || !o.uuid || !o.sessionId || (o.origin?.kind ?? 'peer') !== 'peer') return [];
  const said = relayedLogText(blockText(o.message?.content).trim());
  if (!said) return [];
  return [{ session_id: o.sessionId, role: 'user', created_at: o.timestamp ?? new Date().toISOString(), message_uuid: o.uuid, content: said, kind: 'prompt' }];
}

/** Text in a user line that the person did not say. */
function notSaid(text: string): boolean {
  return !text || SYNTHETIC_PREFIXES.some((p) => text.startsWith(p)) || HOOK_FEEDBACK.test(text);
}

/**
 * A queued message the person typed → one 'queued' entry (QUEUED_PREFIX in front), dated when it was sent. Only the
 * person's own count, by the same measure as user lines: there, messages from other sessions are meta lines and background
 * task ends are dropped by their frame, so here only origin 'human' is kept (and, from a version without origin, a plain
 * prompt whose text has no machine frame, hooks/prompt-sender.ts). A queued message from another session that carries
 * the person's words (relayedLogText) is kept the same way, as relayedLogText writes it.
 */
function parseQueued(o: TranscriptLine): Parsed[] {
  const q = o.attachment;
  if (q?.type !== 'queued_command' || o.isMeta || o.isSidechain || !o.uuid || !o.sessionId) return [];
  const text = blockText(q.prompt).trim();
  const human = q.origin?.kind ? q.origin.kind === 'human' : (q.commandMode ?? 'prompt') === 'prompt' && promptSource(text) === 'user';
  const said = human ? (notSaid(text) ? '' : text) : relayedLogText(text);
  if (!said) return [];
  const at = q.timestamp && !Number.isNaN(Date.parse(q.timestamp)) ? q.timestamp : (o.timestamp ?? new Date().toISOString());
  return [{ session_id: o.sessionId, role: 'user', created_at: at, message_uuid: o.uuid, content: QUEUED_PREFIX + said, kind: 'queued' }];
}

/**
 * The transcript writes a queued message where the turn took it in (often after a tool result), later than it was
 * sent. Moves it back before the entries of its turn written after it was sent, so the log reads in the order things
 * happened; it never moves past the turn's prompt.
 */
export function placeQueued(parsed: Parsed[]): Parsed[] {
  const out: Parsed[] = [];
  for (const p of parsed) {
    let at = out.length;
    if (p.kind === 'queued') {
      const sent = Date.parse(p.created_at);
      while (at > 0 && out[at - 1].kind !== 'prompt' && out[at - 1].kind !== 'queued' && Date.parse(out[at - 1].created_at) > sent) at--;
    }
    out.splice(at, 0, p);
  }
  return out;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** AskUserQuestion result → "[선택 응답]" lines; these are decisions, so they must be archived. */
function formatAnswers(r: TranscriptLine['toolUseResult']): string | null {
  if (!r || !Array.isArray(r.questions) || !r.answers || typeof r.answers !== 'object') return null;
  const lines = Object.entries(r.answers).map(([q, a]) => {
    const note = r.annotations?.[q]?.notes;
    return `- ${q} → ${Array.isArray(a) ? a.join(', ') : String(a)}${note ? ` (메모: ${note})` : ''}`;
  });
  return lines.length ? `[선택 응답]\n${lines.join('\n')}` : null;
}

/** The app's end-of-turn summary tool (…__wrap_up): often the only statement of what a turn did. */
function formatRecap(b: ContentBlock): string | null {
  if (b?.type !== 'tool_use' || !b.name?.endsWith('wrap_up') || typeof b.input?.recap !== 'string') return null;
  const ask = typeof b.input.ask === 'string' ? `\n[질문] ${b.input.ask}` : '';
  return `[턴 요약] ${b.input.recap}${ask}`;
}

/**
 * Within one turn (from a user prompt to the next), assistant prose before a
 * tool call is progress narration ("이제 테스트를 돌릴게요"). Only the last
 * prose block of the turn is the answer; earlier ones are dropped.
 */
export function selectEntries(parsed: Parsed[], answer?: AnswerOverride): Entry[] {
  const keep = parsed.map(() => true);
  let lastText = -1;
  parsed.forEach((p, i) => {
    // A queued message is said inside the turn: the turn's answer is still its last prose.
    if (p.kind === 'prompt') lastText = -1;
    else if (p.kind === 'text') {
      if (lastText >= 0) keep[lastText] = false;
      lastText = i;
    }
  });
  return parsed
    .filter((_, i) => keep[i])
    .map(({ kind, ...e }) => ({ ...e, content: redactSecrets(kind === 'text' && answer && e.message_uuid === answer.uuid ? answer.content : e.content) }));
}

/**
 * The answer a turn really ended with, when it is more than its last text line: lines added after an answer the Stop
 * hook sent back for missing lines (mistake-guards/stop-guard.ts 'fill'). That line's row holds the whole answer.
 */
export interface AnswerOverride {
  /** Transcript uuid of the answer's last text line. */
  uuid: string;
  content: string;
}

const OFFSET_PREFIX = 'ingest_offset:';

/** Forgets the read position of transcripts that no longer exist (Claude Code deletes old ones). Returns how many. */
export function pruneIngestOffsets(store: Store): number {
  let n = 0;
  for (const { key } of store.metaWithPrefix(OFFSET_PREFIX)) {
    if (!fs.existsSync(key.slice(OFFSET_PREFIX.length))) {
      store.deleteMeta(key);
      n++;
    }
  }
  return n;
}

/**
 * Ingests new lines since the last call for this transcript. The byte offset is
 * kept in meta, and only complete lines are consumed, so a transcript being
 * written concurrently is safe. Re-ingesting is harmless (message_uuid is unique).
 */
export function ingestTranscript(store: Store, transcriptPath: string, answer?: AnswerOverride): { added: number; offset: number } {
  const key = OFFSET_PREFIX + transcriptPath;
  let offset = Number(store.getMeta(key) ?? 0);
  const size = fs.statSync(transcriptPath).size;
  if (size < offset) offset = 0; // file was rewritten
  if (size === offset) return { added: 0, offset };

  const fd = fs.openSync(transcriptPath, 'r');
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(size - offset);
    fs.readSync(fd, chunk, 0, chunk.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { added: 0, offset };
  const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');

  // The Stop hook runs at the end of a turn, so a chunk holds whole turns.
  const entries = selectEntries(placeQueued(complete.split('\n').filter(Boolean).flatMap(parseTranscriptLine)), answer);
  const added = store.appendLog(entries);
  const newOffset = offset + lastNewline + 1;
  store.setMeta(key, String(newOffset));
  cleanRewound(store, transcriptPath);
  return { added, offset: newOffset };
}
