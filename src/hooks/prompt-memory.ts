/**
 * The memories auto-injected on every prompt (prompt hook notice 'memory'): recall on the question, helped by the
 * previous answer (memory/prev-answer-search.ts), under the auto-recall budget; memories cut for budget are listed
 * by id so the model can expand the ones it needs.
 */
import fs from 'node:fs';
import { BUDGET } from '../core/config.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { compress, lastAnswer, prevAnswerSearch, promptClients } from '../memory/prev-answer-search.ts';
import { recall } from '../memory/recall.ts';
import { missNotice, outageNotice, readDown, type SemanticSearch } from '../semantic-search/client.ts';
import { wordOnly } from '../semantic-search/word-only.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';
import type { Store } from '../store/store.ts';
import { USER_WORD, userWords, wordsGroup } from '../store/user-title.ts';
import { TAG } from '../core/names.ts';

/** Auto-injection is stricter than an explicit recall: a wrong memory costs tokens every turn. */
const AUTO_MIN_SCORE = 0.3;

/** Memories cut for budget are listed as id + tags + opening words, so the model can pick which to expand. */
const DROPPED_LIST_MAX = 10;
const DROPPED_LABEL_CHARS = 24;

/**
 * A memory cut for budget as id + tags + opening words. Most memories open with a date and a subject ("2026-10-21에
 * 사용자는", or the title the user is called by, which older memories use: `userWords`, store/user-title.ts); both are
 * skipped so the label shows the point.
 */
export function droppedLabel(m: { id: number; content: string; tags: string }, userWords: readonly string[] = [USER_WORD]): string {
  const body = m.content
    .replace(/^(?:\d{4}-\d{2}-\d{2}(?:\s*\d{2}:\d{2})?(?:\s*기준)?(?:에는|에|부터)?[,\s]*)/, '')
    .replace(new RegExp(String.raw`^${wordsGroup(userWords)}(?:님)?(?:은|는|이|가)\s*`), '');
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

/**
 * The question's semantic search got nothing even after the wait (stopped, out of memory, never up, too slow): the
 * prompt is not blocked (no model would answer), but the secretary is told to ask first, before answering, whether to
 * start the server again or go on with word search in this conversation (.agents/hook-notices/semantic-search-misses.md
 * `ask`, 2026-11-13 the user's call).
 */
export function semanticFailedNotice(why: string): string {
  const text = hookNoticeText('semantic-search-misses', 'ask').replaceAll('{reason}', why);
  return text ? `<${TAG.semanticSearchServer}>${text}</${TAG.semanticSearchServer}>` : '';
}

export async function promptContext(
  store: Store,
  prompt: string,
  sessionId?: string,
  transcriptPath?: string,
  clients?: (onQuestionMiss: (why: string) => void) => [SemanticSearch, SemanticSearch],
): Promise<string> {
  // "단어 검색으로 답해" after such a question: this conversation goes on without the server (semantic-search/word-only.ts).
  const wordSearchOnly = wordOnly(store, sessionId, prompt);
  let failed = '';
  const onQuestionMiss = (why: string) => (failed ||= why);
  const result = await recall(store, prompt, {
    budgetTokens: BUDGET.autoRecall,
    minScore: AUTO_MIN_SCORE,
    summariesFirst: true,
    excludeIds: sessionId ? store.injectedIds(sessionId) : undefined,
    semantic: wordSearchOnly ? null : prevAnswerSearch(prevAnswerContext(transcriptPath, prompt), (clients ?? promptClients)(onQuestionMiss)),
  });
  // A search that failed this time comes first: the secretary asks before answering. Otherwise, told once per session per
  // outage, ahead of the memories so the reply can open with it; searches the server has not answered for a while are
  // told the same way, with where they are recorded (semantic-search/misses.ts).
  const notice = [
    failed ? semanticFailedNotice(failed) : '',
    sessionId && !wordSearchOnly ? outageNotice(sessionId) || (failed ? '' : missNotice(sessionId, !!readDown())) : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (result.items.length === 0) return notice;
  const more = result.droppedForBudget > 0 ? ` 예산 초과로 ${result.droppedForBudget}개 생략됨(아래 목록, 필요한 것만 recall의 ids로 조회).` : '';
  const listed = result.dropped.slice(0, DROPPED_LIST_MAX).map((s) => s.memory);
  const words = userWords(store.db);
  const droppedLine = listed.length ? `생략: ${listed.map((m) => droppedLabel(m, words)).join(' · ')}` : '';
  const text = [
    `<${TAG.memory}>`,
    `이 질문과 관련 있을 수 있는 기억이에요(자동 검색).${more}`,
    result.text,
    ...(droppedLine ? [droppedLine] : []),
    `</${TAG.memory}>`,
  ].join('\n');
  // Dropped ids and the list's cost let the trial judge whether the list earns its tokens (compare with recall ids later).
  store.logUsage('auto_recall', estimateTokens(text), {
    session: sessionId,
    ids: result.items.map((i) => i.memory.id),
    ...(listed.length ? { droppedIds: listed.map((m) => m.id), droppedTokens: estimateTokens(droppedLine) } : {}),
  });
  return notice ? `${notice}\n${text}` : text;
}
