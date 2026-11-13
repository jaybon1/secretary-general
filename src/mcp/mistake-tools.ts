/**
 * 비서 MCP 서버의 실수 기록 도구(기능 'mistake-guards'): record_mistake(한 건 적기), update_mistake(옮긴 장치·재발 채우기),
 * list_mistakes(목록과 분류별 수). 같은 실수를 장치로 옮기는 데 쓰는 기록이라, 답할 때 자동으로 읽히지 않는다.
 */
import { z } from 'zod';
import { formatLocal } from '../core/kst-time.ts';
import { guardsOn } from '../mistake-guards/mistake-guard-settings.ts';
import { answerCheck } from '../mistake-guards/answer-check-table.ts';
import { TOOL_HOOK_GUARDS } from '../mistake-guards/tool-hook-hits.ts';
import { addInventedWords } from '../mistake-guards/invented-words.ts';
import { searchTerms } from '../memory/search-terms.ts';
import { MISTAKE_CAUSES, MISTAKE_FINDERS, type Mistake } from '../store/store.ts';
import { fail, ok, type ToolContext } from './tool-common.ts';

export const MISTAKE_TOOLS = ['record_mistake', 'update_mistake', 'list_mistakes'] as const;

export function formatMistake(m: Mistake): string {
  const extra = [
    m.log_ids ? `근거 #${m.log_ids.split(',').join(' #')}` : '',
    m.rule_ref ? `규칙: ${m.rule_ref}` : '',
    m.harm ? `피해: ${m.harm}` : '',
    m.guard ? `장치: ${m.guard}` : '장치 없음',
    m.recurred ? '재발' : '',
  ].filter(Boolean);
  return `[#${m.id} ${formatLocal(m.happened_at)}] (${m.group_name}) ${m.what}\n  낸 쪽 ${m.made_by} · 찾은 쪽 ${m.found_by} · 원인 ${m.cause} · ${extra.join(' · ')}`;
}

/**
 * Existing group names that look like `group` (sharing a word part), for a group recorded for the first time: one kind of
 * slip under several names went uncounted as a repeat (four names for one, merged by migration 18). Best first, at most 5.
 */
export function similarGroups(group: string, names: readonly string[]): string[] {
  const mine = new Set(searchTerms(group));
  if (!mine.size) return [];
  return names
    .filter((n) => n !== group)
    .map((n) => {
      const theirs = new Set(searchTerms(n));
      const shared = [...mine].filter((t) => theirs.has(t)).length;
      return { n, score: shared / Math.max(1, Math.min(mine.size, theirs.size)) };
    })
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.n);
}

/** How many days back list_mistakes counts the guards' catches from the turn record. */
export const GUARD_HIT_DAYS = 30;

/** The guards' catches from the turn record (store guardHitSummary), one line each: hook, guard, blocked or told, count, last. */
export function formatGuardHits(rows: Array<{ hook: string; check: string; level: 'block' | 'warn'; n: number; last_at: string }>): string[] {
  return rows.map((r) => {
    const name = TOOL_HOOK_GUARDS[r.check as keyof typeof TOOL_HOOK_GUARDS] ?? answerCheck(r.check)?.name ?? r.check;
    return `- ${r.hook} ${name}(${r.check}, ${r.level === 'block' ? '막음' : '알림'}): ${r.n}번 · 마지막 ${formatLocal(r.last_at)}`;
  });
}

