/**
 * The memories auto-injected on every prompt (prompt hook notice 'memory'): recall on the question, helped by the
 * previous answer (memory/prev-answer-search.ts), under the auto-recall budget; memories cut for budget are listed
 * by id so the model can expand the ones it needs.
 */
import fs from 'node:fs';
import { BUDGET } from '../core/config.ts';
import { estimateTokens } from '../core/tokens.ts';
import { compress, lastAnswer, prevAnswerSearch } from '../memory/prev-answer-search.ts';
import { recall } from '../memory/recall.ts';
import { embedderNotice } from '../semantic/client.ts';
import type { Store } from '../store/store.ts';

/** Auto-injection is stricter than an explicit recall: a wrong memory costs tokens every turn. */
const AUTO_MIN_SCORE = 0.3;

/** Memories cut for budget are listed as id + tags + opening words, so the model can pick which to expand. */
const DROPPED_LIST_MAX = 10;
const DROPPED_LABEL_CHARS = 24;

export function droppedLabel(m: { id: number; content: string; tags: string }): string {
  // Most memories open with a date and a subject ("2026-10-21에 사용자는"); skip both so the label shows the point.
  const body = m.content
    .replace(/^(?:\d{4}-\d{2}-\d{2}(?:\s*\d{2}:\d{2})?(?:\s*기준)?(?:에는|에|부터)?[,\s]*)/, '')
    .replace(/^사용자(?:님)?(?:은|는|이|가)\s*/, '');
  const chars = Array.from(body);
  const tags = m.tags ? `[${m.tags}] ` : '';
  return `#${m.id} ${tags}${chars.slice(0, DROPPED_LABEL_CHARS).join('')}${chars.length > DROPPED_LABEL_CHARS ? '…' : ''}`;
}

/** The previous answer, compressed for search; '' at a session's first prompt or if the transcript can't be read. */
function prevAnswerContext(transcriptPath: string | undefined, prompt: string): string {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try {
    const answer = lastAnswer(transcriptPath, prompt);
    return answer ? compress(answer) : '';
  } catch {
    // An odd transcript must not cost the injection: the question alone then.
    return '';
  }
}

export async function promptContext(store: Store, prompt: string, sessionId?: string, transcriptPath?: string): Promise<string> {
  const result = await recall(store, prompt, {
    budgetTokens: BUDGET.autoRecall,
    minScore: AUTO_MIN_SCORE,
    summariesFirst: true,
    excludeIds: sessionId ? store.injectedIds(sessionId) : undefined,
    semantic: prevAnswerSearch(prevAnswerContext(transcriptPath, prompt)),
  });
  // Told once per session per outage, ahead of the memories so the reply can open with it.
  const notice = sessionId ? embedderNotice(sessionId) : '';
  if (result.items.length === 0) return notice;
  const more = result.droppedForBudget > 0 ? ` 예산 초과로 ${result.droppedForBudget}개 생략됨(아래 목록, 필요한 것만 recall의 ids로 펼침).` : '';
  const listed = result.dropped.slice(0, DROPPED_LIST_MAX).map((s) => s.memory);
  const droppedLine = listed.length ? `생략: ${listed.map(droppedLabel).join(' · ')}` : '';
  const text = [
    `<secretary-memory>`,
    `이 질문과 관련 있을 수 있는 기억이에요(자동 검색).${more}`,
    result.text,
    ...(droppedLine ? [droppedLine] : []),
    `</secretary-memory>`,
  ].join('\n');
  // Dropped ids and the list's cost let the trial judge whether the list earns its tokens (compare with recall ids later).
  store.logUsage('auto_recall', estimateTokens(text), {
    session: sessionId,
    ids: result.items.map((i) => i.memory.id),
    ...(listed.length ? { droppedIds: listed.map((m) => m.id), droppedTokens: estimateTokens(droppedLine) } : {}),
  });
  return notice ? `${notice}\n${text}` : text;
}
