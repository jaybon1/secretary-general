/**
 * Folders for delegated work. A workspace is a reusable folder (the shared quick
 * folder, a solo worker's, or a team's) whose AGENTS.md is its charter (CLAUDE.md only imports it, so any CLI reads the same rules) and whose
 * .claude/agents/ holds the team. Output is grouped by product: the one live copy
 * of a product sits in output/products/<product>/ and each task edits it in place,
 * while the task's own folder (brief, REPORT.md, test results, packages) is
 * output/records/<product>/<date>-<name>/, or output/research/<date>-<name>/ for
 * experiments that belong to no product.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, WORKSPACE_ROOT } from './config.ts';
import type { WorkspaceKind } from './store.ts';
import { formatLocal, nowIso } from './text.ts';

export const REPORT_FILE = 'REPORT.md';
export const TASK_FILE = 'TASK.md';
export const OUTPUT_DIR = 'output';
export const PRODUCTS_DIR = 'products';
export const RECORDS_DIR = 'records';
export const RESEARCH_DIR = 'research';
/** The workspace's running log across tasks; quick has none since its tasks are unrelated. */
export const HISTORY_FILE = 'notes/history.md';
/** Claude Code reads CLAUDE.md, other CLIs read AGENTS.md; keep the rules in AGENTS.md only. */
export const CLAUDE_IMPORT = '@AGENTS.md\n';

/** The one shared folder for small jobs that don't deserve a workspace of their own. */
export const QUICK_NAME = 'quick-outputs';

/** Folder and role names become paths and agent ids, so keep them plain. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AgentSpec {
  name: string;
  /** When the lead should hand work to this role. */
  description: string;
  prompt: string;
  model?: string;
  effort?: string;
  tools?: string[];
}

export type CodeScale = 'small' | 'medium' | 'large';

export interface WorkspaceSpec {
  kind: WorkspaceKind;
  name: string;
  title: string;
  /** What kind of work this folder takes on, so later tasks can be matched to it. */
  purpose: string;
  /** Lasting context for every task here; per-task context goes in the task brief. */
  context?: string;
  /** Code workspaces get the "코드를 쓸 때" rules; others skip them to save tokens every session. */
  code?: boolean;
  /** Code workspaces only; adds rules on top of the small (default) set. */
  scale?: CodeScale;
  /** Commands every task here runs before reporting; empty until the first tasks show what works. */
  verify?: string[];
  agents?: AgentSpec[];
  /** Only when the user named a location; defaults to WORKSPACE_ROOT. */
  parentDir?: string;
}

export interface TaskSpec {
  name: string;
  title: string;
  goal: string;
  /** The few memory lines the worker needs, never the whole store. */
  context?: string;
  doneCriteria: string[];
  /** What to run and what it must show for the task to count as done. */
  proof: string[];
  risks?: string[];
  /** The product this task builds or changes; none means research. */
  product?: string;
  /** The worker writes plan.md and waits for approval before changing anything. */
  planFirst?: boolean;
  /** Test files are off limits (worker-guard.mjs enforces it when started with -LockTests). */
  lockTests?: boolean;
}

export const QUICK_SPEC: WorkspaceSpec = {
  kind: 'quick',
  name: QUICK_NAME,
  title: '간단한 결과물 모음',
  purpose: '따로 작업 공간을 만들 만큼 크지 않은 작은 일(파일 한두 개로 끝나는 일)을 처리하고 결과를 모아 두는 공용 공간.',
};

