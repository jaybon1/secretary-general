/**
 * Tasks waiting for the user's own look at the result (status 'review', the plan's "검수 대기: 예"): after a few days they
 * are asked about again, on a new session's board (session-continuity/situation-board-notice.ts) and at memory consolidation ("기억 정리 확인",
 * memory/consolidate-notice.ts; the /consolidate skill reads list_tasks). Waiting does not hold up the workspace: its
 * next task may be handed over meanwhile.
 */
import path from 'node:path';
import { formatLocal } from '../core/kst-time.ts';
import type { Store, TaskWithWorkspace } from '../store/store.ts';

/** Days a task waits in review before it is asked about again. */
export const REVIEW_REMIND_DAYS = 3;
const DAY_MS = 86_400_000;

const since = (t: TaskWithWorkspace) => t.review_since ?? t.updated_at;

/** Whole days it has waited (at least REVIEW_REMIND_DAYS for the ones listed). */
export function reviewDays(t: TaskWithWorkspace, now = Date.now()): number {
  return Math.floor((now - Date.parse(since(t))) / DAY_MS);
}

/** [] when nothing has waited REVIEW_REMIND_DAYS days. */
export function staleReviewLines(store: Store, now = Date.now()): string[] {
  let tasks: TaskWithWorkspace[];
  try {
    tasks = store.reviewWaiting(new Date(now - REVIEW_REMIND_DAYS * DAY_MS).toISOString());
  } catch {
    return [];
  }
  if (!tasks.length) return [];
  return [
    `검수 대기 ${REVIEW_REMIND_DAYS}일 넘은 업무(결과물을 사용자가 직접 봐야 끝나는 업무, 기억 DB status review):`,
    ...tasks.map((t) => `- 업무 ${t.id} "${t.title}" · ${formatLocal(since(t))}부터 ${reviewDays(t, now)}일 · ${path.join(t.folder, t.output_dir)}`),
    '이 답의 질문으로 다시 묻는다(결과물 경로를 붙여): 확인했으면 update_task done, "아직"이면 고칠 점을 받아 새 업무로 넘긴다(delegate 스킬 4번). 같은 공간에 다른 업무를 맡기는 것은 막지 않는다.',
  ];
}
