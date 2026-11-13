/**
 * Recall pipeline:  candidates (FTS5, free)  →  rerank  →  merge with semantic hits  →  pack under a hard token budget.
 *
 * The rerank stage is a plug-in point. Today it's a cheap heuristic; later a
 * probabilistic judge model can replace it without touching storage or packing.
 * Semantic hits (semantic-search/client.ts) are optional: when the server isn't ready, recall is word search alone.
 */
import { quoteNote } from './source-quote.ts';
import { CANDIDATE_POOL } from '../core/config.ts';
import { semanticClient, type SemanticHits, type SemanticSearch } from '../semantic-search/client.ts';
import type { Memory, Store } from '../store/store.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { formatLocal } from '../core/kst-time.ts';
import { queryTerms, searchTerms } from './search-terms.ts';

export interface Candidate {
  memory: Memory;
  /** FTS5 bm25 rank (lower = better). */
  rank: number;
}

export interface Scored {
  memory: Memory;
  score: number;
}

export interface CorpusStats {
  docCount: number;
  docFreq: Map<string, number>;
}

export interface Reranker {
  readonly name: string;
  rerank(query: string, candidates: Candidate[], corpus: CorpusStats): Promise<Scored[]> | Scored[];
}

export interface RecallOptions {
  budgetTokens: number;
  includeInvalid?: boolean;
  /** Candidates scoring below this are dropped rather than spent on. */
  minScore?: number;
  /** Memories to leave out, e.g. ones this session's context already holds. */
  excludeIds?: ReadonlySet<number>;
  reranker?: Reranker;
  /** Meaning-based search merged with word search. Default: the server process, 1.5 s timeout; null turns it off. */
  semantic?: SemanticSearch | null;
  /** Put matching topic summaries ahead of single memories, so the current state survives the budget cut. */
  summariesFirst?: boolean;
}

export interface RecallResult {
  items: Scored[];
  text: string;
  tokens: number;
  /** Relevant results that didn't fit in the budget. */
  droppedForBudget: number;
  /** Those results themselves, best first, so a caller can list them by id. */
  dropped: Scored[];
}

const DAY_MS = 86_400_000;

/**
 * A term is "specific" if it isn't spread across much of the corpus. Matching
 * only "사용" (from "사용자는", which is in most memories) is noise, not relevance.
 */
function isSpecific(df: number, docCount: number): boolean {
  return df <= Math.max(3, docCount * 0.1);
}

/**
 * Default reranker: IDF-weighted coverage of the query plus relative bm25,
 * nudged by importance and recency. Query words that appear in no memory at all
 * are ignored for coverage, since nothing could have matched them.
 */
export const heuristicReranker: Reranker = {
  name: 'heuristic',
  rerank(query, candidates, corpus) {
    const q = queryTerms(query).filter((t) => (corpus.docFreq.get(t) ?? 0) > 0);
    if (q.length === 0 || candidates.length === 0) return [];
    const idf = (t: string) => Math.log(1 + corpus.docCount / (corpus.docFreq.get(t) ?? 1));
    const totalWeight = q.reduce((sum, t) => sum + idf(t), 0);
    const best = Math.min(...candidates.map((c) => c.rank)); // bm25 is negative; most negative is best
    const now = Date.now();
    const out: Scored[] = [];
    for (const c of candidates) {
      const docTerms = new Set(searchTerms(`${c.memory.content} ${c.memory.tags}`));
      const matched = q.filter((t) => docTerms.has(t));
      const coverage = matched.reduce((sum, t) => sum + idf(t), 0) / totalWeight;
      // Pass on one specific term, or on several common terms that together cover most of the query.
      const specific = matched.some((t) => isSpecific(corpus.docFreq.get(t) ?? 0, corpus.docCount));
      if (!specific && !(matched.length >= 2 && coverage >= 0.5)) continue;
      const bm25 = best < 0 ? c.rank / best : 0;
      out.push({ memory: c.memory, score: weigh(0.5 * coverage + 0.5 * bm25, c.memory, now) });
    }
    return out.sort((a, b) => b.score - a.score);
  },
};

/**
 * Importance, recency and use nudge relevance; shared by word and semantic matches so their scores compare.
 * Use counts only explicit recalls (not auto-injection), so a memory that once surfaced can't keep promoting itself.
 */
function weigh(relevance: number, m: Memory, now: number): number {
  const ageDays = (now - Date.parse(m.valid_from)) / DAY_MS;
  const recency = Math.exp(-Math.max(ageDays, 0) / 180);
  const use = 1 + 0.03 * Math.min(m.access_count, 5);
  return relevance * (0.85 + 0.05 * m.importance) * (0.8 + 0.2 * recency) * use;
}

/**
 * Similarities from the embedding model bunch together (unrelated text still scores
 * ~0.3-0.45 with BGE-m3-ko), so relevance is measured as the lead over the corpus
 * median: within SEM_MARGIN of it is noise, SEM_MARGIN + SEM_SPAN above it is a full match.
 * Tuned on 596 real memories (2026-10-25): true matches led by 0.20-0.45, unrelated
 * questions' best by 0.10-0.18. (bge-m3 spread less: 0.07 / 0.08.)
 * Retuned on 129 real questions (2026-11-02): searching with the question plus the compressed
 * previous answer (memory/prev-answer-search.ts) scored best at a margin of 0.20 (F1 0.37, question alone 0.25).
 */
const SEM_MARGIN = 0.2;
const SEM_SPAN = 0.12;
export const SEM_POOL = 10;

