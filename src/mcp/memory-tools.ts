/**
 * 비서 MCP 서버의 기억 도구: 기억 저장·검색·무효 처리·목록·주제, 핵심 프로필(registerMemoryTools)과
 * 대화 기록 검색·기억 정리용 대화 읽기(registerLogTools). 도구 이름·설명·입력 형식이 MCP로 그대로 나간다.
 */
import { z } from 'zod';
import { BUDGET } from '../core/config.ts';
import { checkDuplicates, duplicateMessage } from '../memory/duplicate-check.ts';
import { clip, fail, formatLog, logHead, ok, type ToolContext } from './tool-common.ts';
import { formatMemory, recall } from '../memory/recall.ts';
import { findQuote, quoteNote, QUOTE_DESCRIBE, QUOTE_MISSING, quoteFormProblem, saveQuote } from '../memory/source-quote.ts';
import { missLogFile, SEARCH_TIMEOUT_MS, semanticClient, START_WAIT_MS } from '../semantic-search/client.ts';
import { MEMORY_KINDS, MemoryRaceError, SUMMARY_MIN_MEMORIES, SUMMARY_SKIP_TOPICS } from '../store/store.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { formatLocal } from '../core/kst-time.ts';

/** /consolidate reads every message whole; one longer than this is handed out alone, a part per call. */
const LOG_PART_CHARS = 20_000;
/** Which part of a long message the next get_unconsolidated_log call should hand out. */
let logPart: { id: number; next: number } | null = null;

/** remember, recall, forget, list_memories, list_topics, get_profile, update_profile. */
/** The consolidation's own server (ToolContext.candidates): memories other than topic summaries go through propose_memory → judge_memory. */
const STAFF_REMEMBER = '정리 담당 서버에서는 kind=summary(주제 요약)만 받는다. 다른 기억은 propose_memory → judge_memory로 저장한다(가까운 기억마다 판정을 받아 코드가 저장·대체한다).';

