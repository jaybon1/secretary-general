/**
 * Fixed verdicts for the memory consolidation (decided 2026-11-13, evaluation step I; the shape follows hindsight's
 * consolidation prompt: a fixed effect per close observation, actions done by code).
 *
 * Before, the consolidation's model (Haiku) read recall results and chose by itself to skip, save, or supersede, calling
 * remember and forget directly; an old state could stay live because nothing made it look at the old memory (memory
 * the memory "UAC is off" lived on after UAC was turned on). Now each memory candidate goes through two tools
 * (mcp/consolidate-tools.ts, only on the consolidation's own server):
 *
 * 1. propose_memory: the code finds the close active memories (the recall search) and hands back the candidate's key
 *    (C1, C2…) and that list, each marked "(이 후보보다 나중에 말해짐)" when it was stated after the candidate.
 * 2. judge_memory: one verdict per listed memory (unrelated / repeats / changes / ends) and whether the candidate is
 *    lasting or once. A listed memory left without a verdict, or a verdict on a memory that was not listed, refuses the
 *    whole answer; the code then saves, replaces or skips (planJudgement, applyPlan).
 *
 * The code also does what a small model gets wrong both ways: it compares the times itself, and the time is when it was
 * said (the conversation row the candidate cites, `source_log_id`), never a date the model writes (fix C1 of the
 * 2026-11-13 source review: hindsight compares `mentioned_at`, taken from the conversation). So an older candidate never
 * replaces a memory stated after it (it is kept as an event, the earlier state).
 *
 * Fixes from the source review (decided 2026-11-13 by the user): C2 a verdict outside the list shown is
 * refused; C3 the duration is `once` (that one time only: an event that replaces nothing) or `lasting`, our own words
 * rather than hindsight's `momentary` (small talk, nothing recorded); C4 a replaced memory's part that still holds
 * (`rest`) is kept as a memory of its own; C5 a candidate that repeats a memory but adds to it saves what it adds
 * (hindsight `adds`/`new`); C8 `about` per candidate and per judged memory, so a lookalike name is seen; C9 the close
 * memories wait for the semantic-search server, and the run stops rather than judge on word search alone.
 */
import { MEMORY_KINDS, type Memory, type MemoryKind, type Store } from '../store/store.ts';
import { formatMemory, recall } from './recall.ts';
import { findQuote, QUOTE_MISSING, quoteFormProblem, saveQuote } from './source-quote.ts';
import type { SemanticSearch } from '../semantic-search/client.ts';

export const VERDICTS = ['unrelated', 'repeats', 'changes', 'ends'] as const;
export type Verdict = (typeof VERDICTS)[number];
/** `once`: true for that one time only (a permission or exception for one job, a single occurrence) → an event that replaces nothing. */
export const DURATIONS = ['lasting', 'once'] as const;
export type Duration = (typeof DURATIONS)[number];
/** The kinds a candidate can have: everything but the topic summary (that one is written with remember). */
export const CANDIDATE_KINDS = MEMORY_KINDS.filter((k) => k !== 'summary') as Exclude<MemoryKind, 'summary'>[];
/** How many close memories a candidate is judged against (hindsight judged "the closest", not every one). */
export const NEARBY_MAX = 5;
export const LATER_MARK = '(이 후보보다 나중에 말해짐)';
/**
 * How long the consolidation waits for the semantic-search server before it stops the run (C9). The real failure log
 * (secretary.db.semantic-search-server-failures.log, 2026-11-02 and 11-09) shows a crashed server answering again 3 and
 * 7 seconds later; a server whose model files are fetched again takes about a minute more (outage.ts CAUSE_GUIDE). Three
 * minutes covers both with room, and is small next to the run's 45-minute limit (staff/memory-consolidation.json).
 */
export const SEMANTIC_WAIT_MS = 3 * 60_000;
const SEMANTIC_POLL_MS = 5_000;

export interface CandidateInput {
  kind: Exclude<MemoryKind, 'summary'>;
  content: string;
  tags?: string[];
  importance?: number;
  /** The conversation row it rests on: its time is when the candidate was said (and its valid_from). */
  sourceLogId: number;
  /** A decision's short quote of the user's own words (memory/source-quote.ts): checked when proposed, kept when saved. */
  quote?: string;
}

