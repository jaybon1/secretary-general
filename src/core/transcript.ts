/**
 * Claude Code's conversation records (transcripts, JSONL: `<config folder>/projects/<project folder>/<session uuid>.jsonl`)
 * read in one place: one line parsed safely, a file's end read, a work session's file found, an answer put back together
 * from its lines, the last model call's size, and how a file has moved.
 *
 * The line kinds are not a published format and keep growing (atis-latch, api-request, queue-operation, last-prompt, …),
 * so every reader here skips kinds it does not know. What is known and relied on:
 * - One assistant answer (one model call) is written as several lines with the same `message.id` (thinking, text,
 *   tool calls each on a line of their own); usage repeats on each.
 * - A subagent's lines carry `isSidechain` (newer versions write them to `<uuid>/subagents/*.jsonl` beside the file);
 *   a line the app wrote in the model's place (usage limit, API error) has `isApiErrorMessage` or model `<synthetic>`.
 * - A rewind leaves the abandoned branch in the file (parentUuid, last-prompt.leafUuid); a compaction goes on in the
 *   same file after a `compact_boundary` line.
 * - There is no line for a pending approval prompt and no usage-limit percentage.
 *
 * What each reader decides from the lines (what is logged, what a rewind drops, what a turn is) stays in its own file:
 * log/ingest-transcript.ts, log/rewind.ts, mistake-guards/last-turn.ts and the rest.
 */
import fs from 'node:fs';
import path from 'node:path';

/** How much of a file's end is read when the caller does not say: enough for the last turns of the secretary's own talk. */
export const DEFAULT_TAIL_BYTES = 512 * 1024;
/** A work session's lines can be several MB (tool output), so its end is read wider. */
export const WORKER_TAIL_BYTES = 4 * 1024 * 1024;

export interface Block {
  type?: string;
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

/** One transcript line, as far as the readers here use it; every other field is left as it comes. */
export interface TranscriptRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: { id?: string; model?: string; role?: string; content?: unknown; usage?: Usage; stop_reason?: string | null };
  [key: string]: unknown;
}

/** One line → its object; null for a line cut mid-way, an empty line, or JSON that is not an object. */
export function parseLine(line: string): TranscriptRecord | null {
  if (!line) return null;
  try {
    const o = JSON.parse(line) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as TranscriptRecord) : null;
  } catch {
    return null;
  }
}

export function parseLines(lines: string[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const l of lines) {
    const o = parseLine(l);
    if (o) out.push(o);
  }
  return out;
}

/**
 * The file's last `tailBytes` as lines. As read, the first line is usually cut mid-way and the last one is ''.
 * wholeOnly: the cut first line (when the read did not start at the file's start) and empty lines are dropped.
 */
export function tailLines(file: string, tailBytes = DEFAULT_TAIL_BYTES, opts: { wholeOnly?: boolean } = {}): string[] {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - tailBytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (!opts.wholeOnly) return lines;
  if (start > 0) lines.shift();
  return lines.filter(Boolean);
}

/** A message's content as blocks: a plain string is one text block. */
export const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : typeof content === 'string' ? [{ type: 'text', text: content }] : []);

/** Tokens a model call read: input + cache read + cache write. */
export const contextOf = (u: Usage): number => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

/**
 * Tokens the last model call read, from the file's last `tailBytes`; 0 if none.
 * The search stops at a compaction boundary (0): right after /compact the last call is still the pre-compact
 * one, whose size is no longer the context (a "31만 토큰" nudge once came right after /compact).
 */
export function lastContextTokens(file: string, tailBytes = DEFAULT_TAIL_BYTES): number {
  const lines = tailLines(file, tailBytes);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"compact_boundary"')) return 0;
    if (!lines[i].includes('"usage"')) continue;
    const u = parseLine(lines[i])?.message?.usage;
    if (u) return contextOf(u);
  }
  return 0;
}

/** The folder name Claude Code gives a working folder under projects/: every character but A-Z, a-z, 0-9 becomes '-'. */
export const projectFolderName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/**
 * The transcript of session `id` (short id or full uuid, "bg:" or not) under a config folder's projects folder:
 * `<projects>/<project folder>/<uuid>.jsonl` whose name starts with the id; the newest when more match. Null when none.
 */
export function findTranscript(projectsDir: string, id: string): string | null {
  const want = id.replace(/^bg:/, '').trim().toLowerCase();
  if (want.length < 8) return null;
  let best: { file: string; mtime: number } | null = null;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.jsonl') || !lower.startsWith(want)) continue;
      const file = path.join(dir, name);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      } catch {
        // Gone between the listing and the look.
      }
    }
  }
  return best?.file ?? null;
}

/**
 * A background (work) session's transcript under its config folder. First the path the background service keeps in the
 * session's job file (`<config>/jobs/<short id>/state.json` linkScanPath; most have it, some do not), then a search of
 * `<config>/projects` by the session's uuid (`sessionId`, when known) or the short id. Null when none.
 */
export function findSessionTranscript(configDir: string, id: string, sessionId?: string): string | null {
  const short = id.replace(/^bg:/, '').trim().toLowerCase();
  const want = (sessionId || short).replace(/^bg:/, '').trim().toLowerCase();
  if (/^[0-9a-z-]{6,}$/.test(short)) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(configDir, 'jobs', short.slice(0, 8), 'state.json'), 'utf8')) as { linkScanPath?: unknown };
      const p = state.linkScanPath;
      if (typeof p === 'string' && p.toLowerCase().endsWith('.jsonl') && path.basename(p).toLowerCase().startsWith(want.slice(0, 8)) && fs.existsSync(p)) return p;
    } catch {
      // No job file, or one without the path: look under projects.
    }
  }
  return findTranscript(path.join(configDir, 'projects'), want);
}

