/**
 * Duplicate check for remember. The chat secretary, the background consolidation and work
 * sessions may all save the same fact; a unique key cannot catch two wordings of it, so the new
 * memory is compared by meaning with recent active memories before it is written.
 *
 * Measured 2026-11-05 on pairs saved within a day of each other: real duplicates scored down to
 * 0.85, while distinct memories scored up to 0.885, so no score separates them cleanly. A hit
 * therefore only stops the first attempt and shows the similar memories; the writer then skips,
 * supersedes, or saves anyway with allow_similar.
 *
 * Race: the check and the insert are separate steps (the meaning search runs in the server
 * process). The caller passes the highest memory id it checked against as expectMaxId; the
 * insert transaction refuses if a newer memory exists, and the caller checks again.
 */
import type { SemanticSearch } from '../semantic-search/client.ts';
import { normalizeTags, type Memory, type Store } from '../store/store.ts';

export const DUP_MIN_SIM = 0.85;
/** Background consolidation reads conversation up to a day or two old; three days covers its lag. */
export const DUP_WINDOW_MS = 3 * 24 * 3600 * 1000;
const SEARCH_LIMIT = 10;

export interface DuplicateCheck {
  /** Highest memory id when the check started: the expectMaxId for the insert. */
  maxId: number;
  similar: Array<{ memory: Memory; sim: number }>;
  /** The semantic-search server did not answer; nothing was compared. */
  skipped: boolean;
}

export async function checkDuplicates(
  store: Store,
  search: SemanticSearch,
  input: { content: string; tags?: string[]; supersedes?: number[] },
  now = Date.now(),
): Promise<DuplicateCheck> {
  // Read before the search: the server backfills vectors for everything saved up to that moment.
  const maxId = store.maxMemoryId();
  const tags = normalizeTags(input.tags);
  // Same text the server embeds memories with (content, then tags on the next line).
  const hits = await search(tags ? `${input.content.trim()}\n${tags}` : input.content.trim(), { limit: SEARCH_LIMIT });
  if (!hits) return { maxId, similar: [], skipped: true };
  const replaced = new Set(input.supersedes ?? []);
  const sims = new Map(hits.hits.filter((h) => h.sim >= DUP_MIN_SIM && !replaced.has(h.id)).map((h) => [h.id, h.sim]));
  const since = new Date(now - DUP_WINDOW_MS).toISOString();
  const similar = store
    .recentMemories([...sims.keys()], since)
    .map((memory) => ({ memory, sim: sims.get(memory.id)! }))
    .sort((a, b) => b.sim - a.sim);
  return { maxId, similar, skipped: false };
}

export function duplicateMessage(similar: DuplicateCheck['similar'], formatDate: (iso: string) => string): string {
  return [
    `비슷한 기억이 최근 ${DUP_WINDOW_MS / 86_400_000}일 안에 있어 저장하지 않았어요(뜻 점수 ${DUP_MIN_SIM} 이상):`,
    ...similar.map(({ memory: m, sim }) => `#${m.id} ${m.kind} ${formatDate(m.created_at)} (점수 ${sim.toFixed(3)}): ${m.content}`),
    '같은 내용이면 그대로 두세요(이미 저장돼 있어요). 내용이 바뀌었으면 supersedes에 그 번호를 넣어 다시 저장하고, 정말 다른 사실이면 allow_similar: true로 다시 저장하세요.',
  ].join('\n');
}