export interface Candidate extends CandidateInput {
  key: string;
  /** When it was said: the time of conversation row `sourceLogId` (ISO). */
  saidAt: string;
  /** The close memories shown when it was proposed, closest first. */
  nearby: number[];
  /** Every memory the model was shown for it (the list, and those added in a refusal): the only ids a verdict may name. */
  shown: Set<number>;
  /** The highest memory id when it was proposed: a close memory saved after it must be judged too. */
  maxId: number;
}

export interface VerdictInput {
  id: number;
  verdict: Verdict;
  /** Who or what that memory's text is about, copied from its text (C8). */
  about?: string;
  /** changes/ends: what in the old memory still holds after the candidate (C4). */
  rest?: string;
}

export interface JudgeInput {
  duration: Duration;
  /** Who or what the candidate is about, copied from its text (C8). */
  about?: string;
  verdicts: VerdictInput[];
  /** With repeats: what the candidate says that the memories it repeats do not (C5). */
  adds?: string;
}

export interface Plan {
  /** Save a new memory: the candidate, or with repeats what it adds (replacing `supersedes`). */
  save?: { kind: MemoryKind; content: string; supersedes: number[] };
  /** No new memory for the candidate: an existing one (`by`) already says it; `ids` (changed or ended) are replaced by it. */
  replaceWith?: { by: number; ids: number[] };
  /** Replaced memories whose other part still holds: kept as a memory of its own (old kind, tags, valid_from, source). */
  rests: Array<{ id: number; content: string }>;
  /** Memories it repeats. */
  repeats: number[];
  /** Memories judged changes/ends but stated after the candidate: left as they are (the candidate is older news). */
  keptNewer: number[];
  /** Memories judged changes/ends by a `once` candidate: left as they are (a one-time exception changes no rule). */
  keptForOnce: number[];
  /** Verdicts on memories no longer live (replaced in the meantime): not acted on. */
  ignored: number[];
}

export type Judgement = { error: string } | Plan;

const ms = (iso: string) => Date.parse(iso);
const ids = (xs: number[]) => xs.map((i) => `#${i}`).join(', ');

/** When a memory was said: its conversation row's time when it has one, else when it was saved (C1). */
export function statedAt(store: Pick<Store, 'logAround'>, m: Pick<Memory, 'source_log_id' | 'created_at'>): string {
  const row = m.source_log_id ? store.logAround(m.source_log_id, 0, 0)[0] : undefined;
  return row?.id === m.source_log_id ? row.created_at : m.created_at;
}

/**
 * A verdict list turned into what to do. `required`: the close memories that must each have a verdict; `shown`: every
 * id the model was shown for this candidate; `lookup`: the memory as it is now (undefined when there is none); `said`:
 * when a memory was said (statedAt). Refuses (error) on a missing verdict, a memory judged twice, a made-up id, or one
 * that was not shown.
 */
