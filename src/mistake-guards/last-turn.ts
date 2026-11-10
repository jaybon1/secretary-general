/**
 * The turn that just ended, read from the Claude Code transcript (JSONL) by the Stop hook: where it started, the tools it
 * called in order, and the answer it ends with (the text after its last tool call). The conversation log (raw_log) keeps
 * no tool calls, so this is the only place they are seen.
 */
import fs from 'node:fs';

export interface Turn {
  /** uuid of the transcript line that started it (a user prompt, a background notification), '' when none was read. */
  startUuid: string;
  /** What started it, as the user line says (empty for a tool result). */
  startText: string;
  /** Tool names in call order; a skill call is "Skill:<name>". */
  tools: string[];
  /** The text the turn ends with: every text block after its last tool call. */
  answer: string;
  /** Every text block of the turn, before tool calls too (question labels are counted from all of it). */
  allText?: string;
  /** The last assistant line was written by the app, not the model (usage limit, API error). */
  synthetic: boolean;
  /** uuid of the turn's last assistant line ('' when none): where an answer sent back by the Stop hook ended. */
  lastUuid: string;
}

export interface Block {
  type?: string;
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}
export interface Line {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: { model?: string; content?: unknown };
}

/** The transcript's last part read for a turn (a turn longer than this is read from where this starts). */
const TAIL_BYTES = 8 * 1024 * 1024;

function tailLines(file: string): string[] {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // cut mid-line
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

export const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : typeof content === 'string' ? [{ type: 'text', text: content }] : []);

/** What a Stop hook that sent the turn back says to the model (the app's own words, or this hook's reason). */
export const HOOK_FEEDBACK = /^\s*(Stop hook feedback|\[답 검사\])/;

/**
 * A user line that starts a turn: not a tool result, not text the app adds inside a turn (isMeta, e.g. a loaded skill),
 * not a Stop hook's reason for going on.
 */
export function startsTurn(o: Line): boolean {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return false;
  const bs = blocks(o.message?.content);
  if (bs.some((b) => b?.type === 'tool_result')) return false;
  return !bs.some((b) => b?.type === 'text' && HOOK_FEEDBACK.test(b.text ?? ''));
}

export function toolName(b: Block): string {
  const name = b.name ?? '?';
  if (name === 'Skill' && typeof b.input?.skill === 'string') return `Skill:${b.input.skill}`;
  return name;
}

/**
 * The last turn of a transcript's lines (JSON strings). With afterUuid (the last line of an answer the Stop hook sent
 * back) the answer is only what was written after that line.
 */
export function lastTurn(lines: string[], afterUuid = ''): Turn {
  const parsed: Line[] = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l) as Line);
    } catch {}
  }
  let start = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (startsTurn(parsed[i])) {
      start = i;
      break;
    }
  }
  const turn: Turn = { startUuid: '', startText: '', tools: [], answer: '', synthetic: false, lastUuid: '' };
  if (start >= 0) {
    turn.startUuid = parsed[start].uuid ?? '';
    turn.startText = blocks(parsed[start].message?.content)
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  let texts: string[] = [];
  const all: string[] = [];
  for (const o of parsed.slice(start + 1)) {
    if (o.type !== 'assistant' || o.isSidechain) continue;
    turn.synthetic = o.message?.model === '<synthetic>' || o.isApiErrorMessage === true;
    turn.lastUuid = o.uuid ?? turn.lastUuid;
    for (const b of blocks(o.message?.content)) {
      if (b?.type === 'tool_use') {
        turn.tools.push(toolName(b));
        texts = [];
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        texts.push(b.text);
        all.push(b.text);
      }
    }
    // The answer that was sent back ends here: what counts is written after it.
    if (afterUuid && o.uuid === afterUuid) texts = [];
  }
  turn.answer = texts.join('\n\n').trim();
  turn.allText = all.join('\n\n').trim();
  return turn;
}

export function readLastTurn(transcriptPath: string, afterUuid = ''): Turn | null {
  try {
    return lastTurn(tailLines(transcriptPath), afterUuid);
  } catch {
    return null;
  }
}
