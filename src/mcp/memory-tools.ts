/**
 * 비서 MCP 서버의 기억 도구: 기억 저장·검색·무효 처리·목록·주제, 핵심 프로필(registerMemoryTools)과
 * 대화 기록 검색·기억 정리용 대화 읽기(registerLogTools). 도구 이름·설명·입력 형식이 MCP로 그대로 나간다.
 */
import { z } from 'zod';
import { BUDGET } from '../core/config.ts';
import { duplicateMessage, rememberChecked } from '../memory/duplicate-check.ts';
import { ACTION_FIELDS, actionValues, clip, fail, formatLog, logHead, ok, type ToolContext } from './tool-common.ts';
import { formatMemory, recall } from '../memory/recall.ts';
import { findQuote, quoteNote, QUOTE_DESCRIBE, QUOTE_MISSING, quoteFormProblem, saveQuote } from '../memory/source-quote.ts';
import { missLogFile, SEARCH_TIMEOUT_MS, semanticClient, START_WAIT_MS } from '../semantic-search/client.ts';
import { MEMORY_KINDS, SUMMARY_MIN_MEMORIES, SUMMARY_SPLIT_TOPICS, TOPIC_SPLIT, type Store } from '../store/store.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { formatLocal } from '../core/kst-time.ts';
import { rememberedText } from '../log/turn-memories.ts';
import { PAIR_VERDICTS, PairBook, PAIRS_PER_RUN, TAG_CHECKS_PER_RUN } from '../memory/memory-pairs.ts';
import { resolveQuestionCondition } from '../store/open-questions.ts';
import { sameTagWords } from '../store/tag-names.ts';

/** Topic summaries list_topics asks one consolidation run to write new at most (a topic without one; rewrites are not counted). */
export const NEW_SUMMARIES_PER_RUN = 5;
/**
 * list_topics' lines: the topics due a summary and what to do with each. A run writes NEW_SUMMARIES_PER_RUN new summaries at
 * most: splitting the secretary's topic made 25 topics without one at once, past what one run does in its time limit.
 */