export function createWorkspaceFolder(spec: WorkspaceSpec, now = nowIso()): { folder: string; files: string[] } {
  checkSlug(spec.name, '공간 이름');
  const agents = spec.kind === 'team' ? (spec.agents ?? []) : [];
  if (spec.kind === 'team' && agents.length === 0) throw new Error('팀 공간에는 역할이 하나 이상 필요합니다.');
  if (spec.kind !== 'team' && spec.agents?.length) throw new Error('역할은 팀 공간에만 둘 수 있습니다.');
  if (spec.scale && !spec.code) throw new Error('규모(scale)는 코드 공간(code: true)에만 정할 수 있습니다.');
  const names = new Set<string>();
  for (const a of agents) {
    checkSlug(a.name, '에이전트 이름');
    if (names.has(a.name)) throw new Error(`에이전트 이름이 겹칩니다: ${a.name}`);
    names.add(a.name);
  }

  const parent = path.resolve(spec.parentDir ?? WORKSPACE_ROOT);
  if (!fs.existsSync(parent)) throw new Error(`상위 폴더가 없습니다: ${parent}`);
  if (isInside(parent, PROJECT_ROOT)) throw new Error('작업 공간은 비서 폴더 안에 만들 수 없습니다.');

  const base = spec.kind === 'quick' ? spec.name : `${spec.name}-${compactDate(now)}`;
  const folder = freePath(path.join(parent, base));
  fs.mkdirSync(folder);
  const files: string[] = [];
  const write = (rel: string, content: string) => writeNew(folder, rel, content, files);
  write('AGENTS.md', renderCharter(spec));
  write('CLAUDE.md', CLAUDE_IMPORT);
  for (const a of agents) write(path.join('.claude', 'agents', `${a.name}.md`), renderAgent(a));
  if (spec.kind !== 'quick') write(HISTORY_FILE, renderHistory(spec));
  write('.gitignore', GITIGNORE);
  fs.mkdirSync(path.join(folder, OUTPUT_DIR));
  initGit(folder);
  return { folder, files };
}

/** Big or rebuildable things stay out of the workspace's local history. */
export const GITIGNORE = ['.venv/', 'venv/', 'node_modules/', '__pycache__/', '*.zip', '*.onnx', '*.tflite', '*.bin', ''].join('\n');

/** Each workspace is a local git repo so a worker's bad write can be rolled back; workers commit once per task. */
function initGit(folder: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' });
  try {
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', '공간 만들기');
  } catch {
    // No git or no identity: the workspace still works, just without history.
  }
}

/**
 * Creates the task folder with its TASK.md: output/records/<product>/<date>-<name>/,
 * or output/research/<date>-<name>/ without a product. Also makes sure
 * output/products/<product>/ exists. Returns the dir relative to the workspace.
 */
export function createTaskFolder(workspaceFolder: string, task: TaskSpec, now = nowIso()): { outputDir: string; files: string[] } {
  checkSlug(task.name, '업무 이름');
  if (task.product !== undefined) checkSlug(task.product, '제품 이름');
  if (task.doneCriteria.length === 0) throw new Error('완료 기준이 하나 이상 필요합니다.');
  if (task.proof.length === 0) throw new Error('증거가 하나 이상 필요합니다.');
  if (!fs.existsSync(workspaceFolder)) throw new Error(`작업 공간 폴더가 없습니다: ${workspaceFolder}`);

  const base = task.product ? path.join(OUTPUT_DIR, RECORDS_DIR, task.product) : path.join(OUTPUT_DIR, RESEARCH_DIR);
  if (task.product) fs.mkdirSync(path.join(workspaceFolder, OUTPUT_DIR, PRODUCTS_DIR, task.product), { recursive: true });
  const dir = freePath(path.join(workspaceFolder, base, `${compactDate(now)}-${task.name}`));
  fs.mkdirSync(dir, { recursive: true });
  const outputDir = toPosix(path.relative(workspaceFolder, dir));
  const files: string[] = [];
  writeNew(workspaceFolder, path.join(outputDir, TASK_FILE), renderTaskBrief(task), files);
  return { outputDir, files };
}

/**
 * Where a workspace recorded at `stored` lives now. The secretary may have been
 * moved to another computer or folder with its database, leaving absolute paths
 * that no longer exist; the folder keeps its name beside the secretary, so look
 * for it under `root`. Null when it is in neither place.
 */
export function locateWorkspaceFolder(stored: string, root = WORKSPACE_ROOT): string | null {
  if (fs.existsSync(stored)) return stored;
  const moved = path.join(root, path.basename(stored));
  return fs.existsSync(moved) ? moved : null;
}