export function planJudgement(
  c: Pick<Candidate, 'kind' | 'content' | 'saidAt'>,
  input: JudgeInput,
  required: number[],
  shown: ReadonlySet<number>,
  lookup: (id: number) => Memory | undefined,
  said: (m: Memory) => string = (m) => m.created_at,
): Judgement {
  const seen = new Map<number, VerdictInput>();
  const twice: number[] = [];
  for (const v of input.verdicts) {
    if (seen.has(v.id)) twice.push(v.id);
    seen.set(v.id, v);
  }
  if (twice.length) return { error: `한 기억에 판정이 둘: ${ids(twice)}. 기억마다 판정을 하나만 넣는다.` };
  const missing = required.filter((id) => !seen.has(id) && lookup(id)?.valid_to === null);
  if (missing.length) {
    return { error: `판정이 빠진 기억: ${ids(missing)}. 가까운 기억마다 판정을 하나씩(상관없으면 unrelated) 넣어 judge_memory를 다시 부른다.` };
  }
  const unknown = [...seen.keys()].filter((id) => !lookup(id));
  if (unknown.length) return { error: `없는 기억 번호: ${ids(unknown)}. propose_memory가 보여 준 번호로 판정한다.` };
  // A wrong number that happens to be a real memory would replace an unrelated one without a word (C2).
  const outside = [...seen.keys()].filter((id) => !shown.has(id));
  if (outside.length) return { error: `이 후보에 보여 준 목록 밖의 번호: ${ids(outside)}. propose_memory(와 거절 답)가 보여 준 번호로만 판정한다.` };
  const plan: Plan = { rests: [], repeats: [], keptNewer: [], keptForOnce: [], ignored: [] };
  const replace: number[] = [];
  for (const [id, v] of seen) {
    if (v.verdict === 'unrelated') continue;
    const m = lookup(id)!;
    if (m.valid_to !== null) {
      plan.ignored.push(id);
      continue;
    }
    if (v.verdict === 'repeats') plan.repeats.push(id);
    else if (ms(said(m)) > ms(c.saidAt)) plan.keptNewer.push(id);
    else if (input.duration === 'once') plan.keptForOnce.push(id);
    else {
      replace.push(id);
      const rest = v.rest?.trim();
      if (rest && rest === m.content.trim()) return { error: `#${id}의 rest가 옛 기억 글 그대로다. 바뀐 면이 없으면 unrelated, 있으면 rest에는 바뀌지 않은 나머지만 쓴다.` };
      if (rest) plan.rests.push({ id, content: rest });
    }
  }
  // Once (only that time), or older news against a memory stated after it: kept as what happened then.
  const kind: MemoryKind = input.duration === 'once' || plan.keptNewer.length ? 'event' : c.kind;
  if (plan.repeats.length) {
    // The newest of the memories that already say it stands for the candidate.
    const by = plan.repeats.reduce((a, b) => (b > a ? b : a));
    if (replace.length) plan.replaceWith = { by, ids: replace };
    const adds = input.adds?.trim();
    if (adds) plan.save = { kind, content: adds, supersedes: [] };
    return plan;
  }
  plan.save = { kind, content: c.content, supersedes: replace };
  return plan;
}

export interface Applied {
  saved?: number;
  superseded: number[];
  /** The memories kept for what still held in a replaced one: old id → new id. */
  rests: Array<{ old: number; id: number }>;
}

export function applyPlan(store: Store, c: CandidateInput & { saidAt: string }, plan: Plan): Applied {
  return store.rememberJudged({
    save: plan.save && {
      kind: plan.save.kind,
      content: plan.save.content,
      tags: c.tags,
      importance: c.importance,
      validFrom: c.saidAt,
      sourceLogId: c.sourceLogId,
      supersedes: plan.save.supersedes,
    },
    replaceWith: plan.replaceWith,
    rests: plan.rests,
  });
}

