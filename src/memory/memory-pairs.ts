/**
 * 기억 정리 때 가까운 기억 짝 다시 판정(2026-11-18 사용자 결정): 같은 주제이면서 뜻이 가까운 살아 있는 기억 짝을 정리 담당이 한 번에
 * PAIRS_PER_RUN쌍까지 판정하고, 코드가 옛 쪽을 새 쪽으로 대체하거나 그대로 둔다. 판정한 짝은 memory_pair_checks에 남아 다시 묻지 않는다.
 * 정리 담당 서버에서만 쓴다(mcp/memory-tools.ts get_memory_pairs · judge_memory_pair).
 *
 * Old states stayed live by three paths: the consolidation judged a candidate only against its NEARBY_MAX closest memories
 * (memory/consolidate-verdicts.ts), a memory saved during a chat is checked only against the last three days
 * (memory/duplicate-check.ts), and ranking hardly weighs age (memory/recall.ts). Judging the close pairs already in the DB
 * covers all three in one place. "Older" is the one that held first (valid_from: when it was said, as the consolidation saves it).
 */
import { createHash } from 'node:crypto';
import { VECTOR_KEY } from '../semantic-search/config.ts';
import { formatMemory } from './recall.ts';
import type { Memory, Store } from '../store/store.ts';

/** Memories whose tag boundaries one consolidation run sets at most (get_tag_checks; the ones migration 21 split by spaces). */
export const TAG_CHECKS_PER_RUN = 20;
/** Pairs one consolidation run judges at most. */
export const PAIRS_PER_RUN = 10;
/** How close in meaning (vector dot of the content+tags embedding) two memories of a topic must be to be judged as a pair. */
export const PAIR_MIN_SIM = 0.8;
export const PAIR_VERDICTS = ['unrelated', 'repeats', 'changes'] as const;
export type PairVerdict = (typeof PAIR_VERDICTS)[number];

export interface ClosePair {
  older: Memory;
  newer: Memory;
  sim: number;
}

/** Where the pairs found so far are kept between runs (meta), with what each memory was when it was compared. */
export const PAIR_SCAN_KEY = 'memory_pairs_scan';

interface PairScan {
  model: string;
  /** Each live memory compared: "<topic tag>|<vector hash>"; one that differs now (or is new) is compared again. */
  seen: Record<string, string>;
  /** Pairs at PAIR_MIN_SIM or closer among the memories in `seen`: [smaller id, larger id, similarity]. */
  pairs: Array<[number, number, number]>;
}

const vectorHash = (v: Float32Array): string => createHash('sha1').update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)).digest('base64').slice(0, 16);

const dot = (x: Float32Array, y: Float32Array): number => {
  let sim = 0;
  for (let k = 0; k < x.length; k++) sim += x[k] * y[k];
  return sim;
};

/**
 * Every pair of live memories (topic summaries apart) that share a topic tag and lie at PAIR_MIN_SIM or closer, as the
 * last scan left them brought up to date: only a memory that is new or whose topic tag or meaning vector changed since
 * is compared again (with every memory of its topic), and pairs of memories gone (invalidated, replaced) are dropped. The
 * set is the one comparing all pairs again would give; comparing them all each run grew with the square of the memories
 * (about 80 more a day). A different model, or no scan yet, compares everything once.
 */
export function scanPairs(store: Store, model = VECTOR_KEY): Array<[number, number, number]> {
  const info = new Map(store.liveTopicTags().map((r) => [r.id, r]));
  const now = new Map<number, { topic: string; vector: Float32Array; mark: string }>();
  for (const v of store.vectors(model)) {
    const topic = info.get(v.id)?.topic;
    if (topic) now.set(v.id, { topic, vector: v.vector, mark: `${topic}|${vectorHash(v.vector)}` });
  }
  const last = store.getJson<PairScan>(PAIR_SCAN_KEY);
  const before = last?.model === model ? last : { model, seen: {}, pairs: [] };
  const changed = new Set([...now].filter(([id, m]) => before.seen[id] !== m.mark).map(([id]) => id));
  const pairs = before.pairs.filter(([a, b]) => now.has(a) && now.has(b) && !changed.has(a) && !changed.has(b));
  const byTopic = new Map<string, number[]>();
  for (const [id, m] of now) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), id]);
  for (const ids of byTopic.values()) {
    for (const x of ids) {
      if (!changed.has(x)) continue;
      for (const y of ids) {
        // A pair of two changed memories is compared once (from its smaller id).
        if (y === x || (changed.has(y) && y < x)) continue;
        const sim = dot(now.get(x)!.vector, now.get(y)!.vector);
        if (sim >= PAIR_MIN_SIM) pairs.push(x < y ? [x, y, sim] : [y, x, sim]);
      }
    }
  }
  store.setJson(PAIR_SCAN_KEY, { model, seen: Object.fromEntries([...now].map(([id, m]) => [id, m.mark])), pairs } satisfies PairScan);
  return pairs;
}