/** The worker's report for a task, if it has written one. */
export function readReport(workspaceFolder: string, outputDir: string): string | null {
  const file = path.join(workspaceFolder, outputDir, REPORT_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Adapted from DietrichGebert/ponytail (MIT): the smallest complete change. */
export const CODE_RULES = [
  '## 코드를 쓸 때 (ponytail 원칙, MIT)',
  '',
  '- 먼저 고칠 코드를 읽고, 변경이 닿아야 할 곳(호출부, 테스트, 픽스처, 설정, export)과 깨질 것(지워지거나 새는 데이터, 멈추는 호출부)을 적는다. 이것만 범위다.',
  '- 다음 순서로 처음 되는 방법을 쓴다: 꼭 필요한가 → 이 코드베이스에 이미 있나(주변 코드처럼 쓴다) → 표준 라이브러리·플랫폼 기능 → 이미 설치된 의존성 → 한눈에 읽히는 한 줄 → 동작하는 최소한. 몇 줄 때문에 의존성을 새로 넣지 않는다. 모호한 요청에는 핵심만 하는 가장 작은 판을 만든다.',
  '- 요청받지 않은 기능·옵션·추상화·래퍼·설정·"나중을 위한" 코드는 만들지 않는다. 더하기보다 지우기를 고르고, 기존 구조와 관례를 따른다.',
  '- 해법은 게으르게, 변경은 끝까지: 깨지는 호출부·테스트·픽스처까지 마무리한다. 버그는 호출부를 모두 grep한 뒤 공유 코드의 원인 한 곳을 고친다. 옮기거나 합친 코드는 오류 처리와 검증을 유지한다.',
  '- 크기가 같으면 엣지 케이스에 맞는 쪽을 고른다. 주석은 코드가 보여 주지 못하는 이유만 한 줄로 단다.',
  '- 분기·반복·파싱·돈·보안이 들어간 새 로직이나 새 스크립트에는 작은 테스트나 assert 하나를 붙인다. 사소한 변경에는 붙이지 않는다.',
  '- 알고 줄인 곳에는 `shortcut: <한계>, <언제 고칠지>` 주석을 단다.',
  '- 줄이지 않는 것: 신뢰 경계의 입력 검증, 데이터 손실을 막는 오류 처리, 보안, 접근성, 요청받은 것.',
  '- 뺀 것, 확인 못 한 것, 사용자가 알아야 할 위험은 보고서 "남은 일"에 적는다.',
  '',
];

/** Extra rules by size; ideas from cursor/plugins pstack (MIT): blast-radius, create-verification-skill, correct. */
const MEDIUM_RULES = [
  '- 이 공간의 `verify` 명령(린트·타입·단위 테스트·빌드를 한 번에)이 아직 없으면 첫 업무에서 만들고, 아래 "검증"에 쓰도록 보고서 "다음엔"에 제안한다.',
  '- 공유 코드·설정을 고치기 전에 영향 범위를 적고, 그 범위의 호출부를 실제로 실행해(테스트, 화면, 스크립트) 깨지지 않았음을 보인다.',
  '- 화면이 있으면 Playwright CLI가 설치돼 있을 때 스크린샷과 핵심 흐름 E2E 몇 개로 확인한다.',
  '- API 계약(OpenAPI·공유 타입)이 걸린 기능은 계약을 먼저 정하고 구현한다.',
  '- 업무마다 로컬 브랜치(`git switch -c task/<업무 폴더 이름>`)에서 일한다. "끝낼 때"의 커밋은 이 브랜치에서 하고, 검증을 통과했으면 `git switch main`과 `git merge --no-ff task/<업무 폴더 이름>`으로 합친다. 통과하지 못했으면 합치지 않고 보고서에 적는다.',
];
const LARGE_RULES = [
  '- 도메인 용어는 `GLOSSARY.md`에 두고, 새 용어를 쓰기 전에 확인하고 갱신한다.',
  '- 기능 변경은 스펙 도구 하나(이 공간에서 정한 것)로 변경 제안을 먼저 쓴다. notes/history.md는 결정 기록으로만 쓴다.',
  '- 같은 실수가 두 번 나오면 문서 규칙보다 구조·타입·린트·테스트로 막는 방법을 보고서 "다음엔"에 제안한다.',
  '- 서로 독립적인 모듈 작업은 모듈별 git worktree에서 나눠 하고, 커밋은 작게 나눈다(Conventional Commits).',
];

export function renderCodeRules(scale: CodeScale = 'small'): string[] {
  if (scale === 'small') return CODE_RULES;
  const extra = scale === 'large' ? [...MEDIUM_RULES, ...LARGE_RULES] : MEDIUM_RULES;
  return [...CODE_RULES, `### ${scale === 'large' ? '대규모' : '중규모'} 공간`, '', ...extra, ''];
}

/** Adapted from Anthropic's AI-native SDLC playbook (plan mode → plan.md, approved before any change). */
export const PLAN_FIRST_RULE =
  `- \`${TASK_FILE}\`에 "계획 먼저: 예"가 있으면, 파일을 고치기 전에 관련 코드·자료만 읽고 업무 폴더에 \`plan.md\`(바뀌는 파일, 작업 순서, 위험, 증거)를 쓴 뒤 \`[질문] 계획 승인\`으로 멈춘다. 승인받으면 그 계획대로 하고, 계획과 달라지면 다시 묻는다.`;

/** Playbook "Give Claude a feedback loop": no "done" without pasted output, and fix the code, not the test. */
export function renderVerify(verify: string[] | undefined, quick: boolean): string[] {
  const commands = verify?.length
    ? verify.map((v) => `- \`${v}\``)
    : ['- (아직 정하지 않음: 이번 업무에서 직접 돌린 확인을 적고, 이 공간의 검증 명령으로 쓸 만하면 보고서 "다음엔"에 제안한다.)'];
  const checker = quick
    ? []
    : [
        '- 확인 담당: 보고서를 쓰기 전에 Agent 도구로 확인 담당 보조 에이전트를 부른다. 결과물·코드를 확인하면 sonnet, 숫자·결론만 점검하면 haiku. 지시 첫 줄은 "고치지 말고 보고만 하라"이고, TASK.md·보고서 초안·결과 폴더 경로를 준다. 확인 담당은 증거와 검증 명령을 직접 실행하고, 완료 기준을 하나씩 대조하고, 숫자·결론이 있으면 기준(템플릿·키워드·임계값 등)을 만든 자료로 평가하지 않았나, 이름 붙인 요소가 실제로 그것인가, 숫자가 실제 실행 출력에 있나를 확인한다. "이 입력이면 이렇게 틀린다"는 구체적 사례가 없으면 지적하지 않고, 한계를 적은 `shortcut:` 주석은 결함이 아니라 결정으로 본다(예상 부하가 그 한계를 넘을 때만 지적). 지적은 혼자 판단해 닫지 말고, 지적과 처리 결과를 보고서에 그대로 적는다.',
      ];
  return [
    '## 검증',
    '',
    `보고하기 전에 아래 검증 명령과 \`${TASK_FILE}\`의 "증거"를 직접 실행하고, 명령과 출력(길면 끝부분)을 \`${REPORT_FILE}\`에 붙인다. 출력 없이 "됐다"고 쓰지 않는다.`,
    '',
    ...commands,
    '- 검증이나 테스트가 실패하면 테스트가 아니라 코드를 고친다. 테스트가 틀렸다고 보이면 고치지 말고 `[질문]`으로 묻는다.',
    ...checker,
    '',
  ];
}

export function renderCharter(spec: WorkspaceSpec): string {
  const agents = spec.kind === 'team' ? (spec.agents ?? []) : [];
  const team = agents.length
    ? [
        '## 팀',
        '',
        '이 공간에는 역할별 에이전트가 있다(`.claude/agents/`). 업무를 받은 세션은 팀장으로서 일을 나누고, Agent 도구로 맞는 역할에 맡기고, 결과를 모아 확인한다.',
        '',
        ...agents.map((a) => `- \`${a.name}\`: ${oneLine(a.description)}`),
        '',
      ]
    : spec.kind === 'solo'
      ? [
          '## 혼자 맡는 방식',
          '',
          '이 공간의 업무는 업무를 받은 세션이 기획부터 결과물까지 혼자 한다. 직무별 역할로 나누지 않는다.',
          '',
          '- 필요하면 그 자리에서 Agent 도구로 보조 에이전트를 잠깐 불러 쓴다: 만든 것을 따로 검증할 때(테스트, 출처 확인), 단순 반복을 값싼 모델(haiku)로 넘길 때, 일이 한 세션에 담기 어려울 만큼 클 때.',
          '- 보조 에이전트에는 그 일에 필요한 것만 넘기고, 결과는 직접 확인한 뒤 쓴다.',
          '',
        ]
      : [];
  const context = spec.context?.trim() ? ['## 알아둘 맥락', '', spec.context.trim(), ''] : [];
  const code = spec.code ? renderCodeRules(spec.scale) : [];
  const hasHistory = spec.kind !== 'quick';
  const readHistory = hasHistory
    ? [`- 시작하기 전에 \`${HISTORY_FILE}\`의 "현재 상태"를 읽는다. 지난 업무의 자세한 기록이 필요할 때만 아래 항목을 읽는다.`]
    : [];
  const writeHistory = hasHistory
    ? [
        `보고서를 쓴 뒤 \`${HISTORY_FILE}\`에 이 업무 항목을 맨 아래에 추가한다(업무 폴더 밖이지만 이 파일은 고쳐도 된다).`,
        '',
        '- 제목: `## <날짜> · <업무 제목> (`<업무 폴더 경로>`)`',
        '- 시도한 것, 핵심 숫자, 결론을 몇 줄로. 확인하지 않은 것은 "추정"으로 표시한다.',
        '- 결정은 되돌리기 어렵고, 나중에 보면 이유가 놀랍고, 실제 대안을 비교해 고른 것만 `[결정]`으로 남긴다(고른 것, 버린 대안, 이유를 한 줄씩). 셋 중 하나라도 아니면 적지 않는다.',
        '- 이번 업무가 지난 항목의 결과를 뒤집었으면 그 항목 맨 앞에 `[정정 <날짜>] <무엇이 왜 틀렸는지>` 한 줄을 단다. 지난 항목의 나머지와 지난 보고서는 고치지 않는다.',
        '- 맨 위 "현재 상태"(지금까지 최선, 남은 문제, 보류 중이면 다시 살릴 조건)를 이번 결과에 맞게 고친다. 몇 줄로 유지한다.',
        '',
      ]
    : [];
  return [
    `# ${spec.title}`,
    '',
    '이 폴더는 개인 비서가 일을 맡기는 작업 공간이다. 업무는 여러 번 들어오고, 세션 하나가 업무 하나를 맡는다.',
    '',
    '## 이 공간이 하는 일',
    '',
    spec.purpose.trim(),
    '',
    ...context,
    ...team,
    '## 업무를 받으면',
    '',
    `- 결과물은 제품별로 둔다. 제품 본체(지금 쓰는 최신본 하나)는 \`${OUTPUT_DIR}/${PRODUCTS_DIR}/<제품>/\`, 업무 폴더는 \`${OUTPUT_DIR}/${RECORDS_DIR}/<제품>/<YYYYMMDD>-<업무이름>/\`, 제품이 아닌 실험·조사는 \`${OUTPUT_DIR}/${RESEARCH_DIR}/<YYYYMMDD>-<업무이름>/\`다. 업무 폴더 안의 \`${TASK_FILE}\`가 지시서이고, 세션을 시작할 때 어느 업무인지 알려 준다.`,
    ...readHistory,
    PLAN_FIRST_RULE,
    '- 제품 업무는 그 제품 폴더를 제자리에서 고친다(버전마다 사본을 만들지 않는다, 이전 버전은 git 기록으로 남는다). 보고서·시험 결과·배포본(zip 등)은 업무 폴더에 둔다. 다른 제품 폴더와 다른 업무 폴더는 참고만 하고 고치지 않는다.',
    '- 여러 업무가 함께 쓸 자료(공용 템플릿, 스타일 등)를 이 공간에 새로 두거나 고쳐야 하면 먼저 묻는다.',
    '',
    '## 일하는 방식',
    '',
    '- 이 공간 폴더 밖은 읽기만 한다.',
    '- 방향을 바꿔야 하거나 완료 기준을 지킬 수 없으면, 추측으로 진행하지 말고 묻는다.',
    '- 비용이 들거나 되돌릴 수 없는 일(결제, 외부 발송, 공개 게시, 삭제)은 확인 없이 하지 않는다.',
    '- 비밀번호·API 키 같은 민감정보를 파일에 쓰지 않는다.',
    '- 같은 실행을 여러 번 되풀이하는 시험·실측(특히 안에서 `claude -p` 같은 AI를 부르는 것)은 먼저 1~3회만 돌려 회당 토큰·비용·시간을 재고, 전체 횟수로 곱한 예상치를 적어 `[질문]`으로 멈춘다. 승인받은 뒤에 나머지를 돌린다.',
    `- 병렬: \`${TASK_FILE}\`에 병렬 처리가 허용돼 있으면(개수 포함), 서로 독립적인 같은 종류의 일을 보조 에이전트 여러 개에 한 번에 맡기되 적힌 개수를 넘지 않는다. 허용이 없으면 차례로 한다.`,
    '- 파일 충돌 막기: 병렬로 맡긴 보조 에이전트마다 쓸 하위 폴더나 파일명을 미리 정해 주고(예: `parts/03-<이름>/`), 그 밖에는 쓰지 못하게 한다. 앞 결과를 받아 되풀이하는 작업은 회차마다 번호 붙인 새 폴더·파일(예: `round-02/`)에 쓰고 앞 회차 결과를 덮어쓰지 않는다. 합친 결과물과 보고서는 업무를 받은 세션만 쓴다.',
    '- 날짜·시각은 한국시간(KST)으로 쓴다. Windows의 Git Bash에는 시간대 자료가 없어 `TZ=Asia/Seoul date`가 UTC를 내므로, `TZ=KST-9 date`나 PowerShell `Get-Date`로 확인한다.',
    '- PowerShell로 파일을 쓸 때는 `-Encoding utf8`을 붙인다(`Set-Content`·`Out-File` 기본 인코딩은 한글을 깨뜨린다).',
    '- 웹은 검색·페이지 읽기 도구(WebSearch·WebFetch)로 되면 그걸 쓴다. 로그인된 사이트, 클릭·입력, 그 도구로 막히는 페이지에는 Ego Lite가 설치돼 있으면(`ego-browser` 명령이 있으면) Ego Lite를 쓴다: 먼저 `ego-browser skill`을 실행해 출력대로 따른다. 캡차·보안 확인은 풀지 말고 `task.handOff()`로 넘긴 뒤 [질문]으로 알린다.',
    '- 같은 형식을 여러 개 만드는 일은 하나하나 직접 써 내지 말고, 찍어 내는 코드를 만들어 돌린다. 판단이 필요한 부분만 직접 한다.',
    `- 조사에서 Ego Lite로 연 페이지는 근거로 남긴다: \`${path.join(PROJECT_ROOT, 'scripts', 'ego-grab.mjs').replace(/\\/g, '/')}\`의 \`grab\`이 페이지 본문을 txt로 저장한다(사용법은 파일 머리말).`,
    `- 사용자에게 말하는 방식은 \`${TASK_FILE}\`의 "알아둘 맥락"을 따른다.`,
    '',
    ...code,
    ...renderVerify(spec.verify, spec.kind === 'quick'),
    '## 물어볼 때',
    '',
    '질문은 비서가 받아서 직접 답하거나 사용자에게 전달한다. 그래서 다음을 지킨다.',
    '',
    '- 선택창(AskUserQuestion)을 쓰지 않는다. 질문은 대화 글로 쓰고, 그 자리에서 턴을 끝낸다.',
    '- 첫 줄은 `[질문]`으로 시작하고 질문 하나만 쓴다. 이어서 선택지, 추천과 이유, 답을 기다리는 동안 멈춘 작업을 적는다.',
    '- 맥락 없이 읽어도 판단할 수 있게 쓴다. 답하는 쪽은 이 대화를 보지 못했다.',
    '- 답을 받기 전에는 그 질문에 걸린 작업을 진행하지 않는다. 걸리지 않은 작업이 있으면 그것부터 한다.',
    '',
    '## 끝낼 때',
    '',
    `그 업무 폴더에 \`${REPORT_FILE}\`를 쓴다. 비서는 이 파일을 읽고 사용자에게 보고한다.`,
    '',
    '- 결과 요약 (두세 문장)',
    '- 산출물: 만든 파일과 그 용도',
    '- 완료 기준별 충족 여부와 근거',
    '- 검증: 실행한 명령과 출력(위 "검증"), 확인 담당의 지적과 처리 결과',
    '- 작업 중 받은 답과 그에 따른 결정',
    '- 남은 일, 사용자가 결정할 것, 건너뛰거나 확인하지 않은 것과 그 위험',
    '- 다음엔: 이 공간에서 비슷한 업무를 다시 할 때 다르게 할 점. 이 AGENTS.md나 역할 정의(`.claude/agents/`)를 고치자는 제안이면 어느 파일의 무엇을 어떻게 고칠지 적는다. 없으면 "없음".',
    '',
    ...writeHistory,
    '마지막으로 이 공간 폴더에서 `git add -A`와 `git commit -m "<업무 폴더 이름>: <업무 제목>"`으로 한 번 커밋한다(이 PC 안의 기록용, push하지 않는다). 기록을 되돌리는 명령(reset, checkout, revert, restore)은 쓰지 않는다. 되돌려야 하면 보고서에 적는다.',
    '',
    '이 AGENTS.md(CLAUDE.md는 이 파일을 불러오기만 한다)와 역할 정의는 직접 고치지 않는다. 비서가 제안을 사용자에게 확인받고 반영한다.',
    '',
  ].join('\n');
}

export function renderHistory(spec: WorkspaceSpec): string {
  return [
    `# ${spec.title} 기록`,
    '',
    '업무가 끝날 때마다 그 업무 세션이 맨 아래에 항목을 추가한다. 길어지면 비서가 회고 때 오래된 항목을 줄여 정리하자고 제안한다.',
    '',
    '## 현재 상태',
    '',
    '- 아직 끝난 업무가 없다.',
    '',
  ].join('\n');
}

export function renderTaskBrief(task: TaskSpec): string {
  return [
    `# ${task.title}`,
    '',
    '## 목표',
    '',
    task.goal.trim(),
    '',
    '## 알아둘 맥락',
    '',
    task.context?.trim() || '(비서가 넘긴 맥락 없음)',
    '',
    '## 완료 기준',
    '',
    ...task.doneCriteria.map((c) => `- ${c}`),
    '',
    '## 증거',
    '',
    '무엇을 실행하면 무엇이 보여야 끝인지. 보고서에 실행한 명령과 출력을 붙인다.',
    '',
    ...task.proof.map((p) => `- ${p}`),
    '',
    ...(task.product
      ? ['## 제품', '', `제품 본체는 \`${OUTPUT_DIR}/${PRODUCTS_DIR}/${task.product}/\`에 하나만 둔다. 이 업무는 그 폴더를 제자리에서 고친다(비어 있으면 거기에 처음 만든다).`, '']
      : []),
    ...(task.risks?.length ? ['## 위험', '', ...task.risks.map((r) => `- ${r}`), ''] : []),
    ...(task.planFirst || task.lockTests
      ? [
          '## 진행 방식',
          '',
          ...(task.planFirst ? ['- 계획 먼저: 예 (plan.md를 쓰고 `[질문] 계획 승인`으로 멈춘다)'] : []),
          ...(task.lockTests ? ['- 테스트 잠금: 예 (테스트 파일은 고칠 수 없다. 테스트가 틀렸다고 보이면 `[질문]`으로 묻는다)'] : []),
          '',
        ]
      : []),
    '## 결과',
    '',
    task.product
      ? `\`${REPORT_FILE}\`, 시험 결과, 배포본은 이 폴더에 둔다. 제품 본체는 위 제품 폴더에 둔다.`
      : `결과물과 \`${REPORT_FILE}\`는 이 폴더에 둔다.`,
    '',
  ].join('\n');
}

export function renderAgent(a: AgentSpec): string {
  const front = [
    '---',
    `name: ${a.name}`,
    `description: ${oneLine(a.description)}`,
    ...(a.model ? [`model: ${a.model}`] : []),
    ...(a.effort ? [`effort: ${a.effort}`] : []),
    ...(a.tools?.length ? [`tools: ${a.tools.join(', ')}`] : []),
    '---',
  ];
  return `${front.join('\n')}\n\n${a.prompt.trim()}\n`;
}

function checkSlug(name: string, label: string): void {
  if (!SLUG.test(name)) throw new Error(`${label}은 영문 소문자·숫자·하이픈만 쓸 수 있습니다: ${name}`);
}

/** `<base>`, or `<base>-2`, `-3`… if that path already exists. */
function freePath(base: string): string {
  for (let n = 1; ; n++) {
    const p = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(p)) return p;
  }
}

function writeNew(root: string, rel: string, content: string, files: string[]): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx' });
  files.push(toPosix(rel));
}

function isInside(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const compactDate = (iso: string) => formatLocal(iso, true).replaceAll('-', '');
const toPosix = (p: string) => p.replaceAll('\\', '/');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