/** record_mistake, update_mistake, list_mistakes: only while the feature is on in features.json. */
export function registerMistakeTools({ server, store }: ToolContext): void {
  if (!guardsOn()) return;

  server.registerTool(
    'record_mistake',
    {
      description:
        '실수 한 건을 기록한다. 사용자가 비서나 업무 세션·run-job·서브에이전트의 실수를 바로잡았을 때, 비서가 검수에서 보고의 틀린 점을 찾았을 때, 훅·검사 스크립트가 막은 것이 실수였을 때 그 자리에서 부른다. ' +
        '같은 종류는 같은 분류 이름(group)으로 적는다(예: 영어 답, 폴더 위치, 질문 기호, 경로 표기, 보고 검수 없이 전함, 지시서 누락). 같은 분류가 전에 있었으면 재발로 센다.',
      inputSchema: {
        what: z.string().min(1).describe('무엇이 틀렸는지 한 문장'),
        group: z.string().min(1).describe('분류 이름(같은 종류의 실수끼리 같게)'),
        made_by: z.string().min(1).describe('낸 쪽: 비서 / 업무 세션:<공간 이름> / run-job / 서브에이전트 / 상황판'),
        found_by: z.enum(MISTAKE_FINDERS).describe('찾은 쪽: 사용자 / 비서 / 검수(보고를 열어 보다가) / 장치(훅·검사 스크립트)'),
        cause: z.enum(MISTAKE_CAUSES).describe('원인: 규칙 없음 / 안 지킴(규칙은 있는데 그 순간 안 지킴) / 정보 부족 / 도구 부족'),
        log_ids: z.array(z.number().int()).optional().describe('근거 대화 번호(search_log의 #번호)'),
        rule_ref: z.string().optional().describe('관련 규칙 위치(예: AGENTS.md "답 쓰는 법 > 질문", delegate 스킬). 없으면 비움'),
        harm: z.string().optional().describe('피해(예: 사용자가 다시 물음, 잘못된 폴더가 남음)'),
        guard: z.string().optional().describe('이 규칙을 옮긴 장치(훅·스크립트 이름). 아직 없으면 비움'),
        happened_at: z.string().optional().describe('실수가 난 시각(ISO). 비우면 지금'),
        session_id: z.string().optional().describe('실수가 난 세션 id'),
        invented_words: z
          .array(z.string().min(1).max(20))
          .optional()
          .describe('지어낸 말 실수일 때만: 사용자가 되물은 그 낱말(예: "칸"). 답변 검사가 다음부터 질문·선택지·근거 줄에서 풀이 없이 나오면 알린다'),
      },
    },
    async (a) => {
      const groupsBefore = store.mistakeGroups().map((g) => g.group_name);
      const m = store.recordMistake({
        what: a.what,
        group: a.group,
        madeBy: a.made_by,
        foundBy: a.found_by,
        cause: a.cause,
        logIds: a.log_ids,
        ruleRef: a.rule_ref,
        harm: a.harm,
        guard: a.guard,
        happenedAt: a.happened_at,
        sessionId: a.session_id,
      });
      const same = store.listMistakes({ group: m.group_name, limit: 1000 }).length;
      const added = a.invented_words?.length ? addInventedWords(store, a.invented_words) : [];
      const similar = groupsBefore.includes(m.group_name) ? [] : similarGroups(m.group_name, groupsBefore);
      return ok(
        [
          `실수 #${m.id} 기록${m.recurred ? ` (재발: '${m.group_name}' ${same}번째)` : ''}`,
          formatMistake(m),
          ...(added.length ? [`지어낸 말 목록에 더함: ${added.join(', ')}(답변 검사가 다음 답부터 알림)`] : []),
          ...(similar.length
            ? [`새 분류 이름이다. 비슷한 기존 분류: ${similar.map((n) => `'${n}'`).join(', ')}. 같은 종류면 update_mistake의 group으로 그 이름으로 옮긴다(이름이 갈리면 재발로 안 센다).`]
            : []),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'update_mistake',
    {
      description: '기록한 실수에 나중에 정해진 것을 채운다: 분류 이름(group, 같은 종류의 기존 분류로 옮길 때), 옮긴 장치(guard), 재발 여부(recurred), 피해, 규칙 위치.',
      inputSchema: {
        id: z.number().int().describe('실수 번호(list_mistakes의 #)'),
        group: z.string().min(1).optional().describe('분류 이름을 바꿀 때(같은 종류의 기존 분류로 옮길 때)'),
        guard: z.string().optional(),
        recurred: z.boolean().optional(),
        harm: z.string().optional(),
        rule_ref: z.string().optional(),
      },
    },
    async ({ id, group, guard, recurred, harm, rule_ref }) => {
      const m = store.updateMistake(id, { group, guard, recurred, harm, ruleRef: rule_ref });
      return m ? ok(formatMistake(m)) : fail(`이 번호의 실수 기록이 없어요: #${id}`);
    },
  );

  server.registerTool(
    'list_mistakes',
    {
      description: `실수 기록을 보여 준다. 분류별 수(재발, 장치 있음)를 먼저, 그 뒤 최근 기록. group·cause로 거를 수 있다. 맨 끝에 최근 ${GUARD_HIT_DAYS}일 동안 훅(Stop 답변 검사, PreToolUse 폴더 쓰기 막기, PostToolUse 반복 작업 알림)이 걸린 수를 붙인다.`,
      inputSchema: {
        group: z.string().optional().describe('이 분류만'),
        cause: z.enum(MISTAKE_CAUSES).optional().describe('이 원인만'),
        limit: z.number().int().min(1).max(200).optional().describe('기록 수(기본 20)'),
      },
    },
    async ({ group, cause, limit }) => {
      const groups = store.mistakeGroups();
      const rows = store.listMistakes({ group, cause, limit: limit ?? 20 });
      if (!groups.length) return ok('실수 기록이 없어요.');
      const head = groups.map((g) => `- ${g.group_name}: ${g.n}건(재발 ${g.recurred ?? 0}) · 마지막 ${formatLocal(g.last_at)} · ${g.guarded ? '장치 있음' : '장치 없음'}`);
      return ok([`분류별 (${groups.length}개)`, ...head, '', `기록 (${rows.length}건)`, ...rows.map(formatMistake)].join('\n'));
    },
  );
}