export function registerMemoryTools({ server, store, readonly: READONLY, tally, candidates }: ToolContext): void {
  server.registerTool(
    'remember',
    {
      description:
        (candidates ? `${STAFF_REMEMBER} ` : '') +
        '사용자에 대한 오래 남길 정보를 기억에 저장한다. 한 기억에는 하나의 사실만, 나중에 혼자 읽어도 이해되는 완결된 문장으로 쓴다. ' +
        '기존 기억이 바뀐 경우(이사, 취향 변화, 결정 번복)엔 supersedes에 옛 기억 id를 넣는다 — 옛 기억은 삭제되지 않고 무효 처리된다. ' +
        'decision에는 사용자가 고르거나 말한 것만 넣고, 비서의 추천·제안은 "비서가 ~를 권함"으로 적어 note로 둔다(추천을 결정으로 적으면 나중에 사용자가 정한 것으로 읽힌다).',
      inputSchema: {
        kind: z.enum(MEMORY_KINDS).describe('fact 사실 · preference 선호 · decision 결정 · event 일어난 일 · action 할 일(약속·해야 할 일) · person 인물 · note 기타 · summary 주제 요약(/consolidate 전용)'),
        content: z.string().min(1).describe('기억할 내용 (한두 문장)'),
        importance: z.number().int().min(1).max(5).optional().describe('1 사소함 ~ 5 매우 중요 (기본 3)'),
        tags: z.array(z.string()).optional().describe('검색용 키워드: 주제 1개(프로젝트명, 사람 이름 등) + 세부 1~2개. 넓은 단어는 피하고, 태그는 이 칸에만 넣는다'),
        supersedes: z.array(z.number().int()).optional().describe('이 기억으로 대체되는 옛 기억 id 목록'),
        valid_from: z.string().optional().describe('사실이 유효해진 시점. 한국시간이면 오프셋 포함 (예: 2026-10-16T20:05+09:00). 기본: 지금'),
        source_log_id: z.number().int().optional().describe('근거가 된 대화 로그 id (/consolidate에서 넣는다). 대화 중 저장은 비워 두면 그 턴에 자동 연결된다'),
        allow_similar: z.boolean().optional().describe('최근 기억과 뜻이 비슷해 저장이 멈춘 뒤 정말 다른 사실일 때만 true로 다시 저장한다'),
        quote: z.string().optional().describe(QUOTE_DESCRIBE),
      },
    },
    async ({ kind, content, importance, tags, supersedes, valid_from, source_log_id, allow_similar, quote }) => {
      if (candidates && kind !== 'summary') return fail(STAFF_REMEMBER);
      // A decision carries the user's own words (memory/source-quote.ts). With its row given they are looked up now and
      // refused when missing; saved during a chat, the Stop hook checks them once the turn is logged and linked.
      let found: ReturnType<typeof findQuote> | 'pending' = 'pending';
      if (kind === 'decision') {
        const problem = quoteFormProblem(quote);
        if (problem) return fail(problem);
        if (source_log_id !== undefined) {
          found = findQuote(store, source_log_id, quote!);
          if (!found) return fail(QUOTE_MISSING(quote!, `대화 #${source_log_id}와 그 앞`));
        }
      }
      const input = { kind, content, importance, tags, supersedes, validFrom: valid_from, sourceLogId: source_log_id };
      // Summaries replace the topic's old summary and are left out of the check; allow_similar skips it.
      const check = kind !== 'summary' && !allow_similar;
      let missed = '';
      for (let attempt = 1; ; attempt++) {
        const dup = check ? await checkDuplicates(store, semanticClient(SEARCH_TIMEOUT_MS, 'remember 중복 확인', (why) => (missed = why), { waitMs: START_WAIT_MS }), { content, tags, supersedes }) : null;
        if (dup?.similar.length) return fail(duplicateMessage(dup.similar, (iso) => formatLocal(iso, true)));
        try {
          // After two races in a row, save anyway rather than loop.
          const r = store.remember({ ...input, expectMaxId: dup && !dup.skipped && attempt < 3 ? dup.maxId : undefined });
          tally?.({ [kind === 'summary' ? 'summaries' : 'memories']: [r.id], superseded: r.superseded });
          if (kind === 'decision') saveQuote(store, r.id, quote!, found);
          const note = dup?.skipped ? ` (의미 검색 서버가 응답하지 않아 중복 확인은 못 함: ${missed || '이유 모름'}, 기록 ${missLogFile()})` : '';
          return ok(`기억 #${r.id} 저장${r.superseded.length ? ` · 무효 처리: ${r.superseded.map((i) => `#${i}`).join(', ')}` : ''}${note}`);
        } catch (err) {
          if (!(err instanceof MemoryRaceError)) throw err;
        }
      }
    },
  );

  server.registerTool(
    'recall',
    {
      description:
        '기억을 검색한다. 매 프롬프트마다 관련 기억이 일부 자동 주입되지만, 그걸로 부족하거나 특정 주제를 깊게 찾을 때 쓴다. ' +
        '결과는 토큰 예산 안에서 관련도 순으로 잘린다.',
      inputSchema: {
        query: z.string().min(1).optional().describe('찾을 내용 (자연어 또는 키워드)'),
        ids: z.array(z.number().int()).min(1).max(20).optional().describe('번호로 바로 조회할 기억 (자동 주입의 "생략:" 목록 등). query 대신 쓴다'),
        budget_tokens: z.number().int().min(100).max(BUDGET.recallMax).optional().describe(`결과 토큰 예산 (기본 ${BUDGET.recall})`),
        include_invalid: z.boolean().optional().describe('무효 처리된 옛 기억도 포함 (이력 확인용)'),
      },
    },
    async ({ query, ids, budget_tokens, include_invalid }) => {
      if (ids) {
        const found = ids.map((id) => store.getMemory(id)).filter((m) => m !== undefined);
        const text = found.map((m) => [formatMemory(m), m.kind === 'decision' ? quoteNote(store, m.id) : ''].filter(Boolean).join('\n')).join('\n');
        if (!READONLY) {
          store.touch(found.map((m) => m.id));
          store.logUsage('recall', estimateTokens(text), { ids: found.map((m) => m.id) });
        }
        const missing = ids.filter((id) => !found.some((m) => m.id === id));
        return found.length ? ok(`${text}${missing.length ? `\n(없는 번호: ${missing.join(', ')})` : ''}`) : fail('그 번호의 기억이 없어요.');
      }
      if (!query) return fail('query나 ids 중 하나가 필요해요.');
      const budget = budget_tokens ?? BUDGET.recall;
      // Waits for the semantic-search server like every feature: 30 s for an answer, 90 s for a server coming up.
      let missed = '';
      const r = await recall(store, query, { budgetTokens: budget, includeInvalid: include_invalid, semantic: semanticClient(SEARCH_TIMEOUT_MS, 'recall 도구', (why) => (missed = why), { waitMs: START_WAIT_MS }) });
      // The secretary sees that this answer is word search alone, and why (the record says when and how often).
      const semanticNote = missed ? `\n(의미 검색 안 됨: ${missed}. 단어 검색 결과만이라 뜻이 같고 글자가 다른 기억은 빠졌을 수 있음. 기록: ${missLogFile()})` : '';
      // Only explicit recalls count as use; auto-injection would let a memory keep promoting itself.
      if (!READONLY) {
        store.touch(r.items.map((i) => i.memory.id));
        store.logUsage('recall', r.tokens, { query, ids: r.items.map((i) => i.memory.id) });
      }
      if (r.items.length === 0) return ok(`관련 기억 없음. 원본 대화에서 찾으려면 search_log를 쓰세요.${semanticNote}`);
      const tail = r.droppedForBudget ? `\n(예산 ${budget}토큰 초과로 ${r.droppedForBudget}개 생략)` : '';
      return ok(`${r.text}${tail}${semanticNote}`);
    },
  );

  server.registerTool(
    'forget',
    {
      description: '더 이상 사실이 아닌 기억을 무효 처리한다 (삭제가 아니라 이력으로 남음). 새 사실로 바뀐 경우엔 remember의 supersedes를 쓴다.',
      inputSchema: {
        id: z.number().int(),
        reason: z.string().min(1).describe('무효 처리 이유'),
      },
    },
    async ({ id, reason }) => {
      // The consolidation ends an old memory with a judged candidate (judge_memory "ends"), so the reason is a memory.
      if (candidates) return fail('정리 담당 서버에서는 forget을 쓰지 않는다. 옛 기억이 끝났으면 그 일을 후보로 내고(propose_memory) judge_memory에서 ends로 판정한다.');
      if (!store.forget(id, reason)) return fail(`#${id}: 없거나 이미 무효 처리된 기억`);
      tally?.({ forgotten: [id] });
      return ok(`#${id} 무효 처리됨`);
    },
  );

  server.registerTool(
    'list_memories',
    {
      description: '최근 기억을 종류별·주제별로 나열한다 (정리·점검용).',
      inputSchema: {
        kind: z.enum(MEMORY_KINDS).optional(),
        topic: z.string().optional().describe('주제(첫 태그)가 이것인 기억만'),
        include_invalid: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ kind, topic, include_invalid, limit }) => {
      const rows = store.listMemories({ kind, topic, includeInvalid: include_invalid, limit: limit ?? 30 });
      return ok(rows.length ? rows.map(formatMemory).join('\n') : '기억 없음');
    },
  );

  server.registerTool(
    'list_topics',
    {
      description: `/consolidate용: 주제(첫 태그)별 활성 기억 수와 요약 상태. 요약이 필요한 주제(${SUMMARY_MIN_MEMORIES}개 이상)만 보여준다.`,
    },
    async () => {
      const due = store.topics().filter((t) => t.count >= SUMMARY_MIN_MEMORIES && !SUMMARY_SKIP_TOPICS.has(t.topic));
      if (due.length === 0) return ok('요약이 필요한 주제 없음');
      return ok(
        due
          .map((t) => {
            const state = !t.summaryId ? '요약 없음 → 새로 만듦' : t.latestAt > (t.summaryAt ?? '') ? `요약 #${t.summaryId} 이후 새 기억 있음 → 다시 씀` : `요약 #${t.summaryId} 최신`;
            return `${t.topic}: 기억 ${t.count}개 · ${state}`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'get_profile',
    { description: '현재 핵심 프로필 전문을 가져온다 (세션 시작 시 이미 주입되므로 보통은 불필요).' },
    async () => {
      const p = store.getProfile();
      return ok(p ? `v${p.version} (~${p.tokens} tokens, ${formatLocal(p.created_at)} 갱신)\n${p.content}` : '프로필 없음');
    },
  );

  server.registerTool(
    'update_profile',
    {
      description:
        `핵심 프로필을 새 버전으로 교체한다. 매 세션 항상 로드되므로 모든 대화에 필요한 것만 담는다: 사용자가 누구인지, 핵심 선호, 운영 원칙. 안건 상태는 프로필이 아니라 주요 현안(set_main_agenda)에 둔다. ` +
        `상한 ~${BUDGET.profileMax} 토큰. 세부 사항은 remember로 기억에 둔다. 전체 내용을 넘겨야 한다 (부분 수정 아님).`,
      inputSchema: {
        content: z.string().min(1).describe('새 프로필 전문 (마크다운)'),
        reason: z.string().min(1).describe('무엇이 왜 바뀌었는지'),
      },
    },
    async ({ content, reason }) => {
      const p = store.updateProfile(content, reason);
      tally?.({ profile: [p.version] });
      return ok(`프로필 v${p.version} 저장 (~${p.tokens}/${BUDGET.profileMax} tokens)`);
    },
  );
}

/** search_log, get_unconsolidated_log, mark_consolidated. */
export function registerLogTools({ server, store, candidates }: ToolContext): void {
  server.registerTool(
    'search_log',
    {
      description:
        '원본 대화 아카이브를 검색한다. 기억에 없는 세부 사항이나 "그때 정확히 뭐라고 했는지" 근거가 필요할 때만 쓴다. ' +
        'memory_id를 주면 그 기억이 나온 대화의 앞뒤를 조회한다 — 기억 문장만으로 모자랄 때만 조회한다.',
      inputSchema: {
        query: z.string().min(1).optional(),
        memory_id: z.number().int().optional().describe('이 기억이 나온 대화 앞뒤를 조회 (query 대신)'),
        log_id: z.number().int().optional().describe('이 대화 번호(상황판의 #1234) 앞뒤를 조회 (query 대신)'),
        limit: z.number().int().min(1).max(30).optional(),
        session_id: z.string().optional().describe('이 세션(8자리 앞부분도 됨)만. query 없이 주면 그 세션의 마지막 대화를 보여 줌'),
      },
    },
    async ({ query, memory_id, log_id, limit, session_id }) => {
      if (log_id !== undefined) {
        const n = limit ?? 4;
        const around = store.logAround(log_id, Math.floor(n / 2), Math.ceil(n / 2));
        if (around.length === 0) return fail(`대화 #${log_id}이 없어요.`);
        return ok(formatLog(around, 1500));
      }
      if (memory_id !== undefined) {
        const m = store.getMemory(memory_id);
        if (!m) return fail(`기억 #${memory_id}이 없어요.`);
        if (!m.source_log_id) return ok(`기억 #${memory_id}에는 연결된 원문이 없어요(연결 기능 이전 기억). query로 검색하세요.`);
        const n = limit ?? 6;
        const around = store.logAround(m.source_log_id, Math.floor(n / 2), Math.ceil(n / 2));
        return ok(formatLog(around, 800));
      }
      if (!query && session_id) {
        const tail = store.sessionTail(session_id, limit ?? 8);
        if (tail.length === 0) return ok(`세션 ${session_id}의 대화가 없어요.`);
        return ok(formatLog(tail, 800));
      }
      if (!query) return fail('query, memory_id, log_id, session_id 중 하나가 필요해요.');
      const rows = store.searchLog(query, { limit: limit ?? 8, sessionId: session_id });
      if (rows.length === 0) return ok('일치하는 대화 없음');
      return ok(rows.map((r) => `${logHead(r, ` session=${r.session_id.slice(0, 8)}`)}\n${clip(r.content, 800)}`).join('\n\n'));
    },
  );

  server.registerTool(
    'get_unconsolidated_log',
    {
      description:
        '아직 기억으로 정리되지 않은 대화 로그를 오래된 순으로 가져온다 (/consolidate 용). ' +
        '정리를 마치면 응답 끝의 through_log_id로 mark_consolidated를 호출한다.',
      inputSchema: {
        budget_tokens: z.number().int().min(500).max(20000).optional().describe('한 번에 가져올 양 (기본 6000)'),
      },
    },
    async ({ budget_tokens }) => {
      const budget = budget_tokens ?? 6000;
      const rows = store.unconsolidatedLog(500);
      if (rows.length === 0) return ok('정리할 대화가 없습니다.');
      const out: string[] = [];
      let used = 0;
      let through = store.consolidatedThrough();
      let partNote = '';
      let done = 0;
      for (const r of rows) {
        const head = logHead(r);
        if (r.content.length > LOG_PART_CHARS) {
          // A long message goes out alone, one part per call; the watermark moves past it only after the last part.
          if (out.length > 0) break;
          const parts = Math.ceil(r.content.length / LOG_PART_CHARS);
          const k = logPart?.id === r.id ? logPart.next : 0;
          out.push(`${head} (${k + 1}/${parts} 부분)\n${r.content.slice(k * LOG_PART_CHARS, (k + 1) * LOG_PART_CHARS)}`);
          if (k + 1 < parts) {
            logPart = { id: r.id, next: k + 1 };
            partNote = `\n로그 #${r.id}의 다음 부분이 남았다. 이 부분을 정리한 뒤 다시 get_unconsolidated_log를 부른다.`;
          } else {
            logPart = null;
            through = r.id;
            done++;
          }
          break;
        }
        const block = `${head}\n${r.content}`;
        const cost = estimateTokens(block);
        if (out.length > 0 && used + cost > budget) break;
        out.push(block);
        used += cost;
        through = r.id;
        done++;
      }
      const remaining = store.stats().unconsolidated - done;
      return ok(`${out.join('\n\n')}\n\nthrough_log_id=${through} · 남은 미정리 ${remaining}건${partNote}`);
    },
  );

  server.registerTool(
    'mark_consolidated',
    {
      description: '지정한 로그 id까지 기억 정리를 마쳤다고 기록한다.',
      inputSchema: { through_log_id: z.number().int().min(0) },
    },
    async ({ through_log_id }) => {
      // A proposed candidate never judged would be lost without a word.
      // The run stopped (the semantic-search server never answered): the batch stays for a later run.
      if (candidates?.halted) return fail(`정리를 멈춰 정리 위치를 옮기지 않았다: ${candidates.halted}. 마지막 보고 첫 줄에 이 이유를 쓰고 끝낸다.`);
      const open = candidates?.pending() ?? [];
      if (open.length) return fail(`판정하지 않은 후보가 있어 정리 위치를 옮기지 않았다: ${open.join(', ')}. judge_memory로 판정하거나 withdraw_reason을 넣어 버린 뒤 다시 부른다.`);
      store.markConsolidated(through_log_id);
      return ok(`log #${through_log_id}까지 정리 완료로 기록`);
    },
  );
}
