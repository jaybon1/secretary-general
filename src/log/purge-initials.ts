/**
 * "비서 대화 삭제" preview with first letters (decided 2026-11-06, replacing the Haiku summaries with masking): so the
 * user can tell what a row is about while the secretary sees hardly anything of it. No model is called.
 * - A row's text, and each memory the deletion would invalidate, is split into words at whitespace; each word
 *   shows as its first letter or digit ("테스트해보자." → "테", "Seoul" → "S", "(점심" → "점"), joined by spaces,
 *   at most INITIALS_MAX (40). A chunk with no letter or digit (punctuation, symbols, emoji alone) is skipped
 *   and not counted. More words than that: " …(앞 40단어)" follows.
 * - The word count goes beside the character count; a text with no word shows "(단어 없음)".
 * - A row or memory whose text cannot be read is "에러" only.
 */
import { formatPreview, issuePurgeCode, LIST_ROWS, planPurge, USAGE, type PreviewLines, type PreviewOrigin, type PurgePlan, type PurgeSpec } from './purge.ts';
import type { Store } from '../store/store.ts';

/** At most this many first letters per line. */
export const INITIALS_MAX = 40;

const LETTER = /[\p{L}\p{N}]/u;

/** Each whitespace-separated word's first letter or digit, in order; chunks with neither are left out. */
export function wordInitials(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.normalize('NFC').split(/\s+/)) {
    const m = LETTER.exec(chunk);
    if (m) out.push(m[0]);
  }
  return out;
}

/** What follows the character count on a preview line: "6단어 — 대 삭 테 임 점 추". */
export function initialsText(text: string, max = INITIALS_MAX): string {
  const all = wordInitials(text);
  if (!all.length) return '0단어 — (단어 없음)';
  const shown = all.slice(0, max).join(' ');
  return `${all.length}단어 — ${shown}${all.length > max ? ` …(앞 ${max}단어)` : ''}`;
}

/** The texts of a plan: its listed rows, then its memories (undefined when not found). */
export function planTexts(store: Store, plan: PurgePlan): { rows: Array<string | undefined>; memories: Array<string | undefined> } {
  const row = store.db.prepare('SELECT content FROM raw_log WHERE id = ?');
  return {
    rows: plan.rows.slice(0, LIST_ROWS).map((r) => (row.get(r.id) as { content: string } | undefined)?.content),
    memories: plan.memoryIds.map((id) => store.getMemory(id)?.content),
  };
}

export interface PreviewOptions extends PreviewOrigin {
  /** Where to look for transcripts (remember results); default: this project's transcript folders. */
  dirs?: string[];
}

/**
 * `purge-log preview`: what the secretary passes on for a "비서 대화 삭제" phrase. Lists the rows and memories, each
 * with its first letters, and ends in the approval code. An unusable target gives the reason and how to write it.
 */
export function runPreview(store: Store, spec: PurgeSpec, o: PreviewOptions = {}): string {
  const plan = planPurge(store, spec, { sessionId: o.here, sessionPrefix: o.sessionPrefix, dirs: o.dirs });
  if ('error' in plan) return `[대화 지우기] ${plan.error}\n${USAGE}`;
  const t = planTexts(store, plan);
  const lines: PreviewLines = {
    rows: t.rows.map((x) => (x === undefined ? ' — 에러' : ` · ${initialsText(x)}`)),
    memories: t.memories.map((x) => (x === undefined ? ' — 에러' : ` ${[...x].length.toLocaleString('en-US')}자 · ${initialsText(x)}`)),
  };
  const code = issuePurgeCode(store, plan, { here: o.here, sessionPrefix: o.sessionPrefix });
  return formatPreview(plan, code, lines);
}
