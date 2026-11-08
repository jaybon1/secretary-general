/**
 * The previous answer as extra search context for auto-injection: a short reply ("1번으로") means
 * little alone, but the question it answers is in the secretary's last answer. That answer is read
 * from the transcript's tail on each prompt and compressed to its searchable lines; nothing is stored.
 *
 * Tried on 129 real questions (2026-11-02): question alone F1 0.25, merged with question + compressed
 * answer 0.37 (the whole answer helped less: its other topics pulled in unrelated memories).
 */
import { tailLines } from '../hooks/context-size-nudge.ts';
import { parseTranscriptLine } from '../log/ingest-transcript.ts';
import { SEM_POOL } from './recall.ts';
import { semanticClient, type SemanticHits, type SemanticSearch } from '../semantic/client.ts';

/** The second search drifts more than the question alone, so its lead counts this much less. */
export const PREV_PENALTY = 0.02;
/** The question alone waits as before; the longer query gets more time, and falls back to the question's results. */
const QUESTION_TIMEOUT_MS = 1500;
const PREV_TIMEOUT_MS = 5000;

interface Block {
  type?: string;
  text?: string;
}

/**
 * The secretary's answer since the last user prompt: the prose after its last tool call (earlier
 * prose is progress narration, as log/ingest-transcript.ts drops it). '' at a session's first prompt.
 * The current prompt may already be in the transcript, so a prompt equal to it is passed over.
 */
export function lastAnswer(transcriptPath: string, prompt: string): string {
  const lines = tailLines(transcriptPath);
  const parts: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type === 'user') {
      const p = parseTranscriptLine(lines[i]);
      if (p[0]?.kind !== 'prompt') continue;
      if (parts.length === 0 && p[0].content === prompt.trim()) continue;
      break;
    }
    if (o.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) continue;
    const blocks = o.message.content as Block[];
    let toolCall = false;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type === 'tool_use') {
        toolCall = true;
        if (parts.length) break;
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() && !toolCall) parts.unshift(b.text.trim());
    }
    if (toolCall && parts.length) break;
  }
  return parts.join('\n');
}

/** The lines of an answer worth searching with, by the answer format the rules fix. */
export function compress(answer: string): string {
  const lines = answer
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const keep: string[] = [];
  if (lines[0]) keep.push(lines[0].replace(/^>\s*/, ''));
  let inQuestion = false;
  let asked = false;
  for (const raw of lines.slice(1)) {
    // Older answers bolded the question line ("**I. …?** 설명").
    const l = raw.replace(/^\*\*([A-Z]{1,2}(\([^)]*\))?\.\s[^*]+)\*\*/, '$1');
    if (/^[A-Z]{1,2}(\([^)]*\))?\.\s.+\?/.test(l)) {
      keep.push(l);
      inQuestion = asked = true;
      continue;
    }
    if (inQuestion && /^\d+\.\s/.test(l)) {
      keep.push(l.replace(/\s*\(추천\)/, ''));
      continue;
    }
    inQuestion = false;
    if (/^\*\*[^*]+\*\*$/.test(l)) keep.push(l.replace(/\*/g, ''));
  }
  let text = keep.join('\n');
  // No question to answer: the end of the answer is what a reply most likely picks up.
  if (!asked) text += '\n' + answer.slice(-600);
  return text.slice(0, 1500);
}

/**
 * Two searches as one: each memory keeps its better lead over its own search's median, the second
 * search's lead less PREV_PENALTY, top SEM_POOL kept. Sims are put back on the question search's median
 * (sim = lead + median), so recall scores them as before. Either may be null (failed or too slow).
 */
export function mergeHits(question: SemanticHits | null, withPrev: SemanticHits | null): SemanticHits | null {
  if (!withPrev) return question;
  const base = question ?? withPrev;
  const lead = new Map<number, number>();
  for (const h of question?.hits ?? []) lead.set(h.id, h.sim - question!.median);
  for (const h of withPrev?.hits ?? []) {
    const v = h.sim - withPrev!.median - PREV_PENALTY;
    if (!lead.has(h.id) || lead.get(h.id)! < v) lead.set(h.id, v);
  }
  const hits = [...lead]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEM_POOL)
    .map(([id, l]) => ({ id, sim: l + base.median }));
  return { median: base.median, hits };
}

/**
 * Auto-injection's semantic search: the question alone and, with a previous answer, the question plus
 * its compressed form, sent together and merged. Without one, the question alone as before.
 */
export function prevAnswerSearch(
  compressed: string,
  quick: SemanticSearch = semanticClient(QUESTION_TIMEOUT_MS),
  slow: SemanticSearch = semanticClient(PREV_TIMEOUT_MS),
): SemanticSearch {
  return async (query, opts) => {
    if (!compressed) return quick(query, opts);
    // The question goes first: the helper answers one search at a time.
    const q = quick(query, opts);
    const p = slow(`${query}\n${compressed}`, opts);
    const [a, b] = await Promise.all([q, p]);
    return mergeHits(a, b);
  };
}
