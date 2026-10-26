/**
 * Archives Claude Code transcripts (JSONL) into raw_log. Runs from the Stop hook,
 * so the conversation is recorded without the model spending any tokens on it.
 */
import fs from 'node:fs';
import type { LogEntry, Store } from './store.ts';
import { redactSecrets } from './text.ts';

type Entry = Omit<LogEntry, 'id'>;

/**
 * prompt: what the user typed · answer: the user's picks in an AskUserQuestion ·
 * text: assistant prose · recap: the assistant's end-of-turn summary (wrap_up).
 */
type Kind = 'prompt' | 'answer' | 'text' | 'recap';
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
    if (!text || SYNTHETIC_PREFIXES.some((p) => text.startsWith(p))) return [];
    return [{ ...base, message_uuid: o.uuid, content: text, kind: 'prompt' }];
  }

  const out: Parsed[] = [];
  const text = blockText(content).trim();
  if (text) out.push({ ...base, message_uuid: o.uuid, content: text, kind: 'text' });
  const recap = Array.isArray(content) ? content.map(formatRecap).find(Boolean) : undefined;
  if (recap) out.push({ ...base, message_uuid: text ? `${o.uuid}:recap` : o.uuid, content: recap, kind: 'recap' });
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
export function selectEntries(parsed: Parsed[]): Entry[] {
  const keep = parsed.map(() => true);
  let lastText = -1;
  parsed.forEach((p, i) => {
    if (p.kind === 'prompt') lastText = -1;
    else if (p.kind === 'text') {
      if (lastText >= 0) keep[lastText] = false;
      lastText = i;
    }
  });
  return parsed.filter((_, i) => keep[i]).map(({ kind: _kind, ...e }) => ({ ...e, content: redactSecrets(e.content) }));
}

/**
 * Ingests new lines since the last call for this transcript. The byte offset is
 * kept in meta, and only complete lines are consumed, so a transcript being
 * written concurrently is safe. Re-ingesting is harmless (message_uuid is unique).
 */
export function ingestTranscript(store: Store, transcriptPath: string): { added: number; offset: number } {
  const key = `ingest_offset:${transcriptPath}`;
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
  const entries = selectEntries(complete.split('\n').filter(Boolean).flatMap(parseTranscriptLine));
  const added = store.appendLog(entries);
  const newOffset = offset + lastNewline + 1;
  store.setMeta(key, String(newOffset));
  return { added, offset: newOffset };
}
