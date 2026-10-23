/**
 * Folders for delegated work. A workspace is a reusable folder (the shared quick
 * folder, a solo worker's, or a team's) whose AGENTS.md is its charter (CLAUDE.md only imports it, so any CLI reads the same rules) and whose
 * .claude/agents/ holds the team. Each task gets its own output/<date>-<name>/
 * directory with a TASK.md brief; the worker reports back in REPORT.md there.
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

/** Creates output/<date>-<name>/TASK.md inside a workspace; returns the dir relative to the workspace. */
export function createTaskFolder(workspaceFolder: string, task: TaskSpec, now = nowIso()): { outputDir: string; files: string[] } {
  checkSlug(task.name, '업무 이름');
  if (task.doneCriteria.length === 0) throw new Error('완료 기준이 하나 이상 필요합니다.');
  if (!fs.existsSync(workspaceFolder)) throw new Error(`작업 공간 폴더가 없습니다: ${workspaceFolder}`);

  const dir = freePath(path.join(workspaceFolder, OUTPUT_DIR, `${compactDate(now)}-${task.name}`));
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
  '- 먼저 고칠 코드와 그 코드를 부르는 곳(호출부, 테스트, 설정)을 읽고, 바꾸면 깨질 수 있는 것을 확인한다.',
  '- 다음 순서로 처음 되는 방법을 쓴다: 꼭 필요한가 → 이 코드베이스에 이미 있나 → 표준 라이브러리·플랫폼 기능 → 이미 설치된 의존성 → 한 줄 → 그래도 안 되면 동작하는 최소한. 몇 줄 때문에 의존성을 새로 넣지 않는다.',
  '- 요청받지 않은 기능·옵션·추상화·"나중을 위한" 코드는 만들지 않는다. 뺀 것은 보고서에 한 줄로 적는다. 기존 구조와 관례를 따른다.',
  '- 해법은 게으르게, 변경은 끝까지: 호출하는 곳과 테스트까지 마무리한다. 버그는 원인이 있는 한 곳을 고친다.',
  '- 분기·반복·파싱·돈·보안이 들어간 새 로직에는 작은 테스트나 assert 하나를 붙인다.',
  '- 알고 줄인 곳에는 `shortcut: <한계>, <언제 고칠지>` 주석을 단다.',
  '- 줄이지 않는 것: 입력 검증, 데이터 손실을 막는 오류 처리, 보안, 접근성, 요청받은 것.',
  '',
];

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
  const code = spec.code ? CODE_RULES : [];
  const hasHistory = spec.kind !== 'quick';
  const readHistory = hasHistory
    ? [`- 시작하기 전에 \`${HISTORY_FILE}\`의 "현재 상태"를 읽는다. 지난 업무의 자세한 기록이 필요할 때만 아래 항목을 읽는다.`]
    : [];
  const writeHistory = hasHistory
    ? [
        `보고서를 쓴 뒤 \`${HISTORY_FILE}\`에 이 업무 항목을 맨 아래에 추가한다(업무 폴더 밖이지만 이 파일은 고쳐도 된다).`,
        '',
        '- 제목: `## <날짜> · <업무 제목> (`output/<업무 폴더>`)`',
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
    `- 업무마다 \`${OUTPUT_DIR}/<YYYYMMDD>-<업무이름>/\` 폴더가 있고, 그 안의 \`${TASK_FILE}\`가 지시서다. 세션을 시작할 때 어느 업무인지 알려 준다.`,
    ...readHistory,
    '- 결과물은 그 업무 폴더 안에만 만든다. 다른 업무 폴더는 참고만 하고 고치지 않는다.',
    '- 여러 업무가 함께 쓸 자료(공용 템플릿, 스타일 등)를 이 공간에 새로 두거나 고쳐야 하면 먼저 묻는다.',
    '',
    '## 일하는 방식',
    '',
    '- 이 공간 폴더 밖은 읽기만 한다.',
    '- 방향을 바꿔야 하거나 완료 기준을 지킬 수 없으면, 추측으로 진행하지 말고 묻는다.',
    '- 비용이 들거나 되돌릴 수 없는 일(결제, 외부 발송, 공개 게시, 삭제)은 확인 없이 하지 않는다.',
    '- 비밀번호·API 키 같은 민감정보를 파일에 쓰지 않는다.',
    `- 병렬: \`${TASK_FILE}\`에 병렬 처리가 허용돼 있으면(개수 포함), 서로 독립적인 같은 종류의 일을 보조 에이전트 여러 개에 한 번에 맡기되 적힌 개수를 넘지 않는다. 허용이 없으면 차례로 한다.`,
    '- 파일 충돌 막기: 병렬로 맡긴 보조 에이전트마다 쓸 하위 폴더나 파일명을 미리 정해 주고(예: `parts/03-<이름>/`), 그 밖에는 쓰지 못하게 한다. 앞 결과를 받아 되풀이하는 작업은 회차마다 번호 붙인 새 폴더·파일(예: `round-02/`)에 쓰고 앞 회차 결과를 덮어쓰지 않는다. 합친 결과물과 보고서는 업무를 받은 세션만 쓴다.',
    '- 날짜·시각은 한국시간(KST)으로 쓴다. Windows의 Git Bash에는 시간대 자료가 없어 `TZ=Asia/Seoul date`가 UTC를 내므로, `TZ=KST-9 date`나 PowerShell `Get-Date`로 확인한다.',
    '- PowerShell로 파일을 쓸 때는 `-Encoding utf8`을 붙인다(`Set-Content`·`Out-File` 기본 인코딩은 한글을 깨뜨린다).',
    '- 웹을 볼 때는 Ego Lite를 쓴다: 먼저 `ego-browser skill`을 실행해 출력대로 따른다. 캡차·보안 확인은 풀지 말고 `task.handOff()`로 넘긴 뒤 [질문]으로 알린다.',
    `- 사용자에게 말하는 방식은 \`${TASK_FILE}\`의 "알아둘 맥락"을 따른다.`,
    '',
    ...code,
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
    '- 완료 기준별 충족 여부',
    '- 작업 중 받은 답과 그에 따른 결정',
    '- 남은 일, 사용자가 결정할 것, 건너뛰거나 확인하지 않은 것과 그 위험',
    '- 검증: 숫자·결론으로 다음 결정을 내리는 업무(실험, 비교, 조사)면, 보고서를 쓰기 전에 Agent 도구로 haiku 보조 에이전트를 불러 핵심 숫자와 결론을 점검하게 하고 그 결과를 적는다. 보조 에이전트에는 보고서 초안과 관련 파일 경로를 주고, 파일과 코드를 직접 열어 다음을 확인하게 한다: 기준(템플릿·키워드·임계값 등)을 만든 자료로 평가하지 않았나, 이름 붙인 요소가 실제로 그것인가, 숫자가 실제 실행 출력에 있나. 보조 에이전트의 지적은 혼자 판단해 닫지 말고, 지적과 처리 결과를 그대로 적는다. 그 밖의 업무는 "해당 없음".',
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
    '## 결과',
    '',
    `결과물과 \`${REPORT_FILE}\`는 이 폴더에 둔다.`,
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
