/**
 * What one memory consolidation run wrote, counted by the program, not by the model (decided 2026-11-12: a Haiku
 * report said 33 new memories where the DB got 37, and the secretary passes the report on to the user).
 *
 * Only the consolidation's own memory server counts: run-job -Staff starts it with `--staff memory-consolidation`
 * (scripts/lib/memory-mcp.ps1), and its write tools add here (mcp/server.ts). The secretary's own server, writing at
 * the same time in a chat, is started without it, so its memories stay out. The launcher empties the tally before a
 * run and puts its line under the report (memory/consolidate-run.ts); only one consolidation runs at a time.
 */
import { transaction } from '../store/schema.ts';
import type { Store } from '../store/store.ts';

const TALLY_KEY = 'consolidate_tally';

export interface ConsolidateTally {
  /** New memories (topic summaries apart). */
  memories: number[];
  summaries: number[];
  /** Old memories a new one replaced (supersedes). */
  superseded: number[];
  /** Memories marked untrue (forget). */
  forgotten: number[];
  /** Main agenda lines changed, by name. */
  agenda: string[];
  /** Profile versions saved. */
  profile: number[];
  /** New memories that keep what still held in a replaced one (also in `memories`). */
  rests: number[];
  /** Candidates dropped without a verdict (judge_memory withdraw_reason), "C3: 이유" (fix C10 of the 2026-11-13 source review). */
  withdrawn: string[];
  /** judge_memory answers refused (a verdict missing, twice, outside the list): the cost of the fixed verdicts. */
  refused: number;
  /** Why the run stopped before its end (the semantic-search server did not answer, C9). */
  halted: string[];
}

const empty = (): ConsolidateTally => ({ memories: [], summaries: [], superseded: [], forgotten: [], agenda: [], profile: [], rests: [], withdrawn: [], refused: 0, halted: [] });

/** Before a run: nothing counted yet. */
export function startTally(store: Store): void {
  store.setJson(TALLY_KEY, empty());
}

export function readTally(store: Store): ConsolidateTally {
  return { ...empty(), ...store.getJson<Partial<ConsolidateTally>>(TALLY_KEY) };
}

/** A write the consolidation's server made (read and saved in one transaction). */
export function addToTally(store: Store, part: Partial<ConsolidateTally>): void {
  transaction(store.db, () => {
    const t = readTally(store);
    for (const k of Object.keys(part) as Array<keyof ConsolidateTally>) {
      const v = part[k];
      if (typeof v === 'number') (t[k] as number) += v;
      else (t[k] as unknown[]).push(...((v as unknown[]) ?? []));
    }
    store.setJson(TALLY_KEY, t);
  });
}

/**
 * The lines under the report: the counts, then the new memories' ids when there are any, so the secretary can find a
 * memory the model left out of its list (the 2026-11-12 model comparison: a report said 33 where 37 were saved).
 */
export function tallyLine(t: ConsolidateTally): string {
  const agenda = new Set(t.agenda).size;
  const rests = t.rests.length ? `(그중 대체된 기억의 바뀌지 않은 나머지 ${t.rests.length}개)` : '';
  const counts =
    `[프로그램이 센 이번 정리 결과] 새 기억 ${t.memories.length}개${rests} · 대체 ${new Set(t.superseded).size}개 · 무효 ${new Set(t.forgotten).size}개 · ` +
    `판정 없이 버린 후보 ${t.withdrawn.length}개 · 주제 요약 ${t.summaries.length}개 · 주요 현안 고친 줄 ${agenda}개 · ` +
    `프로필 ${t.profile.length ? `갱신함(v${t.profile.at(-1)})` : '갱신 안 함'}`;
  const lines = [counts];
  if (t.memories.length) lines.push(`새 기억 번호: ${t.memories.map((id) => `#${id}`).join(', ')}`);
  // Why each candidate went without a verdict (C10), and why the run stopped early (C9).
  if (t.withdrawn.length) lines.push(`버린 후보: ${t.withdrawn.join(' / ')}`);
  for (const h of new Set(t.halted)) lines.push(`정리 멈춤: ${h}`);
  return lines.join('\n');
}