export function topicLines(store: Pick<Store, 'topics'>): string[] {
  let fresh = 0;
  return store
    .topics()
    .filter((t) => t.count >= SUMMARY_MIN_MEMORIES)
    .map((t) => {
      const state = !t.summaryId
        ? fresh++ < NEW_SUMMARIES_PER_RUN
          ? '요약 없음 → 새로 만듦'
          : '요약 없음 → 다음 정리에 만듦(이번 정리 몫을 넘음)'
        : t.latestAt > (t.summaryAt ?? '')
          ? `요약 #${t.summaryId} 이후 새 기억 있음 → 다시 씀`
          : `요약 #${t.summaryId} 최신`;
      return `${t.topic}: 기억 ${t.count}개 · ${state}`;
    });
}

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
        'decision에는 사용자가 고르거나 말한 것만 넣고, 비서의 추천·제안은 "비서가 ~를 권함"으로 적어 note로 둔다(추천을 결정으로 적으면 나중에 사용자가 정한 것으로 읽힌다). ' +
        'action(할 일)에는 owner(누가 할 일인지)를 넣고, 기한이 있으면 due, 무엇이 된 뒤에 할 일이면 condition을 넣는다(할 일 요약과 조건 알림이 이 값을 읽는다). 끝난 할 일은 forget이나 새 기억의 supersedes로 닫는다.',
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
        ...ACTION_FIELDS,
      },
    },
    async ({ kind, content, importance, tags, supersedes, valid_from, source_log_id, allow_similar, quote, owner, due, condition }) => {
      if (candidates && kind !== 'summary') return fail(STAFF_REMEMBER);
      // An action carries who is to do it, and when or after what (store/memory-actions.ts): the to-do summary reads them.
      const action = kind === 'action' ? actionValues({ owner, due, condition }) : null;
      if (action && 'error' in action) return fail(action.error);
      if (kind !== 'action' && (owner || due || condition)) return fail('owner·due·condition은 kind=action(할 일)에만 넣는다.');
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
      const search = check ? semanticClient(SEARCH_TIMEOUT_MS, 'remember 중복 확인', (why) => (missed = why), { waitMs: START_WAIT_MS }) : null;
      const res = await rememberChecked(store, search, input);
      if ('similar' in res) return fail(duplicateMessage(res.similar, (iso) => formatLocal(iso, true)));
      const r = res.saved;
      tally?.({ [kind === 'summary' ? 'summaries' : 'memories']: [r.id], superseded: r.superseded });
      if (kind === 'decision') saveQuote(store, r.id, quote!, found);
      // A question's label is kept as the row that asked it (labels are given again in a new session).
      if (action && !('error' in action)) store.setAction(r.id, { ...action, condition: action.condition && resolveQuestionCondition(store, action.condition), by: 'secretary', logId: source_log_id ?? null });
      const note = res.skipped ? ` (의미 검색 서버가 응답하지 않아 중복 확인은 못 함: ${missed || '이유 모름'}, 기록 ${missLogFile()})` : '';
      // The Stop hook finds this turn's memories by these words in the transcript (log/turn-memories.ts).
      return ok(`${rememberedText(r.id)}${r.superseded.length ? ` · 무효 처리: ${r.superseded.map((i) => `#${i}`).join(', ')}` : ''}${note}`);
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
        const text = found.map((m) => [formatMemory(m, store), m.kind === 'decision' ? quoteNote(store, m.id) : ''].filter(Boolean).join('\n')).join('\n');
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
        topic: z.string().optional().describe(`주제(첫 태그)가 이것인 기억만. list_topics의 주제 이름(예: "비서${TOPIC_SPLIT}상황판")도 된다`),
        include_invalid: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ kind, topic, include_invalid, limit }) => {
      const rows = store.listMemories({ kind, topic, includeInvalid: include_invalid, limit: limit ?? 30 });
      return ok(rows.length ? rows.map((m) => formatMemory(m, store)).join('\n') : '기억 없음');
    },
  );

  server.registerTool(
    'list_topics',
    {
      description:
        `/consolidate용: 주제(첫 태그)별 활성 기억 수와 요약 상태. 요약이 필요한 주제(${SUMMARY_MIN_MEMORIES}개 이상)만 보여준다. ` +
        `기억이 너무 많은 주제(${[...SUMMARY_SPLIT_TOPICS].join(', ')})는 둘째 태그까지 묶어 "비서${TOPIC_SPLIT}상황판"처럼 보여 준다. 요약을 쓸 때 tags는 [그 주제 이름 그대로, "요약"]이다.`,
    },
    async () => {
      const lines = topicLines(store);
      return ok(lines.length ? lines.join('\n') : '요약이 필요한 주제 없음');
    },
  );

  if (candidates) registerConsolidationUpkeep({ server, store, readonly: READONLY, tally, candidates });

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

/**
 * Only on the memory consolidation's own server: the upkeep after the batches (consolidate skill references/procedure.md).
 * get_memory_pairs · judge_memory_pair judge close pairs of memories already saved (memory/memory-pairs.ts); get_tag_checks ·
 * set_memory_tags · merge_tags set the tag boundaries migration 21 could not tell (store/memories.ts).
 */
