/**
 * How big this session's context has grown, for the prompt hook: once it passes NUDGE_START tokens,
 * and again every NUDGE_STEP after, the secretary suggests /compact to go on with the same talk or /clear for another
 * (the conversation stays in the DB either way).
 */
import fs from 'node:fs';
import type { Store } from '../store/store.ts';
import { TAG } from '../core/names.ts';

export const NUDGE_START = 150_000;
export const NUDGE_STEP = 50_000;
const TAIL_BYTES = 512 * 1024;
export const NUDGED_PREFIX = 'context_nudged:';

/** The transcript's last `tailBytes` as lines; the first one is usually cut mid-way. */
export function tailLines(transcriptPath: string, tailBytes = TAIL_BYTES): string[] {
  const size = fs.statSync(transcriptPath).size;
  const start = Math.max(0, size - tailBytes);
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(size - start);
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8').split('\n');
}

/**
 * Tokens the last model call read (input + cache read + cache write), from the transcript's tail; 0 if none.
 * Work-session scripts ask the same through `cli context-tokens` (worker-lib.ps1 Get-SessionContext) with a
 * bigger tail: a worker's transcript can end in lines of several MB.
 * The search stops at a compaction boundary (0): right after /compact the last call is still the pre-compact
 * one, whose size is no longer the context (a "31만 토큰" nudge once came right after /compact).
 */
export function lastContextTokens(transcriptPath: string, tailBytes = TAIL_BYTES): number {
  const lines = tailLines(transcriptPath, tailBytes);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"compact_boundary"')) return 0;
    if (!lines[i].includes('"usage"')) continue;
    try {
      const u = JSON.parse(lines[i]).message?.usage;
      if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    } catch {
      // The first line of the tail is usually cut mid-way.
    }
  }
  return 0;
}

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
  return `<${TAG.contextSize}>이 세션 컨텍스트가 약 ${man}만 토큰이다. 답 끝("다음 행동" 위)에 "대화가 약 ${man}만 토큰 쌓였어요. 같은 이야기를 이어 가려면 /compact(앞 대화를 요약해 남겨요), 다른 이야기로 넘어가려면 /clear(앞 대화를 비워요)를 해 주세요. 대화 기록은 DB에 남아요." 한 줄을 붙인다.</${TAG.contextSize}>`;
}
