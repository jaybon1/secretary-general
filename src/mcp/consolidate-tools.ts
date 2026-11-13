/**
 * 기억 정리 담당 전용 MCP 도구(propose_memory·judge_memory): 기억 후보를 내면 코드가 가까운 기억을 찾아 보여 주고, 담당이 기억마다
 * 고른 고정 판정을 받아 코드가 저장·대체·건너뜀을 한다(memory/consolidate-verdicts.ts). 정리 담당의 기억 서버(--staff
 * memory-consolidation)에만 등록한다(mcp/server.ts). 비서 자신의 서버에는 없다.
 */
import { z } from 'zod';
import { fail, ok, type ToolContext } from './tool-common.ts';
import { CANDIDATE_KINDS, DURATIONS, VERDICTS } from '../memory/consolidate-verdicts.ts';
import { QUOTE_DESCRIBE } from '../memory/source-quote.ts';

export function registerConsolidateTools({ server, candidates, tally }: ToolContext): void {
  if (!candidates) return;
  server.registerTool(
    'propose_memory',
    {
      description:
        '기억 정리 담당 전용: 배치에서 뽑은 기억 후보 하나를 낸다. 저장하지는 않고 후보 번호(C1…)와 가까운 기존 기억 목록을 돌려준다. ' +
        '이어서 judge_memory로 그 목록의 기억마다 판정을 내면 코드가 저장·대체·건너뜀을 한다. 한 후보 = 한 사실. ' +
        '언제 말했는지는 코드가 source_log_id의 대화 시각으로 정한다.',
      inputSchema: {
        kind: z.enum(CANDIDATE_KINDS as [string, ...string[]]).describe('fact 사실 · preference 선호 · decision 결정(사용자가 고르거나 말한 것만) · event 일어난 일 · action 할 일 · person 인물 · note 기타(비서의 추천은 "비서가 ~를 권함"으로 note)'),
        content: z.string().min(1).describe('기억할 내용: 맥락 없이 읽어도 되는 완결된 한국어 문장 한두 개'),
        tags: z.array(z.string()).optional().describe('주제 1개 + 세부 1~2개'),
        importance: z.number().int().min(1).max(5).optional().describe('1 사소함 ~ 5 매우 중요 (기본 3)'),
        source_log_id: z.number().int().describe('근거가 된 대화 로그 id ([log #N]의 N, 사용자 말이 있으면 그 줄). 그 대화 시각으로 가까운 기억과 때를 견준다'),
        quote: z.string().optional().describe(QUOTE_DESCRIBE),
      },
    },
    async ({ kind, content, tags, importance, source_log_id, quote }) =>
      ok(await candidates.propose({ kind: kind as (typeof CANDIDATE_KINDS)[number], content, tags, importance, sourceLogId: source_log_id, quote })),
  );

  server.registerTool(
    'judge_memory',
    {
      description:
        '기억 정리 담당 전용: propose_memory로 낸 후보의 판정을 받아 코드가 실행한다. ' +
        '먼저 about에 후보가 누구·무엇에 관한 말인지 후보 글 그대로 베끼고, verdicts에는 propose_memory가 보여 준 가까운 기억마다 판정 하나와 그 기억 글이 누구·무엇에 관한지(observation_about, 그 기억 글 그대로)를 넣는다. 두 이름을 견주어 한 글자만 달라도(계정 a / 계정 b) 다른 대상이면 unrelated다. ' +
        '판정: unrelated(다른 대상, 같은 대상의 다른 면, 다른 때 따로 일어난 일 → 그대로 둠) · repeats(이미 같은 내용 → 후보를 저장하지 않음) · ' +
        'changes(같은 면의 값이 바뀜·결정을 바꿈 → 후보를 저장하고 옛 기억을 대체) · ends(옛 기억이 더는 참이 아님: 끝남·꺼짐·제거·해지·할 일을 마침 → 옛 기억을 대체). ' +
        'changes·ends로 대체되는 옛 기억에 이번 후보와 상관없이 여전히 맞는 다른 내용(다른 결정·다른 면)이 있으면 rest에 그 나머지만 완결된 문장으로 쓴다(코드가 옛 기억의 종류·태그·날짜로 새 기억을 남긴다). 없으면 비운다. ' +
        'repeats가 있어도 후보에 그 기억들에 없는 새 내용이 있으면 adds에 그 새 내용만 완결된 문장으로 쓴다(없으면 비운다). ' +
        'duration: lasting(오래 가는 사실·선호·결정·할 일, 켬/끔·설치·해지처럼 상태가 바뀐 일) · once(그 일 한 번에만 준 허락·예외, 한 번 일어난 일 → event로 저장하고 옛 기억은 대체하지 않음). ' +
        '목록의 기억이 하나라도 판정 없이 남거나 목록 밖 번호가 있으면 거절하니 고쳐 다시 부른다. 저장하지 않기로 한 후보는 withdraw_reason을 넣어 버린다.',
      inputSchema: {
        candidate: z.string().describe('propose_memory가 준 후보 번호 (예: C1)'),
        about: z.string().min(1).describe('후보가 누구·무엇에 관한 말인지, 후보 글에 적힌 그대로 (예: "계정 a 요금제")'),
        duration: z.enum(DURATIONS),
        verdicts: z
          .array(
            z.object({
              id: z.number().int().describe('가까운 기억 번호'),
              observation_about: z.string().min(1).describe('그 기억 글이 누구·무엇에 관한지, 그 기억 글에 적힌 그대로'),
              verdict: z.enum(VERDICTS),
              rest: z.string().optional().describe('changes·ends일 때만: 옛 기억에서 여전히 맞는 나머지 내용(완결된 문장). 없으면 비움'),
            }),
          )
          .describe('가까운 기억마다 판정 하나 (가까운 기억이 없으면 [])'),
        adds: z.string().optional().describe('repeats가 있을 때만: 후보가 그 기억들에 더하는 새 내용(완결된 문장). 없으면 비움'),
        withdraw_reason: z.string().min(1).optional().describe('후보를 저장하지 않고 버릴 때만: 왜 버리는지'),
      },
    },
    async ({ candidate, about, duration, verdicts, adds, withdraw_reason }) => {
      const key = candidate.trim().toUpperCase();
      const r = await candidates.judge(key, {
        about,
        duration,
        verdicts: verdicts.map((v) => ({ id: v.id, verdict: v.verdict, about: v.observation_about, rest: v.rest })),
        adds,
        withdrawReason: withdraw_reason,
      });
      if (!r.ok) {
        tally?.({ refused: 1 });
        return fail(r.text);
      }
      if (r.withdrawn) tally?.({ withdrawn: [`${r.withdrawn.key}: ${r.withdrawn.reason}`] });
      if (r.applied) {
        const saved = [...(r.applied.saved ? [r.applied.saved] : []), ...r.applied.rests.map((x) => x.id)];
        tally?.({ memories: saved, superseded: r.applied.superseded, rests: r.applied.rests.map((x) => x.id) });
      }
      return ok(r.text);
    },
  );
}
