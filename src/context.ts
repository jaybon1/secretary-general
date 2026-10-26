/** Builds the text the hooks inject into Claude Code's context. */
import { startBoardUpdate } from './board.ts';
import { BUDGET } from './config.ts';
import { continuityContext } from './continuity.ts';
import { recall } from './recall.ts';
import { embedderNotice } from './semantic.ts';
import type { Store } from './store.ts';
import { estimateTokens, formatLocal } from './text.ts';

/** Above this many unconsolidated log entries, the secretary is nudged to suggest /consolidate. */
const CONSOLIDATE_NUDGE = 40;

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

/** SessionStart sources after which earlier injections are no longer in context. */
const CONTEXT_RESETS = new Set(['clear', 'compact']);

export function sessionStartContext(store: Store, sessionId?: string, source?: string): string {
  if (sessionId && source && CONTEXT_RESETS.has(source)) store.logUsage('context_reset', 0, { session: sessionId, source });
  const profile = store.getProfile();
  const s = store.stats();
  const parts = [
    '<secretary-profile>',
    profile
      ? `핵심 프로필 v${profile.version} (${formatLocal(profile.created_at, true)} 갱신)\n${profile.content}`
      : '핵심 프로필이 아직 없습니다. 첫 대화라면 사용자 이름·부를 호칭·핵심 선호를 짧게 묻고 update_profile 도구로 만들어 주세요.',
    '</secretary-profile>',
    `<secretary-status>활성 기억 ${s.memoriesActive}개 · 정리 대기 대화 ${s.unconsolidated}건${
      s.unconsolidated >= CONSOLIDATE_NUDGE ? ' — 적당한 때에 /consolidate 실행을 제안하세요' : ''
    }</secretary-status>`,
  ];
  // A brand-new conversation (not a resume or compaction) wakes up with the situation board, which the
  // first prompt injects once the background rewrite is done; without a session id, the plain pointers.
  if (!source || source === 'startup' || source === 'clear') {
    if (sessionId) startBoardUpdate(store, sessionId);
    else {
      const continuity = continuityContext(store);
      if (continuity) parts.push(continuity);
    }
  }
  const text = parts.join('\n');
  store.logUsage('session_start', estimateTokens(text), { profileVersion: profile?.version ?? 0 });
  return text;
}

export async function promptContext(store: Store, prompt: string, sessionId?: string): Promise<string> {
  const result = await recall(store, prompt, {
    budgetTokens: BUDGET.autoRecall,
    minScore: AUTO_MIN_SCORE,
    summariesFirst: true,
    excludeIds: sessionId ? store.injectedIds(sessionId) : undefined,
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
