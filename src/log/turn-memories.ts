/**
 * Which memories a conversation session saved itself, read from its own transcript: the remember tool's answers
 * ("기억 #1234 저장", mcp/memory-tools.ts). The Stop hook links only these to the turn's prompt (store/conversation-log.ts
 * linkTurnMemories): the memory server does not know which session called it, and linking every memory saved after the
 * prompt also took in what another session or the memory consolidation (its topic summaries) saved meanwhile.
 */
import { blocks, parseLines, tailLines } from '../core/transcript.ts';

/** The remember tool's answer when it saved, as the transcript keeps it. */
export const rememberedText = (id: number): string => `기억 #${id} 저장`;
const REMEMBERED = /^기억 #(\d+) 저장/;
/** The remember tool of any MCP server name (mcp__secretary__remember). */
const REMEMBER_TOOL = /^mcp__.+__remember$/;
/** As much of the transcript's end as the answer checks read for a turn (mistake-guards/last-turn.ts). */
const TAIL_BYTES = 8 * 1024 * 1024;

interface ResultBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
}

/** The ids the remember calls in these transcript lines (JSON strings) saved, in order. Subagents' lines are not this session's. */
export function rememberedIds(lines: string[]): number[] {
  const calls = new Set<string>();
  const ids: number[] = [];
  for (const o of parseLines(lines)) {
    if (o.isSidechain) continue;
    for (const b of blocks(o.message?.content) as ResultBlock[]) {
      if (b?.type === 'tool_use' && b.id && REMEMBER_TOOL.test(b.name ?? '')) calls.add(b.id);
      else if (b?.type === 'tool_result' && b.tool_use_id && calls.has(b.tool_use_id)) {
        for (const t of blocks(b.content)) {
          const m = REMEMBERED.exec(t?.text ?? '');
          if (m) ids.push(Number(m[1]));
        }
      }
    }
  }
  return ids;
}

/** rememberedIds of a transcript file's end; [] when it can't be read. */
export function readRememberedIds(transcriptPath: string): number[] {
  try {
    return rememberedIds(tailLines(transcriptPath, TAIL_BYTES, { wholeOnly: true }));
  } catch {
    return [];
  }
}
