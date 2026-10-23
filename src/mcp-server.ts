/**
 * MCP server exposing the secretary's memory to Claude Code (stdio transport).
 * Register it via .mcp.json; Claude Code launches it on demand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUDGET, PROJECT_ROOT, WORKSPACE_ROOT } from './config.ts';
import { openDb } from './db.ts';
import { formatMemory, recall } from './recall.ts';
import { semanticClient } from './semantic.ts';
import { MEMORY_KINDS, SUMMARY_MIN_MEMORIES, SUMMARY_SKIP_TOPICS, Store, TASK_STATUSES, type TaskWithWorkspace, type Workspace } from './store.ts';
import { estimateTokens, formatLocal } from './text.ts';
import { QUICK_SPEC, REPORT_FILE, SLUG, TASK_FILE, createTaskFolder, createWorkspaceFolder, locateWorkspaceFolder, readReport } from './workspace.ts';

const store = new Store(openDb());
const { version } = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
const server = new McpServer({ name: 'secretary', version });

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…(+${s.length - max}자)` : s);

server.registerTool(
  'remember',
  {
    description:
      '사용자에 대한 오래 남길 정보를 기억에 저장한다. 한 기억에는 하나의 사실만, 나중에 혼자 읽어도 이해되는 완결된 문장으로 쓴다. ' +
      '기존 기억이 바뀐 경우(이사, 취향 변화, 결정 번복)엔 supersedes에 옛 기억 id를 넣는다 — 옛 기억은 삭제되지 않고 무효 처리된다.',
    inputSchema: {
      kind: z.enum(MEMORY_KINDS).describe('fact 사실 · preference 선호 · decision 결정 · event 일어난 일 · task 할 일 · person 인물 · note 기타 · summary 주제 요약(/consolidate 전용)'),
      content: z.string().min(1).describe('기억할 내용 (한두 문장)'),
      importance: z.number().int().min(1).max(5).optional().describe('1 사소함 ~ 5 매우 중요 (기본 3)'),
      tags: z.array(z.string()).optional().describe('검색용 키워드: 주제 1개(프로젝트명, 사람 이름 등) + 세부 1~2개. 넓은 단어는 피하고, content에는 태그를 쓰지 않는다'),
      supersedes: z.array(z.number().int()).optional().describe('이 기억으로 대체되는 옛 기억 id 목록'),
      valid_from: z.string().optional().describe('사실이 유효해진 시점. 한국시간이면 오프셋 포함 (예: 2026-10-16T20:05+09:00). 기본: 지금'),
      source_log_id: z.number().int().optional().describe('근거가 된 대화 로그 id (/consolidate에서 넣는다). 대화 중 저장은 비워 두면 그 턴에 자동 연결된다'),
    },
  },
  async ({ kind, content, importance, tags, supersedes, valid_from, source_log_id }) => {
    const r = store.remember({ kind, content, importance, tags, supersedes, validFrom: valid_from, sourceLogId: source_log_id });
    return ok(`기억 #${r.id} 저장${r.superseded.length ? ` · 무효 처리: ${r.superseded.map((i) => `#${i}`).join(', ')}` : ''}`);
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
      ids: z.array(z.number().int()).min(1).max(20).optional().describe('번호로 바로 펼칠 기억 (자동 주입의 "생략:" 목록 등). query 대신 쓴다'),
      budget_tokens: z.number().int().min(100).max(BUDGET.recallMax).optional().describe(`결과 토큰 예산 (기본 ${BUDGET.recall})`),
      include_invalid: z.boolean().optional().describe('무효 처리된 옛 기억도 포함 (이력 확인용)'),
    },
  },
  async ({ query, ids, budget_tokens, include_invalid }) => {
    if (ids) {
      const found = ids.map((id) => store.getMemory(id)).filter((m) => m !== undefined);
      store.touch(found.map((m) => m.id));
      const text = found.map(formatMemory).join('\n');
      store.logUsage('recall', estimateTokens(text), { ids: found.map((m) => m.id) });
      const missing = ids.filter((id) => !found.some((m) => m.id === id));
      return found.length ? ok(`${text}${missing.length ? `\n(없는 번호: ${missing.join(', ')})` : ''}`) : fail('그 번호의 기억이 없어요.');
    }
    if (!query) return fail('query나 ids 중 하나가 필요해요.');
    const budget = budget_tokens ?? BUDGET.recall;
    // An explicit recall can wait a little longer for the semantic helper than the per-prompt hook.
    const r = await recall(store, query, { budgetTokens: budget, includeInvalid: include_invalid, semantic: semanticClient(5000) });
    // Only explicit recalls count as use; auto-injection would let a memory keep promoting itself.
    store.touch(r.items.map((i) => i.memory.id));
    store.logUsage('recall', r.tokens, { query, ids: r.items.map((i) => i.memory.id) });
    if (r.items.length === 0) return ok('관련 기억 없음. 원본 대화에서 찾으려면 search_log를 쓰세요.');
    const tail = r.droppedForBudget ? `\n(예산 ${budget}토큰 초과로 ${r.droppedForBudget}개 생략)` : '';
    return ok(`${r.text}${tail}`);
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
  async ({ id, reason }) =>
    store.forget(id, reason) ? ok(`#${id} 무효 처리됨`) : fail(`#${id}: 없거나 이미 무효 처리된 기억`),
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
      `핵심 프로필을 새 버전으로 교체한다. 매 세션 항상 로드되므로 모든 대화에 필요한 것만 담는다: 사용자가 누구인지, 핵심 선호, 진행 중인 큰 일. ` +
      `상한 ~${BUDGET.profileMax} 토큰. 세부 사항은 remember로 기억에 둔다. 전체 내용을 넘겨야 한다 (부분 수정 아님).`,
    inputSchema: {
      content: z.string().min(1).describe('새 프로필 전문 (마크다운)'),
      reason: z.string().min(1).describe('무엇이 왜 바뀌었는지'),
    },
  },
  async ({ content, reason }) => {
    try {
      const p = store.updateProfile(content, reason);
      return ok(`프로필 v${p.version} 저장 (~${p.tokens}/${BUDGET.profileMax} tokens)`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'search_log',
  {
    description:
      '원본 대화 아카이브를 검색한다. 기억에 없는 세부 사항이나 "그때 정확히 뭐라고 했는지" 근거가 필요할 때만 쓴다. ' +
      'memory_id를 주면 그 기억이 나온 대화의 앞뒤를 펼친다 — 기억 문장만으로 답할 수 있으면 펼치지 않는다.',
    inputSchema: {
      query: z.string().min(1).optional(),
      memory_id: z.number().int().optional().describe('이 기억이 나온 대화 앞뒤를 펼침 (query 대신)'),
      limit: z.number().int().min(1).max(30).optional(),
      session_id: z.string().optional(),
    },
  },
  async ({ query, memory_id, limit, session_id }) => {
    if (memory_id !== undefined) {
      const m = store.getMemory(memory_id);
      if (!m) return fail(`기억 #${memory_id}이 없어요.`);
      if (!m.source_log_id) return ok(`기억 #${memory_id}에는 연결된 원문이 없어요(연결 기능 이전 기억). query로 검색하세요.`);
      const n = limit ?? 6;
      const around = store.logAround(m.source_log_id, Math.floor(n / 2), Math.ceil(n / 2));
      return ok(around.map((r) => `[log #${r.id} ${formatLocal(r.created_at)} ${r.role}]\n${clip(r.content, 800)}`).join('\n\n'));
    }
    if (!query) return fail('query나 memory_id 중 하나가 필요해요.');
    const rows = store.searchLog(query, { limit: limit ?? 8, sessionId: session_id });
    if (rows.length === 0) return ok('일치하는 대화 없음');
    return ok(
      rows
        .map((r) => `[log #${r.id} ${formatLocal(r.created_at)} ${r.role} session=${r.session_id.slice(0, 8)}]\n${clip(r.content, 800)}`)
        .join('\n\n'),
    );
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
    for (const r of rows) {
      const block = `[log #${r.id} ${formatLocal(r.created_at)} ${r.role}]\n${clip(r.content, r.role === 'user' ? 2000 : 700)}`;
      const cost = estimateTokens(block);
      if (out.length > 0 && used + cost > budget) break;
      out.push(block);
      used += cost;
      through = r.id;
    }
    const remaining = store.stats().unconsolidated - out.length;
    return ok(`${out.join('\n\n')}\n\nthrough_log_id=${through} · 남은 미정리 ${remaining}건`);
  },
);

server.registerTool(
  'mark_consolidated',
  {
    description: '지정한 로그 id까지 기억 정리를 마쳤다고 기록한다.',
    inputSchema: { through_log_id: z.number().int().min(0) },
  },
  async ({ through_log_id }) => {
    try {
      store.markConsolidated(through_log_id);
      return ok(`log #${through_log_id}까지 정리 완료로 기록`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

// ---- delegation ---------------------------------------------------------------

const slug = z.string().regex(SLUG, '영문 소문자·숫자·하이픈만').max(40);

const KIND_LABEL = { quick: '공용', solo: '담당 1명', team: '팀' } as const;

const formatWorkspace = (w: Workspace & { task_count: number }) =>
  `공간 #${w.id} [${KIND_LABEL[w.kind]}${w.agents ? `: ${w.agents}` : ''}] ${w.title} · 업무 ${w.task_count}건 · ${formatLocal(w.updated_at)} 사용\n` +
  `   하는 일: ${w.purpose}\n   ${w.folder}`;

const formatTask = (t: TaskWithWorkspace) =>
  `업무 #${t.id} [${t.status}] ${t.title} — ${t.workspace_title}(${KIND_LABEL[t.workspace_kind]}) · ${formatLocal(t.updated_at)} 갱신\n` +
  `   ${path.join(t.folder, t.output_dir)}`;

server.registerTool(
  'list_workspaces',
  {
    description:
      '일을 맡길 수 있는 작업 공간(공용 폴더, 담당 1명 공간, 팀 공간) 목록. 위임 계획을 세우기 전에 먼저 보고, ' +
      '하는 일이 맞는 기존 공간이 있으면 새로 만들지 말고 그 공간을 추천한다.',
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
      '맞는 기존 공간이 없고, 사용자가 새 공간 계획을 승인했을 때만 호출한다. 간단한 일은 공간을 만들지 말고 create_task의 quick을 쓴다. ' +
      '폴더는 기본적으로 비서 폴더의 상위 폴더에 <name>-<YYYYMMDD>로 생긴다.',
    inputSchema: {
      kind: z.enum(['solo', 'team']).describe('solo 담당 1명 · team 역할별 팀'),
      name: slug.describe('폴더 이름에 쓰일 공간 이름 (예: web-team)'),
      title: z.string().min(1).describe('공간 이름 (한국어, 예: 웹페이지 제작팀)'),
      purpose: z.string().min(1).describe('이 공간이 맡는 일의 종류. 나중에 비슷한 일을 이 공간에 맡길지 판단하는 기준이 된다'),
      context: z.string().optional().describe('이 공간의 모든 업무에 공통으로 필요한 맥락 (선택)'),
      code: z.boolean().optional().describe('코드를 만드는 공간이면 true: 운영 규칙에 "코드를 쓸 때" 항목이 들어간다 (계획에 적어 승인받는다)'),
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
  async ({ kind, name, title, purpose, context, code, agents, parent_dir }) => {
    try {
      const spec = { kind, name, title, purpose, context, code, agents, parentDir: parent_dir };
      const ws = createWorkspaceFolder(spec);
      const w = store.createWorkspace({ kind, name, title, purpose, folder: ws.folder, agents: (agents ?? []).map((a) => a.name) });
      return ok(`공간 #${w.id} 생성: ${ws.folder}\n만든 파일: ${ws.files.join(', ')}\n다음: create_task로 이 공간에 업무를 맡긴다.`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'create_task',
  {
    description:
      '작업 공간에 업무 하나를 맡긴다: output/<YYYYMMDD>-<name>/ 폴더와 지시서(TASK.md)를 만든다. ' +
      '사용자가 계획을 승인한 뒤에만 호출한다. 기존 공간이면 workspace_id, 간단한 일이면 quick=true(공용 폴더, 없으면 자동 생성). ' +
      '만든 뒤 그 공간 폴더에서 업무 세션을 시작하고 update_task로 기록한다.',
    inputSchema: {
      workspace_id: z.number().int().optional().describe('맡길 공간 id (list_workspaces)'),
      quick: z.boolean().optional().describe('간단한 일을 공용 폴더에 맡길 때 true'),
      name: slug.describe('업무 이름 (결과 폴더 이름에 쓰임, 예: cafe-intro-page)'),
      title: z.string().min(1).describe('업무 제목 (한국어)'),
      goal: z.string().min(1).describe('무엇을 왜 하는지. 담당자가 이것만 읽고 시작할 수 있게'),
      context: z.string().optional().describe('담당자에게 필요한 기억 몇 줄 (사용자 선호, 관련 결정 등). 전체 기억을 넘기지 않는다'),
      done_criteria: z.array(z.string().min(1)).min(1).describe('완료 기준 목록'),
    },
  },
  async ({ workspace_id, quick, name, title, goal, context, done_criteria }) => {
    try {
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
      const tf = createTaskFolder(w.folder, { name, title, goal, context, doneCriteria: done_criteria });
      const t = store.createTask({ workspaceId: w.id, name, title, goal, outputDir: tf.outputDir });
      return ok(
        [
          `업무 #${t.id} 준비됨 — 공간 #${w.id} ${w.title}`,
          `공간 폴더(세션 cwd): ${w.folder}`,
          `결과 폴더: ${tf.outputDir}/ (지시서 ${TASK_FILE})`,
          `세션 지시 예: "${tf.outputDir}/${TASK_FILE}의 업무를 이 폴더의 AGENTS.md 규칙대로 수행하고, 끝나면 같은 폴더에 ${REPORT_FILE}를 써라."`,
          '다음: 업무 세션을 시작하고, update_task로 status=running과 session_ref를 기록한다.',
        ].join('\n'),
      );
    } catch (err) {
      return fail((err as Error).message);
    }
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
    return t ? ok(formatTask(t)) : fail(`업무 #${id} 없음`);
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
    const report = readReport(t.folder, t.output_dir);
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

server.registerTool('stats', { description: '기억 저장소 현황과 최근 7일 주입 토큰량.' }, async () =>
  ok(JSON.stringify(store.stats(), null, 2)),
);

await server.connect(new StdioServerTransport());