function semanticScores(store: Store, hits: SemanticHits, includeInvalid: boolean | undefined): Scored[] {
  const now = Date.now();
  const out: Scored[] = [];
  for (const { id, sim } of hits.hits) {
    const relevance = Math.min((sim - hits.median - SEM_MARGIN) / SEM_SPAN, 1);
    if (relevance <= 0) continue;
    const memory = store.getMemory(id);
    if (!memory || (!includeInvalid && memory.valid_to)) continue;
    out.push({ memory, score: weigh(relevance, memory, now) });
  }
  return out;
}

/** A memory found both ways keeps its better score. */
function merge(a: Scored[], b: Scored[]): Scored[] {
  const best = new Map<number, Scored>();
  for (const s of [...a, ...b]) {
    const prev = best.get(s.memory.id);
    if (!prev || s.score > prev.score) best.set(s.memory.id, s);
  }
  return [...best.values()].sort((x, y) => y.score - x.score);
}

export async function recall(store: Store, query: string, opts: RecallOptions): Promise<RecallResult> {
  const semantic = opts.semantic === undefined ? semanticClient(1500, 'recall(기본)') : opts.semantic;
  const semanticHits = semantic?.(query, { includeInvalid: opts.includeInvalid, limit: SEM_POOL });
  const candidates = store
    .searchMemories(query, { includeInvalid: opts.includeInvalid, limit: CANDIDATE_POOL })
    .map(({ rank, ...memory }) => ({ memory: memory as Memory, rank }));
  const reranker = opts.reranker ?? heuristicReranker;
  const corpus = store.corpusStats(queryTerms(query));
  const lexical = await reranker.rerank(query, candidates, corpus);
  const hits = await semanticHits;
  const scored = merge(lexical, hits ? semanticScores(store, hits, opts.includeInvalid) : []).filter(
    (s) => s.score >= (opts.minScore ?? 0) && !opts.excludeIds?.has(s.memory.id),
  );
  // A decision shows the user's own words it was checked against (memory/source-quote.ts), so a retelling is read with them.
  const quoted = (m: Memory) => (m.kind === 'decision' ? quoteNote(store, m.id) : '');
  if (!opts.summariesFirst) return pack(scored, opts.budgetTokens, quoted);
  const ordered = [...scored.filter((s) => s.memory.kind === 'summary'), ...scored.filter((s) => s.memory.kind !== 'summary')];
  return pack(ordered, opts.budgetTokens, (m) => (m.kind === 'summary' ? newerNote(store, m) : quoted(m)));
}

/** How many newer (and how many ended) memories a summary's note lists by id before "외 N개". */
const NEWER_LISTED = 8;

/**
 * A topic summary is rewritten only at consolidation, so what was saved since can contradict it (a state that changed,
 * 2026-11-13 evaluation K). Under an injected summary: the topic's active memories made after it, by id, so the
 * secretary reads them (recall ids) before taking the summary as the current state; and the topic's memories that
 * stopped holding since (replaced or marked untrue, with what replaced them: fix C11, hindsight's retractions), since the
 * summary may still say them and a memory that ended raises no "newer" line by itself (forget, or a replacement filed
 * under another topic). Empty when there are none.
 */
export function newerNote(store: Store, summary: Memory): string {
  const topic = summary.tags.split(' ')[0];
  const list = <T>(xs: T[], show: (x: T) => string) => `${xs.slice(0, NEWER_LISTED).map(show).join(', ')}${xs.length > NEWER_LISTED ? ` 외 ${xs.length - NEWER_LISTED}개` : ''}`;
  const ids = store.newerInTopic(topic, summary.created_at, NEWER_LISTED + 20);
  const ended = store.endedInTopic(topic, summary.created_at, NEWER_LISTED + 20);
  const parts: string[] = [];
  if (ids.length) parts.push(`요약 뒤 새 기억(요약에 아직 안 들어감): ${list(ids, (id) => `#${id}`)}`);
  if (ended.length) parts.push(`요약 뒤 무효가 된 기억(요약에 아직 남아 있을 수 있음): ${list(ended, (e) => `#${e.id}${e.by ? `→#${e.by}` : ''}`)}`);
  return parts.length ? `  ${parts.join(' · ')}` : '';
}

/** Greedy fill in score order; skips items that don't fit and keeps trying smaller ones. `note` adds a line under an item (counted in the budget). */
export function pack(scored: Scored[], budgetTokens: number, note?: (m: Memory) => string): RecallResult {
  const items: Scored[] = [];
  const lines: string[] = [];
  const dropped: Scored[] = [];
  let tokens = 0;
  for (const s of scored) {
    const extra = note?.(s.memory);
    const line = formatMemory(s.memory) + (extra ? `
${extra}` : '');
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > budgetTokens) {
      dropped.push(s);
      continue;
    }
    items.push(s);
    lines.push(line);
    tokens += cost;
  }
  return { items, text: lines.join('\n'), tokens, droppedForBudget: dropped.length, dropped };
}

export function formatMemory(m: Memory): string {
  const date = formatLocal(m.valid_from, true);
  const tags = m.tags ? ` [${m.tags}]` : '';
  const status = m.valid_to
    ? ` (무효 ${formatLocal(m.valid_to, true)}${m.superseded_by ? ` → #${m.superseded_by}` : ''})`
    : '';
  return `#${m.id} ${m.kind} ${date}${status}: ${m.content}${tags}`;
}
