/**
 * 비서 MCP 서버의 큰 일 판 도구: set_big_work(한 줄 넣기·고치기·빼기)와 list_big_work(판·이력 보기).
 */
import { z } from 'zod';
import { fail, ok, type ToolContext } from './common.ts';
import { BIG_WORK_LIMITS, BIG_WORK_STATES, renderBigWork } from '../store/store.ts';
import { formatLocal } from '../core/kst-time.ts';

/** set_big_work, list_big_work. */
export function registerBigWorkTools({ server, store }: ToolContext): void {
  const bigWorkBoard = () => {
    const rows = store.bigWork();
    return rows.length ? renderBigWork(rows, { ids: true }) : '(판이 비어 있음)';
  };

  server.registerTool(
    'set_big_work',
    {
      description:
        '큰 일 판의 한 줄을 넣거나 고치거나 뺀다(나머지 줄은 그대로, 바뀔 때마다 이력이 남는다). 큰 일이 시작되거나, 사용자 차례로 넘어가거나, 보류·운영 시작·끝남이 되면 그 자리에서 부른다. ' +
        `판에서 빼려면 state를 끝남(다 함) 또는 지움(잘못 넣었거나 이름을 바꿈)으로 준다. 이름을 바꾸려면 옛 이름을 지움으로 두고 새 이름으로 넣는다. 상한: 판 ${BIG_WORK_LIMITS.active}개, ${BIG_WORK_LIMITS.boardChars}자.`,
      inputSchema: {
        name: z.string().min(1).describe(`큰 일 이름 (${BIG_WORK_LIMITS.nameChars}자 안, 고칠 때는 판의 이름 그대로)`),
        state: z.enum(BIG_WORK_STATES).describe('진행 중 · 사용자 차례 · 보류 · 운영 중(완전 자동화로 수익을 내거나 외부에 서비스하는 것만) · 끝남 · 지움'),
        note: z.string().optional().describe(`괄호에 넣을 짧은 메모 (${BIG_WORK_LIMITS.noteChars}자 안). 보류면 다시 살릴 조건. 비우면 메모 없음`),
        source_log_id: z.number().int().optional().describe('근거가 된 대화 로그 id (상황판의 #1234)'),
        seen_id: z.number().int().optional().describe('판에 있는 줄을 고칠 때 필수: 내가 본 그 줄 앞의 [#번호]. 그 사이 다른 쪽이 고쳤으면 거부된다(새로 넣는 일은 비움)'),
      },
    },
    async ({ name, state, note, source_log_id, seen_id }) => {
      const row = store.setBigWork({ name, state, note, sourceLogId: source_log_id, seenId: seen_id });
      return ok(`${row ? `큰 일 판 고침: ${row.name} → ${row.state}` : `바뀐 것 없음: ${name}`}
${bigWorkBoard()}`);
    },
  );

  server.registerTool(
    'list_big_work',
    {
      description: '큰 일 판을 보여 준다(세션 시작 때 이미 주입되므로 보통은 불필요). name을 주면 그 일의 상태 이력을 보여 준다.',
      inputSchema: { name: z.string().optional().describe('이력을 볼 큰 일 이름') },
    },
    async ({ name }) => {
      if (!name) return ok(bigWorkBoard());
      const rows = store.bigWorkHistory(name);
      if (rows.length === 0) return fail(`이 이름의 큰 일이 없어요: ${name}`);
      return ok(rows.map((r) => `${formatLocal(r.created_at)} ${r.state}${r.note ? ` (${r.note})` : ''}${r.source_log_id ? ` #${r.source_log_id}` : ''}`).join('\n'));
    },
  );
}