/** What the judge did, said for the model. */
export function appliedText(key: string, plan: Plan, a: Applied, about?: Map<number, string>, candidateAbout?: string): string {
  const what = a.saved
    ? plan.repeats.length
      ? `후보 ${key} → 더한 내용만 기억 #${a.saved} 저장(${plan.save!.kind}, ${ids(plan.repeats)}에 이미 있는 내용은 빼고)`
      : `후보 ${key} → 기억 #${a.saved} 저장(${plan.save!.kind})`
    : `후보 ${key} → 저장 안 함(${ids(plan.repeats)}에 이미 있음)`;
  const parts = [what];
  if (a.superseded.length) parts.push(`대체: ${ids(a.superseded)}${a.saved && !plan.replaceWith ? '' : ` → #${plan.replaceWith?.by ?? a.saved}`}`);
  if (a.rests.length) parts.push(`옛 기억의 나머지를 새 기억으로 남김: ${a.rests.map((r) => `#${r.old} → #${r.id}`).join(', ')}`);
  if (plan.keptNewer.length) parts.push(`${ids(plan.keptNewer)}은 이 후보보다 나중에 말해져 그대로 둠(후보는 그때 일(event)로 저장)`);
  if (plan.keptForOnce.length) parts.push(`${ids(plan.keptForOnce)}은 once(그 일 한 번) 후보라 대체하지 않고 그대로 둠`);
  if (plan.ignored.length) parts.push(`${ids(plan.ignored)}은 그 사이 이미 무효라 건드리지 않음`);
  // The names side by side, so a lookalike shows (C8).
  if (candidateAbout && about?.size) parts.push(`대상: 후보 "${candidateAbout}" / ${[...about].map(([id, a]) => `#${id} "${a}"`).join(', ')}`);
  return parts.join(' · ');
}

/** The close memories found for a candidate; `miss`: why the semantic-search server gave nothing (undefined when it answered or is turned off). */
export interface Nearby {
  memories: Memory[];
  miss?: string;
}
export type NearbySearch = (store: Store, c: Pick<CandidateInput, 'content' | 'tags'>) => Promise<Nearby>;

/**
 * The close live memories (summaries apart), closest first: the recall search the secretary's own recall uses.
 * `client(onMiss)` makes the semantic search for one call; it reports a miss (semantic-search/client.ts semanticClient).
 */
export function nearbySearch(client: (onMiss: (why: string) => void) => SemanticSearch | null): NearbySearch {
  return async (store, c) => {
    let miss: string | undefined;
    const query = c.tags?.length ? `${c.content}\n${c.tags.join(' ')}` : c.content;
    const r = await recall(store, query, { budgetTokens: 100_000, semantic: client((why) => (miss = why)) });
    return { memories: r.items.map((i) => i.memory).filter((m) => m.kind !== 'summary' && m.valid_to === null).slice(0, NEARBY_MAX), miss };
  };
}

/** Waiting for the semantic-search server: `ready()` asks whether it answers now (without a search), `sleep` waits. */
export interface SemanticWait {
  ms: number;
  pollMs: number;
  ready: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Told when the run stops for it (the semantic-search miss log). */
  onStop?: (reason: string) => void;
}

const noWait: SemanticWait = { ms: 0, pollMs: SEMANTIC_POLL_MS, ready: () => false, sleep: async () => {} };

export interface Withdrawn {
  key: string;
  reason: string;
}

/**
 * The candidates of one consolidation run (its memory server process): proposed, then judged once. A candidate never
 * judged holds mark_consolidated back (pending), so nothing the model proposed is lost without a word. When the
 * semantic-search server does not answer within the wait, the run stops (`halted`): no more candidates, and
 * mark_consolidated refuses, so the batch is judged again by a later run with the server up.
 */
export class CandidateBook {
  private next = 1;
  private open = new Map<string, Candidate>();
  private store: Store;
  private search: NearbySearch;
  private wait: SemanticWait;
  /** Why the run stopped; undefined while it goes on. */
  halted?: string;

  constructor(store: Store, search: NearbySearch, wait: SemanticWait = noWait) {
    this.store = store;
    this.search = search;
    this.wait = wait;
  }

  pending(): string[] {
    return [...this.open.keys()];
  }

  /** The close memories, waiting for the semantic-search server when it does not answer; stops the run when it never does. */
  private async nearby(c: Pick<CandidateInput, 'content' | 'tags'>): Promise<Memory[]> {
    let r = await this.search(this.store, c);
    if (!r.miss) return r.memories;
    const first = r.miss;
    for (let waited = 0; waited < this.wait.ms; waited += this.wait.pollMs) {
      await this.wait.sleep(this.wait.pollMs);
      if (!this.wait.ready()) continue;
      r = await this.search(this.store, c);
      if (!r.miss) return r.memories;
    }
    const min = Math.round(this.wait.ms / 60_000);
    this.halted = `의미 검색 서버가 ${min}분 기다려도 응답하지 않아 정리를 멈춤(처음 이유: ${first}, 마지막 이유: ${r.miss})`;
    this.wait.onStop?.(this.halted);
    throw new Error(this.haltText());
  }

  private haltText(): string {
    return `${this.halted}. 단어 검색만으로는 옛 상태 기억을 놓칠 수 있어 이번 정리는 여기서 멈춘다: 더는 후보를 내지 말고, mark_consolidated도 부르지 말고, 마지막 보고 첫 줄에 이 이유를 그대로 쓴다(이 배치는 다음 정리가 다시 읽는다).`;
  }

  async propose(input: CandidateInput): Promise<string> {
    if (this.halted) throw new Error(this.haltText());
    const [row] = this.store.logAround(input.sourceLogId, 0, 0);
    if (row?.id !== input.sourceLogId) throw new Error(`대화 #${input.sourceLogId}이 없음: source_log_id에는 배치의 [log #N] 번호를 넣는다.`);
    // A decision carries the user's own words, found in the row or the user rows before it; refused otherwise, to be
    // proposed again with the words copied (2026-11-13 the user's call).
    if (input.kind === 'decision') {
      const problem = quoteFormProblem(input.quote);
      if (problem) throw new Error(problem);
      if (!findQuote(this.store, input.sourceLogId, input.quote!)) throw new Error(QUOTE_MISSING(input.quote!, `대화 #${input.sourceLogId}와 그 앞`));
    }
    const maxId = this.store.maxMemoryId();
    const near = await this.nearby(input);
    const key = `C${this.next++}`;
    const saidAt = row.created_at;
    this.open.set(key, { ...input, key, saidAt, nearby: near.map((m) => m.id), shown: new Set(near.map((m) => m.id)), maxId });
    const head = `후보 ${key} (${input.kind}, 근거 #${input.sourceLogId}): ${input.content}`;
    if (!near.length) return `${head}\n가까운 기억 없음 → judge_memory(candidate "${key}", about, duration, verdicts [])로 저장한다.`;
    const lines = near.map((m) => `${formatMemory(m)}${ms(statedAt(this.store, m)) > ms(saidAt) ? ` ${LATER_MARK}` : ''}`);
    return [head, `가까운 기억 ${near.length}개: judge_memory의 verdicts에 하나도 빠짐없이 판정을 넣는다.`, ...lines].join('\n');
  }

  /** Refused (ok false) when a verdict is missing or wrong; the candidate stays open to be judged again. */
  async judge(key: string, input: JudgeInput & { withdrawReason?: string }): Promise<{ ok: boolean; text: string; applied?: Applied; withdrawn?: Withdrawn }> {
    if (this.halted) return { ok: false, text: this.haltText() };
    const c = this.open.get(key);
    if (!c) return { ok: false, text: `열린 후보 ${key}가 없음(이미 판정했거나 낸 적 없음). 열린 후보: ${this.pending().join(', ') || '없음'}` };
    if (input.withdrawReason) {
      this.open.delete(key);
      return { ok: true, text: `후보 ${key}를 저장하지 않고 버림: ${input.withdrawReason}`, withdrawn: { key, reason: input.withdrawReason } };
    }
    // A close memory saved since it was proposed (the secretary in a chat, or this run's own) is judged too.
    let now: Memory[];
    try {
      now = await this.nearby(c);
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
    const added = now.filter((m) => m.id > c.maxId && !c.nearby.includes(m.id)).map((m) => m.id);
    const required = [...c.nearby, ...added];
    const plan = planJudgement(c, input, required, new Set([...c.shown, ...added]), (id) => this.store.getMemory(id), (m) => statedAt(this.store, m));
    if ('error' in plan) {
      const unseen = added.filter((id) => !c.shown.has(id));
      for (const id of added) c.shown.add(id);
      const extra = unseen.length ? `\n후보를 낸 뒤 새로 생긴 가까운 기억:\n${unseen.map((id) => formatMemory(this.store.getMemory(id)!)).join('\n')}` : '';
      return { ok: false, text: `${plan.error}${extra}` };
    }
    const applied = applyPlan(this.store, c, plan);
    if (applied.saved && c.quote && plan.save?.kind === 'decision') saveQuote(this.store, applied.saved, c.quote, findQuote(this.store, c.sourceLogId, c.quote));
    this.open.delete(key);
    const about = new Map(input.verdicts.filter((v) => v.verdict !== 'unrelated' && v.about).map((v) => [v.id, v.about!]));
    return { ok: true, text: appliedText(key, plan, applied, about, input.about), applied };
  }
}
