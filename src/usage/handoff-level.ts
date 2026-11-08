/**
 * Subscription usage for the prompt hook (notice 'usage', feature account-handoff): one line telling the
 * secretary how much to hand off to account b. Usage files (usage/files.ts, one per provider and its login account) are
 * written by the status line and scripts/usage/usage-query.ps1; account a = 'subscription'.
 */
import { chatProvider, readUsage, type UsageState } from './files.ts';

/** Account a's 5-hour % at which each handoff level starts (level 1 below the first). */
export const LEVEL_STARTS = [20, 40, 60];

export function handoffLevel(pct: number): number {
  return 1 + LEVEL_STARTS.filter((start) => pct >= start).length;
}

/** While account b has used less than twice account a's %, hand off even small jobs; otherwise go by a's level. */
export function handoffNote(aPct: number, bPct: number): string {
  return bPct < 2 * aPct ? 'b 우선(작은 일도 넘김)' : `넘기기 ${handoffLevel(aPct)}단계`;
}

function currentPct(s: UsageState | null, now: number): number {
  if (!s || (s.resets_at && now >= Date.parse(s.resets_at))) return 0;
  return s.five_hour_pct;
}

function describe(name: string, s: UsageState | null, now: number): string {
  if (!s) return `${name} 기록 없음`;
  if (s.resets_at && now >= Date.parse(s.resets_at)) return `${name} 초기화됨`;
  const age = Math.round((now - Date.parse(s.updated_at)) / 60000);
  return `${name} ${Math.round(s.five_hour_pct)}%${age > 10 ? `(${age}분 전 기록)` : ''}`;
}

export function usageContext(now = Date.now(), provider = chatProvider()): string {
  const a = readUsage('subscription');
  const b = readUsage('subscription-b');
  // Chatting on b (a ran out): no cheaper account to hand off to, so work sessions and run-job stay on b and b's % sets the level.
  if (provider === 'subscription-b') {
    if (!b) return '';
    return `<secretary-usage>이 세션은 계정 b. 5시간 사용량: ${describe('계정 b', b, now)} · ${describe('계정 a', a, now)} → 넘기기 ${handoffLevel(currentPct(b, now))}단계(b 기준, 넘기는 일도 b)</secretary-usage>`;
  }
  if (!a) return '';
  const note = handoffNote(currentPct(a, now), currentPct(b, now));
  return `<secretary-usage>5시간 사용량: ${describe('계정 a', a, now)} · ${describe('계정 b', b, now)} → ${note}</secretary-usage>`;
}
