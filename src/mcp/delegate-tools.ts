/**
 * 비서 MCP 서버의 위임 도구: 작업 공간 목록·만들기, 업무 맡기기·상태 기록·목록·보고서 읽기.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT, WORKSPACE_ROOT } from '../core/config.ts';
import { clip, fail, ok, type ToolContext } from './tool-common.ts';
import { MAIN_AGENDA_CHECK, TASK_STATUSES, type TaskWithWorkspace, type Workspace } from '../store/store.ts';
import { formatLocal } from '../core/kst-time.ts';
import { LINK_FILE, QUICK_SPEC, REPORT_FILE, SLUG, TASK_FILE, createTaskFolder, createWorkspaceFolder, locateWorkspaceFolder, readReport, writeLink } from '../workspace/workspace-create.ts';

const slug = z.string().regex(SLUG, '영문 소문자·숫자·하이픈만').max(40);

const KIND_LABEL = { quick: '공용', solo: '담당 1명', team: '팀' } as const;

const formatWorkspace = (w: Workspace & { task_count: number }) =>
  `공간 #${w.id} [${KIND_LABEL[w.kind]}${w.agents ? `: ${w.agents}` : ''}] ${w.title} · 업무 ${w.task_count}건 · ${formatLocal(w.updated_at)} 사용\n` +
  `   하는 일: ${w.purpose}\n   ${w.folder}`;

const formatTask = (t: TaskWithWorkspace) =>
  `업무 #${t.id} [${t.status}] ${t.title} — ${t.workspace_title}(${KIND_LABEL[t.workspace_kind]}) · ${formatLocal(t.updated_at)} 갱신\n` +
  `   ${path.join(t.folder, t.output_dir)}`;

/** list_workspaces, create_workspace, create_task, update_task, list_tasks, get_task. */
export function registerDelegateTools({ server, store }: ToolContext): void {
  server.registerTool(
    'list_workspaces',
    {
      description:
        '일을 맡길 수 있는 작업 공간(공용 폴더, 담당 1명 공간, 팀 공간) 목록. 위임 계획을 세우기 전에 먼저 보고, ' +
        '하는 일이 맞는 기존 공간이 있으면 그 공간을 추천한다.',
    },
    async () => {
      const rows = store.listWorkspaces();
      return ok(rows.length ? rows.map(formatWorkspace).join('\n') : '작업 공간 없음 (공용 폴더는 첫 간단 업무 때 자동으로 생김)');
    },
  );

  server.registerTool(
    'create_workspace',
    {
      description:
        '새 작업 공간(폴더)을 만든다: 운영 규칙(AGENTS.md, CLAUDE.md는 이를 불러오기만 함)과, 팀이면 역할별 에이전트 정의(.claude/agents/). ' +
        '맞는 기존 공간이 없고, 사용자가 새 공간 계획을 승인했을 때만 호출한다. 간단한 일은 create_task의 quick을 쓴다. ' +
        '폴더는 기본적으로 비서 폴더 옆 workspaces 폴더에 <name>-<YYYYMMDD>로 생긴다.',
      inputSchema: {
        kind: z.enum(['solo', 'team']).describe('solo 담당 1명 · team 역할별 팀'),
        name: slug.describe('폴더 이름에 쓰일 공간 이름 (예: web-team)'),
        title: z.string().min(1).describe('공간 이름 (한국어, 예: 웹페이지 제작팀)'),
        purpose: z.string().min(1).describe('이 공간이 맡는 일의 종류. 나중에 비슷한 일을 이 공간에 맡길지 판단하는 기준이 된다'),
        context: z.string().optional().describe('이 공간의 모든 업무에 공통으로 필요한 맥락 (선택)'),
        code: z.boolean().optional().describe('코드를 만드는 공간이면 true: 운영 규칙에 "코드를 쓸 때" 항목이 들어간다 (계획에 적어 승인받는다)'),
        scale: z
          .enum(['small', 'medium', 'large'])
          .optional()
          .describe('code: true일 때만. small(기본, 하루~며칠) · medium(몇 주, verify·영향 범위·로컬 브랜치) · large(몇 달, + 용어 문서·스펙 도구·worktree). 계획에 적어 승인받는다'),
        verify: z.array(z.string().min(1)).optional().describe('업무마다 보고 전에 돌릴 검증 명령 (예: npm test). 아직 모르면 생략'),
        agents: z
          .array(
            z.object({
              name: slug.describe('역할 id (예: designer)'),
              description: z.string().min(1).describe('팀장이 언제 이 역할에 맡기면 되는지'),
              prompt: z.string().min(1).describe('이 역할의 지시문'),
              model: z.string().optional().describe('sonnet · opus · haiku (생략하면 세션 모델)'),
              effort: z.string().optional().describe('low · medium · high · xhigh · max (기준: sonnet high, opus medium, 추론이 깊은 일은 opus high)'),
              tools: z.array(z.string()).optional().describe('허용 도구 (생략하면 전부)'),
            }),
          )
          .optional()
          .describe('team일 때만 (하나 이상)'),
        parent_dir: z.string().optional().describe('사용자가 위치를 직접 지정했을 때만. 절대 경로'),
      },
    },
    async ({ kind, name, title, purpose, context, code, scale, verify, agents, parent_dir }) => {
      const spec = { kind, name, title, purpose, context, code, scale, verify, agents, parentDir: parent_dir };
      const ws = createWorkspaceFolder(spec);
      const w = store.createWorkspace({ kind, name, title, purpose, folder: ws.folder, agents: (agents ?? []).map((a) => a.name) });
      return ok(`공간 #${w.id} 생성: ${ws.folder}\n만든 파일: ${ws.files.join(', ')}\n다음: create_task로 이 공간에 업무를 맡긴다.`);
    },
  );

  server.registerTool(
    'create_task',
    {
      description:
        '작업 공간에 업무 하나를 맡긴다: 업무 폴더(product가 있으면 output/records/<product>/<YYYYMMDD>-<name>/, 없으면 output/research/<YYYYMMDD>-<name>/)와 지시서(TASK.md)를 만든다. ' +
        '사용자가 계획을 승인한 뒤에만 호출한다. 기존 공간이면 workspace_id, 간단한 일이면 quick=true(공용 폴더, 없으면 자동 생성). ' +
        '만든 뒤 그 공간 폴더에서 업무 세션을 시작하고 update_task로 기록한다.',
      inputSchema: {
        workspace_id: z.number().int().optional().describe('맡길 공간 id (list_workspaces)'),
        quick: z.boolean().optional().describe('간단한 일을 공용 폴더에 맡길 때 true'),
        name: slug.describe('업무 이름 (결과 폴더 이름에 쓰임, 예: cafe-intro-page)'),
        title: z.string().min(1).describe('업무 제목 (한국어)'),
        goal: z.string().min(1).describe('무엇을 왜 하는지. 담당자가 이것만 읽고 시작할 수 있게'),
        intent: z.string().optional().describe('의도: 사용자가 왜 이 일을 하려는지, 결과를 어디에 쓰려는지 (지시서 "의도" 칸. 비우면 delegate-check brief가 알린다)'),
        out_of_scope: z.array(z.string().min(1)).optional().describe('범위 밖: 이번에 하지 않을 것 1~3줄 (지시서 "범위 밖" 칸)'),
        user_words: z.string().optional().describe('사용자 원문: 요청한 말 그대로와 대화 번호(#번호), 요약하지 않는다 (지시서 "사용자 원문" 칸). 개인정보를 넣으면 안 되는 공급자면 그 업무에 필요한 말만'),
        context: z.string().optional().describe('담당자에게 필요한 기억 몇 줄만 (사용자 선호, 관련 결정 등)'),
        done_criteria: z.array(z.string().min(1)).min(1).describe('완료 기준 목록'),
        proof: z.array(z.string().min(1)).min(1).describe('완료 확인 방법: 무엇을 실행하면 무엇이 보여야 끝인지 (예: "npm test가 통과", "final.mp4가 60초 이하")'),
        risks: z.array(z.string().min(1)).optional().describe('알려진 위험 (선택)'),
        product: slug.optional().describe('이 업무가 만들거나 고치는 제품 이름 (본체는 output/products/<product>/). 제품이 아닌 실험·조사면 비운다'),
        plan_first: z.boolean().optional().describe('true면 업무 세션이 plan.md를 쓰고 [질문] 계획 승인으로 멈춘다 (새 공간의 첫 업무, 코드 공간에서 기존 코드를 여러 파일 고치는 업무)'),
        lock_tests: z.boolean().optional().describe('true면 테스트 파일 수정을 막는다. start-worker.ps1에 -LockTests도 준다'),
      },
    },
    async ({ workspace_id, quick, name, title, goal, intent, out_of_scope, user_words, context, done_criteria, proof, risks, product, plan_first, lock_tests }) => {
      if ((workspace_id === undefined) === !quick) throw new Error('workspace_id와 quick 중 하나만 지정하세요.');
      let w = workspace_id !== undefined ? store.getWorkspace(workspace_id) : store.quickWorkspace();
      if (!w && quick) {
        const ws = createWorkspaceFolder(QUICK_SPEC);
        w = store.createWorkspace({ ...QUICK_SPEC, folder: ws.folder, agents: [] });
      }
      if (!w) throw new Error(`공간 #${workspace_id} 없음`);
      if (w.archived_at) throw new Error(`공간 #${w.id}은 보관된 공간이에요. list_workspaces에서 맞는 공간을 고르세요.`);
      if (!fs.existsSync(w.folder)) {
        // Recorded on another computer or before the secretary moved.
        const found = locateWorkspaceFolder(w.folder) ?? (w.kind === 'quick' ? createWorkspaceFolder(QUICK_SPEC).folder : null);
        if (!found) throw new Error(`공간 #${w.id} 폴더를 찾지 못했어요: ${w.folder}. 폴더를 이 컴퓨터의 ${WORKSPACE_ROOT}로 옮기거나 새 공간을 만드세요.`);
        w = store.moveWorkspace(w.id, found);
      }
      // The workspace's tools find this secretary in its secretary-link.local.json: written or put right before each task.
      const linked = writeLink(w.folder, PROJECT_ROOT);
      const tf = createTaskFolder(w.folder, {
        name, title, goal, intent, outOfScope: out_of_scope, userWords: user_words, context, doneCriteria: done_criteria, proof, risks, product, planFirst: plan_first, lockTests: lock_tests,
      });
      const t = store.createTask({ workspaceId: w.id, name, title, goal, outputDir: tf.outputDir });
      return ok(
        [
          `업무 #${t.id} 준비됨 — 공간 #${w.id} ${w.title}`,
          `공간 폴더(세션 cwd): ${w.folder}`,
          `업무 폴더: ${tf.outputDir}/ (지시서 ${TASK_FILE})`,
          ...(product ? [`제품 폴더: output/products/${product}/`] : []),
          ...(linked ? [`비서 위치 파일: ${LINK_FILE}을 이 비서로 새로 썼다(공간 도구가 비서의 진입점 폴더(bin)를 찾는 파일, .gitignore에 넣음).`] : []),
          `세션 지시 예: "${tf.outputDir}/${TASK_FILE}의 업무를 이 폴더의 AGENTS.md 규칙대로 수행하고, 끝나면 같은 폴더에 ${REPORT_FILE}를 써라."`,
          '다음: 업무 세션을 시작하고, update_task로 status=running과 session_ref를 기록한다.',
          ...(lock_tests ? ['테스트 잠금: start-worker.ps1에 -LockTests를 준다.'] : []),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'update_task',
    {
      description: '맡긴 업무의 상태를 기록한다. 시작하면 running(+session_ref), 끝나면 done/failed(+result 요약), 중단하면 cancelled.',
      inputSchema: {
        id: z.number().int(),
        status: z.enum(TASK_STATUSES).optional(),
        session_ref: z.string().optional().describe('업무 세션을 다시 찾을 수 있는 id'),
        result: z.string().optional().describe('결과 요약 (보고서 핵심 두세 문장)'),
      },
    },
    async ({ id, status, session_ref, result }) => {
      const t = store.updateTask(id, { status, sessionRef: session_ref, result });
      if (!t) return fail(`업무 #${id} 없음`);
      // A finished task is when a main-agenda item most often moves on; the board is only right if someone looks.
      return ok(status === 'done' || status === 'failed' ? `${formatTask(t)}\n${MAIN_AGENDA_CHECK}` : formatTask(t));
    },
  );

  server.registerTool(
    'list_tasks',
    {
      description: '맡긴 업무 목록 (최근 갱신 순). "그 업무 어떻게 됐어?" 같은 질문에 먼저 쓴다.',
      inputSchema: {
        status: z.enum(TASK_STATUSES).optional(),
        workspace_id: z.number().int().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, workspace_id, limit }) => {
      const rows = store.listTasks({ status, workspaceId: workspace_id, limit });
      return ok(rows.length ? rows.map(formatTask).join('\n') : '맡긴 업무 없음');
    },
  );

  server.registerTool(
    'get_task',
    {
      description: `업무 하나의 상세와 담당자가 쓴 보고서(${REPORT_FILE})를 가져온다. 업무 세션이 끝났다고 알려 오면 이걸로 결과를 확인한다.`,
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      const t = store.getTask(id);
      if (!t) return fail(`업무 #${id} 없음`);
      // Recorded before the workspace folder moved; create_task updates the record, this only reads.
      const report = readReport(locateWorkspaceFolder(t.folder) ?? t.folder, t.output_dir);
      return ok(
        [
          formatTask(t),
          `목표: ${t.goal}`,
          t.session_ref ? `세션: ${t.session_ref}` : null,
          t.result ? `결과 기록: ${t.result}` : null,
          report ? `--- ${REPORT_FILE} ---\n${clip(report, 6000)}` : `(${REPORT_FILE} 아직 없음)`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );
}
