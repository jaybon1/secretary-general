/**
 * The situation board's "답 없음·미정" lines held to the decision memories (P4 of the 2026-11-13 askback review, the user's
 * call). The board is rewritten by a model that sees the conversation but not the memories, so a decision
 * made inside another question's answer can stand on it as "답 없음" (the secretary once passed such a line on). When the
 * board is attached, each such line gets the one or two decision memories that share the most words with it, by number
 * and first words, so the secretary opens them before saying nothing was decided. Word search only: no model call, and
 * nothing waits for the semantic-search server on the prompt hook.
 */
import type { Memory, Store } from '../store/store.ts';
import { searchTerms } from '../memory/search-terms.ts';
import { formatLocal } from '../core/kst-time.ts';

/** A board line that says something is still open. */
export const OPEN_LINE = /답\s*(?:없음|대기)|미정|안\s*함|미결|정하지\s*않/;
/** At most this many open lines get memories (the board's first ones), and this many memories each. */
export const OPEN_LINES_MAX = 8;
export const PER_LINE = 2;
/** A memory counts as related when it holds at least this share of the line's search terms, and this many of them. */
const MIN_SHARE = 0.3;
const MIN_SHARED = 3;
const FIRST_WORDS = 60;

/** The line's own words: its evidence numbers, labels and markup taken out. */
function lineWords(line: string): string {
  return line
    .replace(/\(\s*(?:끝난 듯|조건 채워진 듯)?[^()]*#\d[^()]*\)/g, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/^\s*[-*]\s*/, '')
    .replace(/\b[A-Z]{1,3}\d?\b/g, ' ')
    .replace(/[`*]/g, ' ');
}

export interface OpenLineMatch {
  line: string;
  memories: Memory[];
}

/** The open lines of a board and the decision memories each shares the most words with (lines with none left out). */
export function openLineDecisions(store: Store, boardText: string): OpenLineMatch[] {
  const out: OpenLineMatch[] = [];
  const lines = boardText.split('\n').filter((l) => /^\s*[-*]\s/.test(l) && OPEN_LINE.test(l)).slice(0, OPEN_LINES_MAX);
  for (const line of lines) {
    const words = lineWords(line);
    const mine = new Set(searchTerms(words));
    if (mine.size < MIN_SHARED) continue;
    const memories = store
      .searchMemories(words, { limit: 40 })
      .filter((m) => m.kind === 'decision')
      .map((m) => {
        const theirs = new Set(searchTerms(m.content));
        const shared = [...mine].filter((t) => theirs.has(t)).length;
        return { m, shared };
      })
      .filter((x) => x.shared >= MIN_SHARED && x.shared / mine.size >= MIN_SHARE)
      .sort((a, b) => b.shared - a.shared || b.m.id - a.m.id)
      .slice(0, PER_LINE)
      .map((x) => x.m);
    if (memories.length) out.push({ line: line.trim().replace(/^[-*]\s*/, ''), memories });
  }
  return out;
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

/** The lines put under the board ([] when no open line has a related decision). */
export function boardDecisionLines(store: Store, boardText: string): string[] {
  let found: OpenLineMatch[];
  try {
    found = openLineDecisions(store, boardText);
  } catch {
    return [];
  }
  if (!found.length) return [];
  return [
    '[상황판의 "답 없음·미정" 줄과 단어가 겹치는 결정 기억] (프로그램이 단어로 찾음. 그 줄을 "답 없음·미정"으로 전하기 전에 recall(ids)로 열어 이미 정한 것인지 본다)',
    ...found.map(
      (f) => `- "${clip(f.line, 70)}" → ${f.memories.map((m) => `#${m.id}(${formatLocal(m.valid_from, true).slice(0, 10)}) ${clip(m.content.replace(/^\s*\d{4}-\d{2}-\d{2}\s*/, ''), FIRST_WORDS)}`).join(' / ')}`,
    ),
  ];
}