/** Where the subagents of the session in `file` write their own transcripts: `<folder>/<uuid>/subagents`. */
export const subagentsDir = (file: string): string => path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');

/** A user line someone typed (a prompt): not a tool result, a meta line or a sub-agent's line. */
export function isTypedPrompt(o: TranscriptRecord): boolean {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return false;
  const c = o.message?.content;
  if (typeof c === 'string') return true;
  if (!Array.isArray(c) || (c as Block[]).some((b) => b?.type === 'tool_result')) return false;
  return (c as Block[]).some((b) => b?.type === 'text');
}

/** One answer of the model (one model call) put back together from its lines with the same message.id. */
export interface Reply {
  /** message.id; '' when the lines carry none (then the answer is that one line). */
  id: string;
  /** Text blocks in order (blank ones left out). */
  texts: string[];
  /** Tool names called in it, in order. */
  tools: string[];
  /** Written by the app, not the model (usage limit, API error). */
  synthetic: boolean;
  /** uuid and time of its last line. */
  uuid: string;
  timestamp: string;
}

/**
 * The last answer of the main conversation (sub-agents' lines left out), its lines with the same message.id gathered.
 * withText: an answer with no text (only thinking or tool calls) is passed over for the one before.
 * untilPrompt: a prompt typed after it means the talk went on, so there is none (null).
 */
export function lastReply(records: TranscriptRecord[], opts: { withText?: boolean; untilPrompt?: boolean } = {}): Reply | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const o = records[i];
    if (opts.untilPrompt && isTypedPrompt(o)) return null;
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const id = typeof o.message?.id === 'string' ? o.message.id : '';
    const group = id ? records.filter((r) => r.type === 'assistant' && !r.isSidechain && r.message?.id === id) : [o];
    const reply: Reply = { id, texts: [], tools: [], synthetic: false, uuid: '', timestamp: '' };
    for (const r of group) {
      reply.synthetic ||= r.message?.model === '<synthetic>' || r.isApiErrorMessage === true;
      reply.uuid = r.uuid ?? reply.uuid;
      reply.timestamp = r.timestamp ?? reply.timestamp;
      for (const b of blocks(r.message?.content)) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) reply.texts.push(b.text);
        else if (b?.type === 'tool_use') reply.tools.push(b.name ?? '?');
      }
    }
    if (opts.withText && !reply.texts.length) {
      // Skip the rest of this answer's lines: with an id they are all in the group already.
      if (id) while (i > 0 && records[i - 1].type === 'assistant' && records[i - 1].message?.id === id) i--;
      continue;
    }
    return reply;
  }
  return null;
}

/** Size and time of one file; null when it cannot be seen. */
function look(file: string): { size: number; mtime: number } | null {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export interface Activity {
  /** Changes whenever the session or one of its subagents writes a line: compare two of these. */
  signature: string;
  /** The last write to any of the files (ms). */
  lastWriteMs: number;
  subagents: number;
}

/** How far a session has written: its transcript's size and time and those of its subagents' transcripts. Null when the file is gone. */
export function transcriptActivity(file: string): Activity | null {
  const main = look(file);
  if (!main) return null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(subagentsDir(file)).filter((n) => n.toLowerCase().endsWith('.jsonl')).sort();
  } catch {
    // No subagent yet.
  }
  let size = 0;
  let last = main.mtime;
  for (const n of names) {
    const s = look(path.join(subagentsDir(file), n));
    if (!s) continue;
    size += s.size;
    last = Math.max(last, s.mtime);
  }
  return { signature: `${main.size}:${Math.round(main.mtime)}|${names.length}:${size}:${Math.round(last)}`, lastWriteMs: last, subagents: names.length };
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return [...t].length > max ? `${[...t].slice(0, max - 1).join('')}…` : t;
};

/** What a tool call was about, in a few words: its description, command, file or pattern. */
function toolHint(b: Block): string {
  const i = b.input ?? {};
  for (const k of ['description', 'command', 'file_path', 'pattern', 'url', 'prompt', 'skill']) {
    if (typeof i[k] === 'string' && (i[k] as string).trim()) return oneLine(i[k] as string, 80);
  }
  return '';
}

/**
 * The session's last steps, for a person: the last tool it called (and what for) and the start of the last thing it
 * wrote, from the main conversation's lines. Empty when there is neither.
 */
export function lastSteps(records: TranscriptRecord[], textChars = 200): { tool: string; text: string } {
  let tool = '';
  let text = '';
  for (let i = records.length - 1; i >= 0 && (!tool || !text); i--) {
    const o = records[i];
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const bs = blocks(o.message?.content);
    for (let j = bs.length - 1; j >= 0; j--) {
      const b = bs[j];
      if (!tool && b?.type === 'tool_use') {
        const hint = toolHint(b);
        tool = `${b.name ?? '?'}${hint ? ` - ${hint}` : ''}`;
      } else if (!text && b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) text = oneLine(b.text, textChars);
    }
  }
  return { tool, text };
}