/** The closest not yet judged pairs of live memories (topic summaries apart) sharing a topic tag, closest first. */
export function closePairs(store: Store, limit = PAIRS_PER_RUN, model = VECTOR_KEY): ClosePair[] {
  const checked = store.checkedPairs();
  // Closest first; an equal score by ids, so the order never hangs on the order pairs were found in.
  const found = scanPairs(store, model).sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
  const out: ClosePair[] = [];
  for (const [ia, ib, sim] of found) {
    if (out.length >= limit) break;
    const [a, b] = [store.getMemory(ia)!, store.getMemory(ib)!];
    const [older, newer] = a.valid_from < b.valid_from || (a.valid_from === b.valid_from && a.id < b.id) ? [a, b] : [b, a];
    if (checked.has(`${older.id}:${newer.id}`)) continue;
    out.push({ older, newer, sim });
  }
  return out;
}

export interface PairJudgement {
  verdict: PairVerdict;
  /** Who or what each memory's text is about, copied from it (a lookalike name shows, as in judge_memory). */
  olderAbout: string;
  newerAbout: string;
  /** repeats/changes: what in the older memory still holds after the newer one. */
  rest?: string;
}

/** The pairs one consolidation server handed out (P1, P2…): only those are judged. */
export class PairBook {
  private next = 1;
  private handed = new Map<string, { older: number; newer: number }>();

  /** The next pairs, as the tool shows them: PAIRS_PER_RUN in all for one server (one consolidation run). */
  hand(store: Store): string {
    const left = PAIRS_PER_RUN - (this.next - 1);
    if (left <= 0) return `이번 정리 몫(${PAIRS_PER_RUN}쌍)을 다 받았음. 남은 짝은 다음 정리가 판정한다.`;
    const open = [...this.handed.values()];
    const pairs = closePairs(store, left + open.length).filter((p) => !open.some((h) => h.older === p.older.id && h.newer === p.newer.id)).slice(0, left);
    if (!pairs.length) return '다시 판정할 가까운 기억 짝 없음';
    const lines = [`가까운 기억 짝 ${pairs.length}개(같은 주제, 뜻 점수 ${PAIR_MIN_SIM} 이상, 먼저 말한 쪽이 옛): 짝마다 judge_memory_pair로 판정한다.`];
    for (const p of pairs) {
      const key = `P${this.next++}`;
      this.handed.set(key, { older: p.older.id, newer: p.newer.id });
      lines.push(`짝 ${key} (점수 ${p.sim.toFixed(3)})`, `  옛: ${formatMemory(p.older, store)}`, `  새: ${formatMemory(p.newer, store)}`);
    }
    return lines.join('\n');
  }

  /** The verdict carried out: unrelated keeps both, repeats/changes replace the older one with the newer (its rest kept). */
  judge(store: Store, key: string, j: PairJudgement): { ok: boolean; text: string; superseded?: number[]; rests?: number[] } {
    const h = this.handed.get(key);
    if (!h) return { ok: false, text: `받은 짝 ${key}가 없음(get_memory_pairs가 준 짝 번호로 판정한다). 받은 짝: ${[...this.handed.keys()].join(', ') || '없음'}` };
    const [older, newer] = [store.getMemory(h.older), store.getMemory(h.newer)];
    if (!older || !newer) return { ok: false, text: `짝 ${key}의 기억이 없음` };
    if (j.verdict !== 'unrelated' && older.kind === 'event') {
      return { ok: false, text: `#${older.id}은 지난 사건(event)이라 그 뒤 상태가 바뀌어도 그때 일로 참이다. unrelated로 판정한다.` };
    }
    const rest = j.rest?.trim();
    if (rest && rest === older.content.trim()) return { ok: false, text: `#${older.id}의 rest가 옛 기억 글 그대로다. 바뀐 면이 없으면 unrelated, 있으면 rest에는 바뀌지 않은 나머지만 쓴다.` };
    this.handed.delete(key);
    if (j.verdict === 'unrelated' || older.valid_to || newer.valid_to) {
      store.recordPairCheck(older.id, newer.id, 'unrelated');
      const gone = older.valid_to || newer.valid_to ? ' (그 사이 한쪽이 이미 무효라 건드리지 않음)' : '';
      return { ok: true, text: `짝 ${key}: 둘 다 그대로 둠${gone}` };
    }
    const r = store.rememberJudged({ replaceWith: { by: newer.id, ids: [older.id] }, rests: rest ? [{ id: older.id, content: rest }] : [] });
    store.recordPairCheck(older.id, newer.id, j.verdict);
    const rests = r.rests.map((x) => x.id);
    return {
      ok: true,
      text: `짝 ${key}: #${older.id} → #${newer.id}로 대체(${j.verdict})${rests.length ? ` · 옛 기억의 나머지를 새 기억 #${rests.join(', #')}로 남김` : ''} · 대상: 옛 "${j.olderAbout}" / 새 "${j.newerAbout}"`,
      superseded: r.superseded,
      rests,
    };
  }
}