function registerConsolidationUpkeep({ server, store, tally }: ToolContext): void {
  const pairs = new PairBook();
  server.registerTool(
    'get_memory_pairs',
    {
      description: `기억 정리 담당 전용: 같은 주제이면서 뜻이 가까운 살아 있는 기억 짝을 받는다(한 번 정리에 ${PAIRS_PER_RUN}쌍까지, 판정한 짝은 다시 나오지 않음). 짝마다 judge_memory_pair로 판정한다.`,
    },
    async () => ok(pairs.hand(store)),
  );
  server.registerTool(
    'judge_memory_pair',
    {
      description:
        '기억 정리 담당 전용: get_memory_pairs가 준 짝 하나를 판정한다. 먼저 두 기억이 누구·무엇에 관한지 각 글 그대로 베껴 견준다(한 글자만 달라도 다른 대상이면 unrelated). ' +
        '판정: unrelated(다른 대상, 같은 대상의 다른 면, 다른 때 따로 일어난 일 → 둘 다 둠) · repeats(새 기억이 옛 기억과 같은 내용 → 옛 기억을 새 기억으로 대체) · ' +
        'changes(같은 면의 값이 바뀜, 결정을 바꿈, 끝남·꺼짐·해지 → 옛 기억을 새 기억으로 대체). 옛 기억이 지난 사건(event)이면 unrelated다. ' +
        '대체되는 옛 기억에 새 기억과 상관없이 여전히 맞는 다른 내용이 있으면 rest에 그 나머지만 완결된 문장으로 쓴다(코드가 옛 기억의 종류·태그·날짜로 새 기억을 남긴다).',
      inputSchema: {
        pair: z.string().describe('get_memory_pairs가 준 짝 번호 (예: P1)'),
        older_about: z.string().min(1).describe('옛 기억 글이 누구·무엇에 관한지, 그 글에 적힌 그대로'),
        newer_about: z.string().min(1).describe('새 기억 글이 누구·무엇에 관한지, 그 글에 적힌 그대로'),
        verdict: z.enum(PAIR_VERDICTS),
        rest: z.string().optional().describe('repeats·changes일 때만: 옛 기억에서 여전히 맞는 나머지 내용(완결된 문장). 없으면 비움'),
      },
    },
    async ({ pair, older_about, newer_about, verdict, rest }) => {
      const key = pair.trim().toUpperCase();
      const r = pairs.judge(store, key, { verdict, olderAbout: older_about, newerAbout: newer_about, rest });
      if (!r.ok) return fail(r.text);
      tally?.({ pairs: [`${key} ${verdict}`], superseded: r.superseded ?? [], memories: r.rests ?? [], rests: r.rests ?? [] });
      return ok(r.text);
    },
  );
  server.registerTool(
    'get_tag_checks',
    {
      description:
        `기억 정리 담당 전용: 태그 경계를 확인할 기억을 받는다(한 번 정리에 ${TAG_CHECKS_PER_RUN}개). 옛 태그는 한 글로 이어 저장돼 두 낱말 태그("할 일", "모종 가게")와 두 태그를 가르지 못해 띄어쓰기로 나눠 두었다. ` +
        '기억마다 원래 뜻대로 태그를 묶어 set_memory_tags로 저장한다(맞으면 같은 태그를 그대로 넣어 확인만 한다).',
    },
    async () => {
      const { due, left } = store.tagChecksDue(TAG_CHECKS_PER_RUN);
      if (!due.length) return ok('태그 경계를 확인할 기억 없음');
      const lines = due.map((m) => `#${m.id} 태그 ${JSON.stringify(store.tagsOf(m.id))}: ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`);
      return ok([`태그 경계를 확인할 기억 ${due.length}개(남은 것 모두 ${left}개):`, ...lines].join('\n'));
    },
  );
  server.registerTool(
    'set_memory_tags',
    {
      description:
        '기억 정리 담당 전용: 기억 하나의 태그를 순서대로 다시 정한다. 첫 태그가 주제다(주제 1개 + 세부 1~2개, 두 낱말이 한 이름이면 한 태그로: ["텃밭", "할 일"]). ' +
        '내용에 없는 새 낱말은 넣지 않는다(검색에 쓰이던 낱말을 지우지도 않는다: 쪼개진 낱말을 다시 묶기만 한다).',
      inputSchema: {
        id: z.number().int().describe('기억 번호'),
        tags: z.array(z.string()).min(1).describe('태그, 첫 것이 주제'),
      },
    },
    async ({ id, tags }) => {
      const before = store.tagsOf(id);
      // Only the boundaries move: a word dropped or added would change what the memory is found by.
      if (before.length && !sameTagWords(before, tags)) return fail(`태그의 낱말이 달라짐(전: ${JSON.stringify(before)}). 쪼개진 낱말을 다시 묶기만 한다. 낱말을 바꿀 일이면 그대로 두고 보고의 개선 후보에 적는다.`);
      const kept = store.setMemoryTags(id, tags);
      tally?.({ retagged: [id] });
      return ok(`#${id} 태그: ${JSON.stringify(kept)}`);
    },
  );
  server.registerTool(
    'merge_tags',
    {
      description: '기억 정리 담당 전용: 같은 것을 가리키는 두 태그 이름을 하나로 묶는다(예: "크롬" → "크롬확장"). alias를 단 기억은 canonical로 바뀌고, 앞으로 alias로 저장해도 canonical로 읽는다.',
      inputSchema: {
        alias: z.string().min(1).describe('없앨 이름(별칭이 됨)'),
        canonical: z.string().min(1).describe('남길 이름'),
      },
    },
    async ({ alias, canonical }) => {
      const ids = store.mergeTags(alias, canonical);
      tally?.({ retagged: ids });
      return ok(`"${alias}" → "${canonical}" 묶음 · 바뀐 기억 ${ids.length}개${ids.length ? `: ${ids.map((i) => `#${i}`).join(', ')}` : ''}`);
    },
  );
}

