/**
 * 비서 MCP 서버의 실수 기록 도구(기능 'guards'): record_mistake(한 건 적기), update_mistake(옮긴 장치·평가 장면·재발 채우기),
 * list_mistakes(목록과 묶음별 수). 같은 실수를 장치로 옮기고 평가 세트로 재는 데 쓰는 기록이라, 답할 때 자동으로 읽히지 않는다.
 */
import { z } from 'zod';
import { formatLocal } from '../core/kst-time.ts';
import { guardsOn } from '../guards/settings.ts';
import { MISTAKE_CAUSES, MISTAKE_FINDERS, type Mistake } from '../store/store.ts';
import { fail, ok, type ToolContext } from './common.ts';

export const MISTAKE_TOOLS = ['record_mistake', 'update_mistake', 'list_mistakes'] as const;

export function formatMistake(m: Mistake): string {
  const extra = [
    m.log_ids ? `근거 #${m.log_ids.split(',').join(' #')}` : '',
    m.rule_ref ? `규칙: ${m.rule_ref}` : '',
    m.harm ? `피해: ${m.harm}` : '',
    m.guard ? `장치: ${m.guard}` : '장치 없음',
    m.eval_ids ? `평가: ${m.eval_ids}` : '',
    m.recurred ? '재발' : '',
  ].filter(Boolean);
  return `[#${m.id} ${formatLocal(m.happened_at)}] (${m.group_name}) ${m.what}\n  낸 쪽 ${m.made_by} · 찾은 쪽 ${m.found_by} · 원인 ${m.cause} · ${extra.join(' · ')}`;
}

/** record_mistake, update_mistake, list_mistakes: only while the feature is on in features.json. */
export function registerMistakeTools({ server, store }: ToolContext): void {
  if (!guardsOn()) return;

  server.registerTool(
    'record_mistake',
    {
      description:
        '실수 한 건을 기록한다. 사용자가 비서나 업무 세션·run-job·서브에이전트의 실수를 바로잡았을 때, 비서가 검수에서 보고의 틀린 점을 찾았을 때, 훅·검사 스크립트가 막은 것이 실수였을 때 그 자리에서 부른다. ' +
        '같은 종류는 같은 묶음 이름(group)으로 적는다(예: 영어 답, 폴더 위치, 질문 기호, 경로 표기, 보고 검수 없이 전함, 지시서 누락). 같은 묶음이 전에 있었으면 재발로 센다.',
      inputSchema: {
        what: z.string().min(1).describe('무엇이 틀렸는지 한 문장'),
        group: z.string().min(1).describe('묶음 이름(같은 종류의 실수끼리 같게)'),
        made_by: z.string().min(1).describe('낸 쪽: 비서 / 업무 세션:<공간 이름> / run-job / 서브에이전트 / 상황판'),
        found_by: z.enum(MISTAKE_FINDERS).describe('찾은 쪽: 사용자 / 비서 / 검수(보고를 열어 보다가) / 장치(훅·검사 스크립트)'),
        cause: z.enum(MISTAKE_CAUSES).describe('원인: 규칙 없음 / 안 지킴(규칙은 있는데 그 순간 안 지킴) / 정보 부족 / 도구 부족'),
        log_ids: z.array(z.number().int()).optional().describe('근거 대화 번호(search_log의 #번호)'),
        rule_ref: z.string().optional().describe('관련 규칙 위치(예: AGENTS.md "모든 것은 대화 글로", delegate 스킬). 없으면 비움'),
        harm: z.string().optional().describe('피해(예: 사용자가 다시 물음, 잘못된 폴더가 남음)'),
        guard: z.string().optional().describe('이 규칙을 옮긴 장치(훅·스크립트 이름). 아직 없으면 비움'),
        eval_ids: z.array(z.string()).optional().describe('이 실수를 재는 평가 세트 장면(예: E1)'),
        happened_at: z.string().optional().describe('실수가 난 시각(ISO). 비우면 지금'),
        session_id: z.string().optional().describe('실수가 난 세션 id'),
      },
    },
    async (a) => {
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
        evalIds: a.eval_ids,
        happenedAt: a.happened_at,
        sessionId: a.session_id,
      });
      const same = store.listMistakes({ group: m.group_name, limit: 1000 }).length;
      return ok(`실수 #${m.id} 기록${m.recurred ? ` (재발: '${m.group_name}' ${same}번째)` : ''}\n${formatMistake(m)}`);
    },
  );

  server.registerTool(
    'update_mistake',
    {
      description: '기록한 실수에 나중에 정해진 것을 채운다: 옮긴 장치(guard), 평가 세트 장면(eval_ids), 재발 여부(recurred), 피해, 규칙 위치.',
      inputSchema: {
        id: z.number().int().describe('실수 번호(list_mistakes의 #)'),
        guard: z.string().optional(),
        eval_ids: z.array(z.string()).optional(),
        recurred: z.boolean().optional(),
        harm: z.string().optional(),
        rule_ref: z.string().optional(),
      },
    },
    async ({ id, guard, eval_ids, recurred, harm, rule_ref }) => {
      const m = store.updateMistake(id, { guard, evalIds: eval_ids, recurred, harm, ruleRef: rule_ref });
      return m ? ok(formatMistake(m)) : fail(`이 번호의 실수 기록이 없어요: #${id}`);
    },
  );

  server.registerTool(
    'list_mistakes',
    {
      description: '실수 기록을 보여 준다. 묶음별 수(재발, 장치 있음)를 먼저, 그 뒤 최근 기록. group·cause로 거를 수 있다.',
      inputSchema: {
        group: z.string().optional().describe('이 묶음만'),
        cause: z.enum(MISTAKE_CAUSES).optional().describe('이 원인만'),
        limit: z.number().int().min(1).max(200).optional().describe('기록 수(기본 20)'),
      },
    },
    async ({ group, cause, limit }) => {
      const groups = store.mistakeGroups();
      const rows = store.listMistakes({ group, cause, limit: limit ?? 20 });
      if (!groups.length) return ok('실수 기록이 없어요.');
      const head = groups.map((g) => `- ${g.group_name}: ${g.n}건(재발 ${g.recurred ?? 0}) · 마지막 ${formatLocal(g.last_at)} · ${g.guarded ? '장치 있음' : '장치 없음'}`);
      return ok([`묶음별 (${groups.length}개)`, ...head, '', `기록 (${rows.length}건)`, ...rows.map(formatMistake)].join('\n'));
    },
  );
}
