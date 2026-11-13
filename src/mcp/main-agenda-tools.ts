/**
 * 비서 MCP 서버의 주요 현안 도구: set_main_agenda(한 줄 넣기·고치기·빼기)와 list_main_agenda(주요 현안·이력 보기). 주요 현안은 진행 중·사용자 차례·보류·운영 중인 안건의 목록이다.
 */
import { z } from 'zod';
import { fail, ok, type ToolContext } from './tool-common.ts';
import { MAIN_AGENDA_LIMITS, MAIN_AGENDA_STATES, renderMainAgenda } from '../store/store.ts';
import { formatLocal } from '../core/kst-time.ts';

/** set_main_agenda, list_main_agenda. */
export function registerMainAgendaTools({ server, store, tally }: ToolContext): void {
  const mainAgendaBoard = () => {
    const rows = store.mainAgenda();
    return rows.length ? renderMainAgenda(rows, { ids: true }) : '(주요 현안이 비어 있음)';
  };

  server.registerTool(
    'set_main_agenda',
    {
      description:
        '주요 현안(진행 중·사용자 차례·보류·운영 중인 안건)의 한 줄을 넣거나 고치거나 뺀다(나머지 줄은 그대로, 바뀔 때마다 이력이 남는다). 안건이 시작되거나, 사용자 차례로 넘어가거나, 보류·운영 시작·끝남이 되면 그 자리에서 부른다. ' +
        `주요 현안에서 빼려면 state를 끝남(다 함) 또는 지움(잘못 넣었거나 이름을 바꿈)으로 준다. 이름을 바꾸려면 옛 이름을 지움으로 두고 새 이름으로 넣는다. 상한: ${MAIN_AGENDA_LIMITS.active}개, ${MAIN_AGENDA_LIMITS.boardChars}자.`,
      inputSchema: {
        name: z.string().min(1).describe(`안건 이름 (${MAIN_AGENDA_LIMITS.nameChars}자 안, 고칠 때는 주요 현안의 이름 그대로)`),
        state: z.enum(MAIN_AGENDA_STATES).describe('진행 중 · 사용자 차례 · 보류 · 운영 중(완전 자동화로 수익을 내거나 외부에 서비스하는 것만) · 끝남 · 지움'),
        note: z.string().optional().describe(`괄호에 넣을 짧은 메모 (${MAIN_AGENDA_LIMITS.noteChars}자 안). 보류면 다시 살릴 조건. 비우면 메모 없음`),
        source_log_id: z.number().int().optional().describe('근거가 된 대화 로그 id (상황판의 #1234)'),
        seen_id: z.number().int().optional().describe('주요 현안에 있는 줄을 고칠 때 필수: 내가 본 그 줄 앞의 [#번호]. 그 사이 다른 쪽이 고쳤으면 거부된다(새로 넣는 일은 비움)'),
      },
    },
    async ({ name, state, note, source_log_id, seen_id }) => {
      const row = store.setMainAgenda({ name, state, note, sourceLogId: source_log_id, seenId: seen_id });
      if (row) tally?.({ agenda: [row.name] });
      return ok(`${row ? `주요 현안 고침: ${row.name} → ${row.state}` : `바뀐 것 없음: ${name}`}
${mainAgendaBoard()}`);
    },
  );

  server.registerTool(
    'list_main_agenda',
    {
      description: '주요 현안(진행 중·사용자 차례·보류·운영 중인 안건)을 보여 준다(세션 시작 때 이미 주입되므로 보통은 불필요). name을 주면 그 일의 상태 이력을 보여 준다.',
      inputSchema: { name: z.string().optional().describe('이력을 볼 안건 이름') },
    },
    async ({ name }) => {
      if (!name) return ok(mainAgendaBoard());
      const rows = store.mainAgendaHistory(name);
      if (rows.length === 0) return fail(`이 이름의 안건이 없어요: ${name}`);
      return ok(rows.map((r) => `${formatLocal(r.created_at)} ${r.state}${r.note ? ` (${r.note})` : ''}${r.source_log_id ? ` #${r.source_log_id}` : ''}`).join('\n'));
    },
  );
}