/** search_log, get_unconsolidated_log, mark_consolidated. */
export function registerLogTools({ server, store, candidates }: ToolContext): void {
  /**
   * The last through_log_id this server handed out with get_unconsolidated_log (null: none yet). mark_consolidated takes
   * nothing past it: a wrong number would mark messages nobody read as consolidated, and the memories in them would never
   * be made. Kept in this server's memory, not in the database: the consolidation runs its own server (--staff), and the
   * batch it may close is the one this very server handed it (a restarted server hands the batch out again).
   */
  let handedThrough: number | null = null;
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
      // What the secretary already saved from a row during the chat (linked by the Stop hook): not to be proposed again.
      const saved = store.memoriesFromRows(rows.map((r) => r.id));
      for (const r of rows) {
        const ids = saved.get(r.id);
        const head = `${logHead(r)}${ids ? ` (이 줄에서 이미 저장한 기억: ${ids.map((i) => `#${i}`).join(', ')})` : ''}`;
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
      handedThrough = through;
      return ok(`${out.join('\n\n')}\n\nthrough_log_id=${through} · 남은 미정리 ${remaining}건${partNote}`);
    },
  );

  server.registerTool(
    'mark_consolidated',
    {
      description: '지정한 로그 id까지 기억 정리를 마쳤다고 기록한다. 이 서버의 get_unconsolidated_log가 마지막으로 넘겨준 through_log_id까지만 받는다.',
      inputSchema: { through_log_id: z.number().int().min(0) },
    },
    async ({ through_log_id }) => {
      // A proposed candidate never judged would be lost without a word.
      // The run stopped (the semantic-search server never answered): the batch stays for a later run.
      if (candidates?.halted) return fail(`정리를 멈춰 정리 위치를 옮기지 않았다: ${candidates.halted}. 마지막 보고 첫 줄에 이 이유를 쓰고 끝낸다.`);
      const open = candidates?.pending() ?? [];
      if (open.length) return fail(`판정하지 않은 후보가 있어 정리 위치를 옮기지 않았다: ${open.join(', ')}. judge_memory로 판정하거나 withdraw_reason을 넣어 버린 뒤 다시 부른다.`);
      if (handedThrough === null) return fail('이 서버가 아직 대화를 넘겨주지 않아 정리 위치를 옮기지 않았다. get_unconsolidated_log로 배치를 받아 정리한 뒤, 그 응답 끝의 through_log_id로 다시 부른다.');
      if (through_log_id > handedThrough) return fail(`through_log_id=${through_log_id}은 마지막으로 넘겨준 배치의 끝(#${handedThrough})보다 뒤라 정리 위치를 옮기지 않았다(읽지 않은 대화가 정리된 것으로 처리된다). 응답 끝의 through_log_id=${handedThrough}로 다시 부른다.`);
      store.markConsolidated(through_log_id);
      return ok(`log #${through_log_id}까지 정리 완료로 기록`);
    },
  );
}
