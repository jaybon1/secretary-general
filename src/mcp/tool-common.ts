/**
 * 비서 MCP 서버(mcp/server.ts)의 도구 파일들이 함께 쓰는 것: 도구를 등록할 때 넘기는 묶음(ToolContext)과 답 모양(ok·fail), 대화 기록 표시.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LogEntry, Store } from '../store/store.ts';
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
