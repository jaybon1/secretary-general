/**
 * How big this session's context has grown, for the prompt hook: once it passes NUDGE_START tokens,
 * and again every NUDGE_STEP after, the secretary suggests /compact to go on with the same talk or /clear for another
 * (the conversation stays in the DB either way); only /compact when the answer leaves things to do.
 */
import type { Store } from '../store/store.ts';
import { TAG } from '../core/names.ts';

export const NUDGE_START = 150_000;
export const NUDGE_STEP = 50_000;
export const NUDGED_PREFIX = 'context_nudged:';
// The size itself is read by core/transcript.ts lastContextTokens (the prompt hook, and work-session scripts through
// `cli worker-transcript context` with a bigger tail: a worker's transcript can end in lines of several MB).

/** After a compaction the context is small again: the session's nudge step is forgotten, so the nudges start over at NUDGE_START (session-start.ts). */
export function forgetContextNudge(store: Store, sessionId: string): void {
  store.deleteMeta(NUDGED_PREFIX + sessionId);
}

/** The nudge line when the context crossed a new step since the last nudge in this session, else ''. */
export function contextNudge(store: Store, sessionId: string, tokens: number): string {
  if (tokens < NUDGE_START) return '';
  const step = Math.floor((tokens - NUDGE_START) / NUDGE_STEP);
  if (!store.markOnce(NUDGED_PREFIX + sessionId, String(step), (last) => Number(last) >= step)) return '';
  const man = Math.round(tokens / 10_000);
  // With things still to do the talk goes on, so only /compact is offered (the user's call, 2026-11-14).
  // The commands are the user's choice, offered and not asked for: a heading line and one line per command (the user's wording, 2026-11-14).
  const head = `대화가 약 ${man}만 토큰 쌓였어요. 필요한 경우 아래 명령어를 사용하세요.`;
  const compact = '/compact(같은 이야기를 이어 갈 때: 앞 대화를 요약해 남겨요)';
  const clear = '/clear(다른 이야기로 넘어갈 때: 앞 대화를 비워요)';
  return [
    `<${TAG.contextSize}>이 세션 컨텍스트가 약 ${man}만 토큰이다. 답 끝("다음 행동" 위)에 아래 글을 앞뒤 빈 줄로 띄운 따로 된 문단으로, 줄마다 따로(그냥 줄바꿈) 그대로 붙인다.`,
    `"다음 행동 및 순서"가 "없음"이면:`,
    head,
    compact,
    clear,
    '할 일이 있으면:',
    head,
    compact,
    `</${TAG.contextSize}>`,
  ].join('\n');
}
