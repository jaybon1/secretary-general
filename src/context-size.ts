/**
 * How big this session's context has grown, for the prompt hook: once it passes NUDGE_START tokens,
 * and again every NUDGE_STEP after, the secretary suggests /clear (the conversation stays in the DB).
 */
import fs from 'node:fs';
import type { Store } from './store.ts';

export const NUDGE_START = 150_000;
export const NUDGE_STEP = 50_000;
const TAIL_BYTES = 512 * 1024;
const NUDGED_PREFIX = 'context_nudged:';

/** The transcript's last TAIL_BYTES as lines; the first one is usually cut mid-way. */
export function tailLines(transcriptPath: string): string[] {
  const size = fs.statSync(transcriptPath).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(size - start);
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8').split('\n');
}

/** Tokens the last model call read (input + cache read + cache write), from the transcript's tail; 0 if none. */
export function lastContextTokens(transcriptPath: string): number {
  const lines = tailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
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

/** The nudge line when the context crossed a new step since the last nudge in this session, else ''. */
export function contextNudge(store: Store, sessionId: string, tokens: number): string {
  if (tokens < NUDGE_START) return '';
  const step = Math.floor((tokens - NUDGE_START) / NUDGE_STEP);
  const key = NUDGED_PREFIX + sessionId;
  const last = store.getMeta(key);
  if (last !== undefined && Number(last) >= step) return '';
  store.setMeta(key, String(step));
  const man = Math.round(tokens / 10_000);
  return `<secretary-context>이 세션 맥락이 약 ${man}만 토큰이다. 답 끝("다음 행동" 위)에 "대화가 약 ${man}만 토큰 쌓였어요. 주제가 바뀌면 /clear 하세요(대화는 DB에 남아요)." 한 줄을 붙인다.</secretary-context>`;
}
