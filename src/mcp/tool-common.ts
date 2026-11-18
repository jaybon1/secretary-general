/**
 * 비서 MCP 서버(mcp/server.ts)의 도구 파일들이 함께 쓰는 것: 도구를 등록할 때 넘기는 묶음(ToolContext)과 답 모양(ok·fail), 대화 기록 표시.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ACTION_COND_KINDS, ACTION_OWNERS, checkCondition, normalizeDue, type ActionCondition, type ActionOwner, type LogEntry, type Store } from '../store/store.ts';
import type { ConsolidateTally } from '../memory/consolidate-tally.ts';
import type { CandidateBook } from '../memory/consolidate-verdicts.ts';
import { formatLocal } from '../core/kst-time.ts';

/**
 * What each tool file's register function gets. `readonly` is the server's --readonly. `tally`: only in the memory
 * consolidation's own server (--staff memory-consolidation), the write tools report what they wrote (memory/consolidate-tally.ts).
 */
export interface ToolContext {
  server: McpServer;
  store: Store;
  readonly: boolean;
  tally?: (part: Partial<ConsolidateTally>) => void;
  /**
   * Only in the memory consolidation's own server: its memory candidates (propose_memory → judge_memory,
   * memory/consolidate-verdicts.ts). There remember takes topic summaries only and forget is refused, so every other
   * memory goes through a verdict per close memory.
   */
  candidates?: CandidateBook;
}

export const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
export const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…(+${s.length - max}자)` : s);
export const logHead = (r: LogEntry, extra = '') => `[log #${r.id} ${formatLocal(r.created_at)} ${r.role}${extra}]`;
export const formatLog = (rows: LogEntry[], max: number) => rows.map((r) => `${logHead(r)}\n${clip(r.content, max)}`).join('\n\n');

/**
 * An action memory's own values (store/memory-actions.ts) as remember and propose_memory take them: who is to do it,
 * when, and after what. The to-do summary reads them (todo-summary/); an action without an owner is not in it.
 */
export const ACTION_FIELDS = {
  owner: z.enum(ACTION_OWNERS).optional().describe('kind=action일 때 꼭 넣는다: 누가 할 일인지. user 사용자 · secretary 비서'),
  due: z.string().optional().describe('kind=action: 기한. YYYY-MM-DD, 시각까지면 YYYY-MM-DDTHH:MM+09:00. 없으면 비운다'),
  condition: z
    .object({ kind: z.enum(ACTION_COND_KINDS), value: z.string().min(1) })
    .optional()
    .describe(
      'kind=action: 무엇이 된 뒤에 할 일인지. date(그 날짜가 됨, value YYYY-MM-DD) · task_done(맡긴 업무가 끝남, value 업무 번호) · commit_in_main(커밋이 main에 들어감, value 커밋 해시) · question_answered(질문에 답을 받음, value 질문 알파벳이나 물은 대화 번호) · text(프로그램이 확인 못 하는 조건, value 그 조건 글). 없으면 비운다',
    ),
};

/** The values checked for an action: an owner is needed; a due date or condition in the wrong form is said. */
export function actionValues(v: { owner?: ActionOwner; due?: string; condition?: ActionCondition }): { owner: ActionOwner; due: string | null; condition: ActionCondition | null } | { error: string } {
  if (!v.owner) return { error: 'kind=action(할 일)에는 owner(user 사용자 · secretary 비서)를 넣는다. 할 일 요약이 주인으로 사용자 할 일을 고른다.' };
  try {
    return { owner: v.owner, due: v.due ? normalizeDue(v.due) : null, condition: v.condition ? checkCondition(v.condition) : null };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
