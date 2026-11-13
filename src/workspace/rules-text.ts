/**
 * The rules text a workspace gets: its charter (AGENTS.md), memory and history files, role definitions,
 * and each task's brief. Ego Lite is used only where it is installed (the ego-browser command).
 */
import path from 'node:path';
import { BASIS_GUESS, BASIS_UNABLE } from '../core/basis-forms.ts';
import { ENTRY_DIR, entryPath, secretaryDirEnv } from '../core/paths.ts';
import { COMMON_PREFIX } from './common-skills.ts';
import { PROJECT_ROOT } from '../core/config.ts';
import { readSecretaryId } from '../core/secretary-id.ts';
import {
  HISTORY_DIR,
  HISTORY_FILE,
  MEMORY_FILE,
  MEMORY_LIMIT,
  OUTPUT_DIR,
  PENDING_DIR,
  PRODUCTS_DIR,
  RECORDS_DIR,
  LINK_FILE,
  REPORT_FILE,
  RESEARCH_DIR,
  SANDBOX_NAME,
  SKILLS_DIR,
  STATUS_LIMIT,
  TASK_FILE,
  type AgentSpec,
  type CodeScale,
  type TaskSpec,
  type WorkspaceSpec,
  workspaceRootOf,
} from './workspace-paths.ts';

/**
 * The parts of a charter (and of run-job's folder rules) the secretary keeps, each between a begin and an end mark that
 * name the part. workspace-links (workspace/charter-blocks.ts) writes what is between the marks again from this file's
 * template and leaves everything outside them (the title, what the workspace does, its context, its roles, its check
 * commands, lines the user or an approved proposal added) as it is. HTML comments: Markdown viewers do not show them,
 * and the name says whose the part is and which part it is.
 */
export type CharterBlockId = 'intro' | 'team' | 'solo' | 'start' | 'learning' | 'work' | 'code' | 'code-medium' | 'code-large' | 'verify' | 'ask' | 'finish' | 'run-job';
export const blockBegin = (id: string) => `<!-- secretary:begin ${id} -->`;
export const blockEnd = (id: string) => `<!-- secretary:end ${id} -->`;
/** A begin or end mark line: [1] begin|end, [2] the part's name. */
export const BLOCK_MARK = /^<!-- secretary:(begin|end) ([a-z0-9-]+) -->$/;
/** What a block's text depends on besides the template: whether the workspace keeps history (all but quick) and the secretary. */
export interface CharterContext {
  hasHistory: boolean;
  root: string;
}

/**
 * How a skill is made (agentskills.io, setup/skill-spec.ts checks it): the charter's "스킬과 기억" sentence (renderLearning).
 */
export const SKILL_FORMAT_RULE =
  '새 스킬은 머리말에 name(폴더 이름과 같게, 소문자·숫자·하이픈, `common-`으로 시작하지 않음: 공통 스킬 링크 이름과 겹친다)과 description(무엇을 하고 언제 쓰는지 한 줄)을 넣어 만든다(agentskills.io 사양). SKILL.md는 500줄 미만으로 원칙과 "언제 어느 파일을 읽을지"만 두고, 스킬이 쓰는 코드는 그 폴더의 `scripts/`, 참고 문서는 `references/`, 템플릿·설정·데이터는 `assets/`에 둔다. 남이 만든 설치본·가상환경은 사용자 폴더 `%USERPROFILE%\\tools`에 둔다.';
/**
 * The charter's "물어볼 때" lines on a question's first line and the basis under a pick (the "ask" block). The work
 * session's two forms have no second-opinion line (that is the secretary's).
 */
export const QUESTION_FIRST_RULE = '- 첫 줄은 `[질문]`으로 시작하고 질문 하나만 쓴다. 이어서 선택지, 추천, 답을 기다리는 동안 멈춘 작업을 적는다.';
/**
 * The form for something there that could not be opened: not looking needs no reason, not being able to does, so it
 * carries the reason (answer-checks.ts basis-unopened).
 */
const UNABLE_FORM = `끝내 못 열었을 때만 "근거: ${BASIS_UNABLE}"으로 못 연 까닭까지 쓴다.`;
const basisTail = (unable: string) =>
  ` 근거는 실제로 확인한 것(연 파일, 기록, 명령 출력, 숫자)을 짧게 쓴다. 확인할 자료가 있으면 열어 보고 쓰고, ${unable} 확인할 자료가 원래 없는 짐작(겪어 봐야 아는 일, 취향·직관)이면 "근거: ${BASIS_GUESS}"으로 쓴다. 비서는 이 근거를 열어 맞는지 본 뒤 사용자에게 전한다.`;
const BASIS_PLACE = '"(추천)"을 달고 그 줄 바로 아래(들여쓴 세부 항목이 있으면 그 뒤)에 들여쓴 인용 줄 `> 근거:`';
export const QUESTION_BASIS_RULE = `- 추천한 선택지에는 ${BASIS_PLACE} 하나를 붙인다.${basisTail(UNABLE_FORM)}`;
/**
 * What the work session hands the verifier and what the verifier runs again (the "확인 담당" line of the "verify" block).
 * Until 2026-11-11 the verifier ran every check itself with no settings handed over: in task 159 it ran the repeated runs
 * again (time spent twice) and ran them without the test-folder variable, leaving 11 test images in the product folder.
 */
export const VERIFIER_RUN_RULE =
  'TASK.md·보고서 초안·결과 폴더 경로와 함께, 검증 명령을 돌릴 때 쓴 환경 설정(시험 폴더 환경변수 등, 업무 세션이 쓴 그대로)과 반복 실행·변형 시험의 출력 파일 경로를 준다. 확인 담당은 완료 확인 방법과 검증 명령을 그 환경 설정으로 한 번씩만 직접 돌린다(설정 없이 돌리면 시험 파일이 제품 폴더에 남는다). 반복 실행과 변형 시험(일부러 깨뜨린 복사본 등)은 업무 세션이 남긴 출력 파일과 대조만 한다(다시 돌리면 시간이 두 번 든다).';
/**
 * The end of the charter's Python finding code (findSecretaryCode): with no link file found, this
 * secretary's variable, and a plain message rather than Path(None)'s TypeError when that is empty too.
 */
export function pythonFallbackLines(env: string): string[] {
  return [
    `    d = os.environ.get("${env}")`,
    `    if not d: raise SystemExit("비서 진입점을 못 찾음: 위 폴더들에 비서 위치 파일이 없고 환경변수 ${env}도 비었다(비서에게 workspace-links를 부탁한다)")`,
    `    return Path(d) / "${ENTRY_DIR}"`,
  ];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Adapted from DietrichGebert/ponytail (MIT): the smallest complete change. */
export const CODE_RULES = [
  '## 코드를 쓸 때 (ponytail 원칙, MIT)',
  '',
  '- 먼저 고칠 코드를 읽고, 변경이 닿아야 할 곳(호출부, 테스트, 픽스처, 설정, export)과 깨질 것(지워지거나 새는 데이터, 멈추는 호출부)을 적는다. 이것만 범위다.',
  '- 다음 순서로 처음 되는 방법을 쓴다: 꼭 필요한가 → 이 코드베이스에 이미 있나(주변 코드처럼 쓴다) → 표준 라이브러리·플랫폼 기능 → 이미 설치된 의존성 → 한눈에 읽히는 한 줄 → 동작하는 최소한. 몇 줄 때문에 의존성을 새로 넣지 않는다(의존성 하나마다 설치·업데이트·보안 점검 거리가 는다). 모호한 요청에는 핵심만 하는 가장 작은 판을 만든다.',
  '- 기능·옵션·추상화·래퍼·설정은 요청받은 것만 만든다("나중을 위한" 코드도 같다). 더하기보다 지우기를 고르고, 기존 구조와 관례를 따른다.',
  '- 해법은 게으르게, 변경은 끝까지: 깨지는 호출부·테스트·픽스처까지 마무리한다. 버그는 호출부를 모두 grep한 뒤 공유 코드의 원인 한 곳을 고친다. 옮기거나 합친 코드는 오류 처리와 검증을 유지한다.',
  '- 크기가 같으면 엣지 케이스에 맞는 쪽을 고른다. 주석은 코드가 보여 주지 못하는 이유만 한 줄로 단다.',
  '- 분기·반복·파싱·돈·보안이 들어간 새 로직이나 새 스크립트에만 작은 테스트나 assert 하나를 붙인다.',
  '- 알고 줄인 곳에는 `shortcut: <한계>, <언제 고칠지>` 주석을 단다.',
  '- 줄이지 않는 것: 신뢰 경계의 입력 검증, 데이터 손실을 막는 오류 처리, 보안, 접근성, 요청받은 것(알고 줄인 곳(`shortcut:`)이라도 이것들은 줄이면 사고나 요청 어김이 된다).',
  '- 뺀 것, 확인 못 한 것, 사용자가 알아야 할 위험은 보고서 "남은 일"에 적는다.',
  '',
];

/** Extra rules by size; ideas from cursor/plugins pstack (MIT): blast-radius, create-verification-skill, correct. */
const MEDIUM_RULES = [
  '- 이 공간의 `verify` 명령(린트·타입·단위 테스트·빌드를 한 번에)이 아직 없으면 첫 업무에서 만들고, 아래 "검증"에 쓰도록 보고서 "다음엔"에 제안한다.',
  '- 공유 코드·설정을 고치기 전에 영향 범위를 적고, 그 범위의 호출부를 실제로 실행해(테스트, 화면, 스크립트) 깨지지 않았음을 보인다.',
  '- 화면이 있으면 Playwright CLI가 설치돼 있을 때 스크린샷과 핵심 흐름 E2E 몇 개로 확인한다.',
  '- API 계약(OpenAPI·공유 타입)이 걸린 기능은 계약을 먼저 정하고 구현한다.',
  '- 업무마다 로컬 브랜치(`git switch -c task/<업무 폴더 이름>`)에서 일한다. "끝낼 때"의 커밋은 이 브랜치에서 하고, 검증을 통과했으면 `git switch main`과 `git merge --no-ff task/<업무 폴더 이름>`으로 합친다. 통과하지 못했으면 task 브랜치에 그대로 두고 보고서에 적는다.',
];
const LARGE_RULES = [
  '- 도메인 용어는 `GLOSSARY.md`에 두고, 새 용어를 쓰기 전에 확인하고 갱신한다.',
  `- 기능 변경은 스펙 도구 하나(이 공간에서 정한 것)로 변경 제안을 먼저 쓴다. 결정 기록도 업무 항목과 함께 \`${HISTORY_DIR}/<YYYY-MM>.md\`에 덧붙인다.`,
  '- 같은 실수가 두 번 나오면 문서 규칙보다 구조·타입·린트·테스트로 막는 방법을 보고서 "다음엔"에 제안한다.',
  '- 서로 독립적인 모듈 작업은 모듈별 git worktree에서 나눠 하고, 커밋은 작게 나눈다(Conventional Commits).',
];

const codeBlockId = (scale: CodeScale = 'small'): CharterBlockId => (scale === 'small' ? 'code' : `code-${scale}`);

export function renderCodeRules(scale: CodeScale = 'small'): string[] {
  if (scale === 'small') return CODE_RULES;
  const extra = scale === 'large' ? [...MEDIUM_RULES, ...LARGE_RULES] : MEDIUM_RULES;
  return [...CODE_RULES, `### ${scale === 'large' ? '대규모' : '중규모'} 공간`, '', ...extra, ''];
}

/** Test folders go beside, not inside, any workspace; the reason line keeps sessions from "tidying" them back in. */
const sandboxRule = (root: string) =>
  `- 업무 중 시험용 폴더(빈 환경 흉내, 설치 시험 등)는 \`${path.join(workspaceRootOf(root), SANDBOX_NAME, '<공간폴더이름>-<업무번호>') + path.sep}\`에만 만들고(업무번호를 모르면 업무 폴더 이름을 쓴다), 보고서에 만든 시험 폴더·서버·예약 작업을 모두 적고 지웠는지 적는다. 이유: 위쪽 폴더에 규칙 파일·git이 없어 시험 세션이 다른 규칙을 읽지 않는다.`;

/** Irreversible steps are refused by the auto-permission check when approval arrives relayed from another session. */
export const IRREVERSIBLE_RULE =
  `- 되돌릴 수 없는 단계(파일·자료 삭제, 외부 업로드, 공개 게시)는 다른 작업과 한 명령·한 프로그램에 묶지 않는다. 업무 세션은 시험 실행(dry-run)과 백업·대조까지만 하고, 실행할 명령 한 줄(실행 위치 포함)과 기대 출력을 \`[질문]\`으로 넘긴다. 실행은 비서가 사용자 승인을 받아 한다. 실행 뒤 결과를 확인하고 이어서 마무리한다. 이유: 자동 권한 판단은 다른 세션이 전한 승인을 사용자 승인으로 보지 않아, 업무 세션이 실행하면 막히고 묶인 작업까지 멈춘다.`;

/** Lasting things get a long-term option beside the current one so the user has more to choose from; out-of-scope finds are only reported. */
export const LONGTERM_RULE =
  `- 나중까지 남는 것(이름 짓는 법(키·폴더·파일), 공간·업무 틀, 기억·비서 시스템, 프로그램, 구조)을 만들거나 바꿀 때는 계획(\`plan.md\`·\`[질문]\`)과 보고서에 지금 안 옆에 "장기적 관점의 제안"을 나란히 적는다. 안마다 좋은 점, 지금 비용, 나중에 바꾸는 비용을 붙이고 추천을 표시한다. 두 안이 같으면 "장기적 관점으로 봐도 같음" 한 줄로 끝낸다. 맡은 범위 밖에서 본 더 나은 구조는 보고서 "개선 후보"에 적기만 한다.`;
/**
 * What the worker settled without asking (2026-11-13 the user's call): a guess that fills a gap in the brief
 * goes quiet otherwise, and the user finds it only when the result is off. The secretary shows these lines one by one.
 */
export const ASSUMED_REPORT = '- 묻지 않고 대신 정한 것·가정: 지시서에 없어 짐작으로 정한 것마다 무엇을, 왜 그렇게, 틀리면 무엇이 바뀌는지 한 줄씩. 없으면 "없음".';

export const LONGTERM_REPORT = [
  '- 장기적 관점의 제안: 나중까지 남는 것을 만들거나 바꿨으면 지금 안과 장기적 관점의 안(좋은 점, 지금 비용, 나중에 바꾸는 비용, 추천). 같으면 "장기적 관점으로 봐도 같음", 해당 없으면 "해당 없음".',
  '- 개선 후보: 맡은 범위 밖에서 본 더 나은 구조(제안만). 없으면 "없음".',
];

/**
 * Repeated work is done by a tool or script, checked at three points: before starting, after the first few items, and at
 * the end. "하나씩 직접 되풀이" and not a word that hides who does it: a smaller model can read that as "a person does it" (2026-11-07).
 */
export const REPEAT_RULES = [
  '- 많은 자료를 하나씩 열어 읽거나 같은 조작을 여러 번 되풀이할 일(예: 메일 수백 통을 브라우저로 하나씩 열기)은 도구·스크립트로 만들어 한꺼번에 처리한다. 아래 세 때에 따지고, 그렇게 할지 애매하면 `[질문]`으로 묻는다.',
  `  - 시작 전: 목적(이 업무로 무엇을 얻으려는지), 규모(먼저 센다: 몇 건인지, 하나씩 직접 하면 얼마나 걸리는지, 다음 업무에서도 할 일인지), 길(하나씩 직접 하는 길과 한꺼번에 하는 길: 내보내기, 공식 API, 프로그램, 이미 있는 도구)을 본다. \`${TASK_FILE}\`가 방법을 정하지 않았으면 나은 길을 고른다. 방법까지 정했으면 그대로 하되, 훨씬 나은 길이 있으면 시간 차이를 숫자로 붙여 보고서에 제안하고, 차이가 커서 완료 기준을 지키기 어려우면 \`[질문]\`으로 묻는다.`,
  '  - 도중: 처음 몇 건을 해 본 뒤 "한 건 시간 × 남은 건수"로 전체 시간을 계산하고, 너무 길거나 같은 조작을 되풀이하고 있으면 멈추고 방법을 바꾼다. 같은 조작이 한 턴에 여러 번 되풀이되면 훅이 `[반복 작업 알림]`으로 알린다.',
  '  - 끝난 뒤: 다음에 또 할 일이면 만든 도구를 이 공간에 남기고 쓰는 법을 공간 스킬에 적는다.',
  '  - 이번 업무는 한 번뿐이어도 이 공간에 같은 종류 업무가 계속 들어와 같은 단계를 되풀이하게 되면(예: 영상 편마다 같은 단계) 보고서 "되풀이 단계"에 적는다.',
];
export const REPEAT_REPORT =
  '- 되풀이 단계: 도구·스크립트로 만들지 않아 다음 업무에서도 하나씩 직접 되풀이할 단계(무엇을, 이번에 몇 번, 한 번에 얼마나 걸렸는지)와 도구로 만들면 줄어들 시간. 없으면 "없음".';

/** Work sessions and run-jobs on subscription providers get the secretary's read-only memory tools; other providers do not. */
export const MEMORY_READ_RULE =
  '- 비서 기억 읽기 도구(`recall`·`search_log`)가 있으면, 기억이 필요할 때 `recall`로 찾고 근거가 더 필요하면 `search_log`로 대화 원문을 조회한다. 쓰기 도구는 없으니 남길 사실은 보고서에 적는다.';

/** A background command left running keeps the session listed as busy, so the secretary's watch sees the finish late. */
export const BACKGROUND_STOP_RULE =
  '- 업무를 끝내기 전에 뒤에서 도는 명령을 끝내거나 멈춘다(TaskStop). 남으면 비서가 완료를 늦게 알게 된다.';

/** Adapted from Anthropic's AI-native SDLC playbook (plan mode → plan.md, approved before any change). */
export const PLAN_FIRST_RULE =
  `- \`${TASK_FILE}\`에 "계획 먼저: 예"가 있으면, 파일을 고치기 전에 관련 코드·자료만 읽고 업무 폴더에 \`plan.md\`(바뀌는 파일, 작업 순서, 위험, 완료 확인 방법)를 쓴 뒤 \`[질문] 계획 승인\`으로 멈춘다. 승인받으면 그 계획대로 하고, 계획과 달라지면 다시 묻는다.`;

/** The line that ends the "검증" block; the workspace's check commands follow it outside the block, one `- \`command\`` each. */
const VERIFY_LIST_LINE = '이 공간의 검증 명령(아래 줄. 아직 없으면 이번 업무에서 직접 돌린 확인을 적고, 이 공간의 검증 명령으로 쓸 만하면 보고서 "다음엔"에 제안한다):';

/** Playbook "Give Claude a feedback loop": no "done" without pasted output, and fix the code, not the test. */
function verifyBlock(hasHistory: boolean): string[] {
  const checker = hasHistory
    ? [
        `- 확인 담당: 보고서를 쓰기 전에 Agent 도구로 확인 담당 보조 에이전트를 부른다. 결과물·코드를 확인하면 sonnet, 숫자·결론만 점검하면 haiku. 지시 첫 줄은 "고치지 말고 보고만 하라"이고(확인 담당이 고치면 업무 세션의 결과와 확인이 섞여 무엇을 확인했는지 흐려진다), ${VERIFIER_RUN_RULE} 이어서 완료 기준을 하나씩 대조하고, 숫자·결론이 있으면 기준(템플릿·키워드·임계값 등)을 만든 자료로 평가하지 않았나, 이름 붙인 요소가 실제로 그것인가, 숫자가 실제 실행 출력에 있나를 확인한다. "이 입력이면 이렇게 틀린다"는 구체적 사례가 있을 때만 지적하고, 한계를 적은 \`shortcut:\` 주석은 결함이 아니라 결정으로 본다(예상 부하가 그 한계를 넘을 때만 지적). 지적은 모두 처리 결과와 함께 보고서에 그대로 적는다(닫을지는 비서가 본다).`,
      ]
    : [];
  return [
    '## 검증',
    '',
    `보고하기 전에 아래 검증 명령과 \`${TASK_FILE}\`의 "완료 확인 방법"을 직접 실행하고, 명령과 출력(길면 끝부분)을 \`${REPORT_FILE}\`에 붙인다. "됐다"는 출력을 붙인 뒤에만 쓴다.`,
    '',
    '- 검증이나 테스트가 실패하면 테스트가 아니라 코드를 고친다. 테스트가 틀렸다고 보이면 테스트를 고치기 전에 `[질문]`으로 묻는다.',
    '- 지적이나 실패를 고쳤으면 고친 뒤 다시 돌려 확인하고 그 출력을 붙인다. 다시 돌리지 않은 수정은 보고서에 "고친 뒤 확인 안 함"으로 적는다.',
    ...checker,
    '',
    VERIFY_LIST_LINE,
  ];
}

const trimBlank = (lines: string[]) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/** A block between its marks. */
export const wrapBlock = (id: string, lines: string[]) => [blockBegin(id), ...trimBlank(lines), blockEnd(id)];

/** What goes between a block's marks (without them); null for a name the template does not have. */
export function charterBlockLines(id: string, c: CharterContext): string[] | null {
  const { hasHistory, root } = c;
  switch (id) {
    case 'intro':
      return ['이 폴더는 개인 비서가 일을 맡기는 작업 공간(workspace)이다. 업무는 여러 번 들어오고, 세션 하나가 업무 하나를 맡는다.'];
    case 'team':
      return ['## 팀', '', '이 공간에는 역할별 에이전트가 있다(`.claude/agents/`). 업무를 받은 세션은 팀장으로서 일을 나누고, Agent 도구로 맞는 역할에 맡기고, 결과를 모아 확인한다.'];
    case 'solo':
      return [
        '## 혼자 맡는 방식',
        '',
        '이 공간의 업무는 업무를 받은 세션이 기획부터 결과물까지 혼자 한다.',
        '',
        '- 필요하면 그 자리에서 Agent 도구로 보조 에이전트를 잠깐 불러 쓴다: 만든 것을 따로 검증할 때(테스트, 출처 확인), 단순 반복을 값싼 모델(haiku)로 넘길 때, 일이 한 세션에 담기 어려울 만큼 클 때.',
        '- 보조 에이전트에는 그 일에 필요한 것만 넘기고, 결과는 직접 확인한 뒤 쓴다.',
      ];
    case 'start':
      return [
        '## 업무를 받으면',
        '',
        `- 결과물은 제품별로 둔다. 제품 본체(지금 쓰는 최신본 하나)는 \`${OUTPUT_DIR}/${PRODUCTS_DIR}/<제품>/\`, 업무 폴더는 \`${OUTPUT_DIR}/${RECORDS_DIR}/<제품>/<YYYYMMDD>-<업무이름>/\`, 제품이 아닌 실험·조사는 \`${OUTPUT_DIR}/${RESEARCH_DIR}/<YYYYMMDD>-<업무이름>/\`다. 업무 폴더 안의 \`${TASK_FILE}\`가 지시서이고, 세션을 시작할 때 어느 업무인지 알려 준다.`,
        ...(hasHistory
          ? [
              `- 시작하기 전에 \`${MEMORY_FILE}\`와 \`${HISTORY_FILE}\`(지금 상태)를 읽고, 맞는 스킬(\`${SKILLS_DIR}/\`, 공통 스킬은 \`${COMMON_PREFIX}<이름>\`)이 있으면 먼저 읽고 따른다. 지난 업무가 필요하면 기록 파일에서 찾아 그 항목만 읽는다: 최근 업무 \`grep -h "^## " ${HISTORY_DIR}/*.md | tail -20\`, 같은 제품 \`grep -h "^## .*records/<제품>/" ${HISTORY_DIR}/*.md | tail -10\`, 키워드 \`grep -n "<키워드>" ${HISTORY_DIR}/*.md\`. 찾은 항목의 자세한 내용은 그 업무 폴더의 \`${REPORT_FILE}\`에 있다.`,
            ]
          : []),
        PLAN_FIRST_RULE,
        '- 제품 업무는 그 제품 폴더를 제자리에서 고친다(버전마다 사본을 만들지 않는다, 이전 버전은 git 기록으로 남는다). 보고서·시험 결과·배포본(zip 등)은 업무 폴더에 둔다. 다른 제품 폴더와 다른 업무 폴더는 참고만 한다.',
        '- 여러 업무가 함께 쓸 자료(공용 템플릿, 스타일 등)를 이 공간에 새로 두거나 고쳐야 하면 먼저 묻는다.',
      ];
    case 'learning':
      return renderLearning();
    case 'work':
      return [
        '## 일하는 방식',
        '',
        '- 이 공간 폴더 밖은 읽기만 한다.',
        sandboxRule(root),
        IRREVERSIBLE_RULE,
        LONGTERM_RULE,
        MEMORY_READ_RULE,
        '- 방향을 바꿔야 하거나 완료 기준을 지킬 수 없으면, 추측으로 이어 가기 전에 멈추고 묻는다.',
        '- 비용이 들거나 되돌릴 수 없는 일(결제, 외부 발송, 공개 게시, 삭제)은 먼저 확인받은 뒤에 한다.',
        '- 비밀번호·API 키 같은 민감정보를 파일에 쓰지 않는다(공간 폴더는 업무가 끝날 때 `git add -A`로 통째 커밋된다).',
        BACKGROUND_STOP_RULE,
        '- 같은 실행을 여러 번 되풀이하는 시험·실측(특히 안에서 `claude -p` 같은 AI를 부르는 것)은 먼저 1~3회만 돌려 회당 토큰·비용·시간을 재고, 전체 횟수로 곱한 예상치를 적어 `[질문]`으로 멈춘다. 승인받은 뒤에 나머지를 돌린다.',
        '- 파일 충돌 막기: 병렬로 맡긴 보조 에이전트마다 쓸 하위 폴더나 파일명을 미리 정해 주고(예: `parts/03-<이름>/`), 그 폴더·파일에만 쓰게 한다. 앞 결과를 받아 되풀이하는 작업은 회차마다 번호 붙인 새 폴더·파일(예: `round-02/`)에 쓴다(앞 회차 결과는 그대로 남긴다). 합친 결과물과 보고서는 업무를 받은 세션만 쓴다.',
        '- 날짜·시각은 한국시간(KST)으로 쓴다. Windows의 Git Bash에는 시간대 자료가 없어 `TZ=Asia/Seoul date`가 UTC를 내므로, `TZ=KST-9 date`나 PowerShell `Get-Date`로 확인한다.',
        '- PowerShell로 파일을 쓸 때는 `-Encoding utf8`을 붙인다(`Set-Content`·`Out-File` 기본 인코딩은 한글을 깨뜨린다).',
        '- 웹은 검색·페이지 읽기 도구(WebSearch·WebFetch)로 되면 그걸 쓴다. 로그인된 사이트, 클릭·입력, 그 도구로 막히는 페이지에는 Ego Lite가 설치돼 있으면(`ego-browser` 명령이 있으면) Ego Lite를 쓴다: 먼저 `ego-browser skill`을 실행해 출력대로 따른다. 캡차·보안 확인은 `task.handOff()`로 넘긴 뒤 [질문]으로 알린다(캡차는 사용자가 푼다).',
        '- 같은 형식을 여러 개 만드는 일은 찍어 내는 코드를 만들어 돌린다. 판단이 필요한 부분만 직접 한다.',
        ...REPEAT_RULES,
        `- 조사에서 Ego Lite로 연 페이지는 근거로 남긴다: \`${entryPath('ego-grab.mjs', root).replace(/\\/g, '/')}\`의 \`grab\`이 페이지 본문을 txt로 저장한다(사용법은 파일 맨 위 주석).`,
        ...renderFindSecretary(secretaryDirEnv(readSecretaryId(root))),
        `- 사용자에게 말하는 방식은 \`${TASK_FILE}\`의 "알아둘 맥락"을 따른다.`,
      ];
    case 'code':
      return renderCodeRules('small');
    case 'code-medium':
      return renderCodeRules('medium');
    case 'code-large':
      return renderCodeRules('large');
    case 'verify':
      return verifyBlock(hasHistory);
    case 'ask':
      return [
        '## 물어볼 때',
        '',
        '질문은 비서가 받아서 직접 답하거나 사용자에게 전달한다. 그래서 다음을 지킨다.',
        '',
        '- 선택창(AskUserQuestion)을 쓰지 않는다. 질문은 대화 글로 쓰고, 그 자리에서 턴을 끝낸다.',
        QUESTION_FIRST_RULE,
        QUESTION_BASIS_RULE,
        '- 맥락 없이 읽어도 판단할 수 있게 쓴다. 답하는 쪽은 이 대화를 보지 못했다.',
        '- 그 질문에 걸린 작업은 답을 받은 뒤에 한다. 걸리지 않은 작업이 있으면 그것부터 한다.',
      ];
    case 'finish':
      return finishBlock(hasHistory);
    case 'run-job':
      return runJobBlock(root);
    default:
      return null;
  }
}

function finishBlock(hasHistory: boolean): string[] {
  const writeHistory = hasHistory
    ? [
        `보고서를 쓴 뒤 \`${HISTORY_DIR}/<YYYY-MM>.md\`(이 업무를 끝낸 달, KST. 없으면 \`# <YYYY-MM> 업무 기록\` 한 줄로 만든다) 맨 아래에 이 업무 항목을 덧붙인다(업무 폴더 밖이지만 이 파일들은 고쳐도 된다). 기록 파일에는 이 업무 항목을 덧붙이기만 한다(아래 [정정] 한 줄만 예외).`,
        '',
        '- 제목: `## <날짜> · <업무 제목> (`<업무 폴더 경로>`)`. 최근 목록과 찾기가 이 줄만 보므로, 제목만 읽어도 무엇을 한 업무인지 알 수 있게 대상과 한 일을 넣는다.',
        '- 시도한 것, 핵심 숫자, 결론을 몇 줄로. 확인하지 않은 것은 "추정"으로 표시한다. 다음에도 쓸 절차·주의사항은 여기가 아니라 스킬이나 제안에 쓴다.',
        '- 결정은 되돌리기 어렵고, 나중에 보면 이유가 놀랍고, 실제 대안을 비교해 고른 것만 `[결정]`으로 남긴다(고른 것, 버린 대안, 이유를 한 줄씩).',
        '- 이번 업무가 지난 항목의 결과를 뒤집었으면, 그 항목(다른 달 파일에 있어도) 맨 앞에 `[정정 <날짜>] <무엇이 왜 틀렸는지>` 한 줄을 단다. [정정] 한 줄 말고는 지난 항목과 지난 보고서를 그대로 둔다.',
        `- \`${HISTORY_FILE}\`의 "현재 상태"(지금까지 최선, 남은 문제, 보류 중이면 다시 살릴 조건)를 이번 결과에 맞게 고친다. ${STATUS_LIMIT.toLocaleString('en-US')}자 안으로 쓰고, 끝난 일은 항목 제목이나 업무 폴더 경로로 가리키기만 한다.`,
        '',
      ]
    : [];
  return [
    '## 끝낼 때',
    '',
    `그 업무 폴더에 \`${REPORT_FILE}\`를 쓴다. 비서는 이 파일을 읽고 사용자에게 보고한다.`,
    '',
    '- 결과 요약 (두세 문장)',
    '- 산출물: 만든 파일과 그 용도',
    '- 완료 기준별 충족 여부와 근거',
    '- 검증: 실행한 명령과 출력(위 "검증"), 확인 담당의 지적과 처리 결과',
    '- 작업 중 받은 답과 그에 따른 결정',
    ASSUMED_REPORT,
    '- 남은 일, 사용자가 결정할 것, 건너뛰거나 확인하지 않은 것과 그 위험',
    REPEAT_REPORT,
    ...LONGTERM_REPORT,
    hasHistory
      ? `- 다음엔: 이 공간에서 비슷한 업무를 다시 할 때 다르게 할 점. 남겨 둘 배움과 이 AGENTS.md·역할 정의(\`.claude/agents/\`)를 고치자는 제안은 \`${PENDING_DIR}/\`에 쓰고 여기에는 파일 이름만 적는다. 없으면 "없음".`
      : '- 다음엔: 이 공간에서 비슷한 업무를 다시 할 때 다르게 할 점. 이 AGENTS.md나 역할 정의(`.claude/agents/`)를 고치자는 제안이면 어느 파일의 무엇을 어떻게 고칠지 적는다. 없으면 "없음".',
    ...(hasHistory ? [`- 고친 스킬, 남긴 제안: 고친 스킬 파일과 바꾼 규칙 한 줄씩, 남긴 \`${PENDING_DIR}/\` 파일 이름. 없으면 "없음".`] : []),
    '',
    ...writeHistory,
    '마지막으로 이 공간 폴더에서 `git add -A`와 `git commit -m "<업무 폴더 이름>: <업무 제목>"`으로 한 번 커밋한다(이 PC 안의 기록용, push하지 않는다). 기록을 되돌리는 명령(reset, checkout, revert, restore)은 쓰지 않는다(이 git 기록은 업무 세션이 파일을 깨뜨렸을 때 비서가 되살리는 바탕이다). 되돌려야 하면 보고서에 적는다.',
    '',
    hasHistory
      ? `이 AGENTS.md(CLAUDE.md는 이 파일을 불러오기만 한다), 역할 정의, \`${MEMORY_FILE}\`는 직접 고치지 않는다(규칙 파일은 비서가 관리하고, 바꿀 점은 사용자 확인을 거쳐야 하기 때문이다). 스킬은 위 "스킬과 기억"대로 사용자의 교정을 반영할 때만 고친다. 그 밖의 바꿀 점은 제안으로 남기고, 비서가 사용자에게 확인받아 반영한다.`
      : '이 AGENTS.md(CLAUDE.md는 이 파일을 불러오기만 한다)와 역할 정의는 직접 고치지 않는다(규칙 파일은 비서가 관리하고, 바꿀 점은 사용자 확인을 거쳐야 하기 때문이다). 비서가 제안을 사용자에게 확인받고 반영한다.',
  ];
}

/** The blocks a charter of this spec has, in order (workspace/charter-blocks.ts adds a missing one where it goes). */
export function charterBlockIds(spec: Pick<WorkspaceSpec, 'kind' | 'agents' | 'code' | 'scale'>): CharterBlockId[] {
  const team = spec.kind === 'team' && (spec.agents ?? []).length > 0;
  const ids: CharterBlockId[] = ['intro'];
  if (team) ids.push('team');
  else if (spec.kind === 'solo') ids.push('solo');
  ids.push('start');
  if (spec.kind !== 'quick') ids.push('learning');
  ids.push('work');
  if (spec.code) ids.push(codeBlockId(spec.scale));
  ids.push('verify', 'ask', 'finish');
  return ids;
}

/**
 * A new workspace's charter: the secretary's blocks (charterBlockLines) and, outside them, the workspace's own parts: its
 * title, what it does, its context, its roles (after the team block) and its check commands (after the verify block).
 */
export function renderCharter(spec: WorkspaceSpec, root = PROJECT_ROOT): string {
  const c: CharterContext = { hasHistory: spec.kind !== 'quick', root };
  const after: Partial<Record<CharterBlockId, string[]>> = {
    team: (spec.agents ?? []).map((a) => `- \`${a.name}\`: ${oneLine(a.description)}`),
    verify: (spec.verify ?? []).map((v) => `- \`${v}\``),
  };
  const out = [`# ${spec.title}`, ''];
  for (const id of charterBlockIds(spec)) {
    out.push(...wrapBlock(id, charterBlockLines(id, c)!), ...(after[id] ?? []), '');
    if (id === 'intro') {
      out.push('## 이 공간이 하는 일', '', spec.purpose.trim(), '');
      if (spec.context?.trim()) out.push('## 알아둘 맥락', '', spec.context.trim(), '');
    }
  }
  return out.join('\n');
}

/**
 * How a workspace tool finds the secretary's entrance folder bin/: the workspace's secretary-link.local.json
 * (workspace/secretary-link.ts), else this secretary's own variable plus \bin. The one
 * place with code to read it, in three languages; each searches upward from the tool's own folder, so a tool anywhere
 * in the workspace finds the file. None of them returns the secretary folder itself.
 */
export function findSecretaryCode(env = secretaryDirEnv(readSecretaryId(PROJECT_ROOT))): { python: string; powershell: string; node: string } {
  const pyEnv = `os.environ.get("${env}")`;
  const psEnv = `$env:${env}`;
  const nodeEnv = `process.env.${env}`;
  return {
    python: [
      'import json, os',
      'from pathlib import Path',
      'def secretary_bin(start=Path(__file__).resolve()):',
      '    for d in start.parents:',
      `        f = d / "${LINK_FILE}"`,
      '        if f.is_file(): return Path(json.loads(f.read_text(encoding="utf-8-sig"))["bin"])',
      ...pythonFallbackLines(env),
    ].join('\n'),
    powershell: [
      'function Get-SecretaryBin([string]$Dir = $PSScriptRoot) {',
      `  for ($d = $Dir; $d; $d = Split-Path $d) { $f = Join-Path $d '${LINK_FILE}'; if (Test-Path -LiteralPath $f) { return (Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json).bin } }`,
      `  $root = @(${psEnv}) | Where-Object { $_ } | Select-Object -First 1`,
      `  if ($root) { Join-Path $root '${ENTRY_DIR}' }`,
      '}',
    ].join('\n'),
    node: [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'function secretaryBin(dir = path.dirname(fileURLToPath(import.meta.url))) {',
      '  for (let d = dir; ; d = path.dirname(d)) {',
      `    const f = path.join(d, '${LINK_FILE}');`,
      "    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\\uFEFF/, '')).bin;",
      '    if (path.dirname(d) === d) break;',
      '  }',
      `  const root = ${nodeEnv};`,
      `  return root && path.join(root, '${ENTRY_DIR}');`,
      '}',
    ].join('\n'),
  };
}

/** The charter's lines on calling secretary scripts (any secretary's variable name in env). */
export function renderFindSecretary(env = secretaryDirEnv(readSecretaryId(PROJECT_ROOT))): string[] {
  const code = findSecretaryCode(env);
  return [
    `- 비서 스크립트는 비서의 진입점 폴더(\`${ENTRY_DIR}\`)에 있는 이름으로만 부른다(비서 폴더의 다른 파일은 업무 세션에서 막힌다). 진입점 폴더는 이 공간 맨 위 \`${LINK_FILE}\`의 \`bin\`이다(비서가 써 두는 파일이라 고치지 않는다. PC마다 달라 커밋하지 않는다, \`.gitignore\`). 그 파일이 없으면 환경변수 \`${env}\` 아래 \`${ENTRY_DIR}\`을 쓴다. 도구에서 찾을 때는 아래 함수를 그대로 쓴다(도구 폴더에서 위로 올라가며 찾는다):`,
    '',
    '```python',
    code.python,
    '```',
    '',
    '```powershell',
    code.powershell,
    '```',
    '',
    '```js',
    code.node,
    '```',
    '',
  ];
}

/** Hermes Agent's split (MIT, Nous Research): procedures and corrections go to skills, only lasting facts to memory. */
export function renderLearning(): string[] {
  return [
    '## 스킬과 기억',
    '',
    `이 공간에서 배운 것은 업무 종류별 스킬(\`${SKILLS_DIR}/<이름>/SKILL.md\`, 깊은 내용은 그 폴더의 \`references/\`)과 늘 맞는 사실(\`${MEMORY_FILE}\`)에 둔다. 업무 기록은 \`${HISTORY_FILE}\`(지금 상태)와 \`${HISTORY_DIR}/<YYYY-MM>.md\`(업무별 항목)에 따로 둔다. 스킬 목록은 CLI가 SKILL.md 머리말(\`---\` 블록의 name, description)로 보여 주므로 여기 따로 적지 않는다. ${SKILL_FORMAT_RULE}`,
    '',
    '- 사용자가 직접 고쳐 준 것(말투·형식·순서 등)은 그 자리에서 해당 스킬의 해당 단계를 "규칙 + 이유 한 줄"로만 고치고, 같은 교훈은 하나로 합친다. 맞는 스킬이 없으면 아래 제안으로 남긴다.',
    `- 스스로 찾은 배움(새 절차, 주의사항, \`${MEMORY_FILE}\` 후보)은 먼저 \`${PENDING_DIR}/<YYYYMMDD>-<짧은이름>.md\`에 제안으로 남긴다(반영할 파일, 바꿀 내용, 이유 한 줄). 비서가 업무 끝에 승인받아 반영한다.`,
    `- 공통 스킬(\`${COMMON_PREFIX}<이름>\` 스킬, 원본은 \`workspaces\\_skills\`, 공간 스킬 맨 위의 "공통 주의사항은 먼저 읽는다" 경로 줄이 가리키는 곳)은 읽기만 한다. 브랜드와 상관없는 도구·API·환경 주의사항처럼 거기 넣을 만한 배움은 \`${PENDING_DIR}/\` 제안으로 남긴다.`,
    '- 남기지 않는 것: 환경 탓 실패, "X 도구는 안 된다" 같은 단정, 못 푼 시도, 일회성 서술(다음 업무에 맞지 않는 글이 스킬에 쌓이면 맞는 규칙이 묻힌다).',
    `- \`${MEMORY_FILE}\`는 ${MEMORY_LIMIT.toLocaleString('en-US')}자 안에서 "~이다" 형식의 사실문만 담는다. 절차와 "~해라" 형식은 스킬로 보낸다.`,
    '- 스킬·MEMORY·제안은 개인정보와 "누가 시켰는지" 없이 규칙과 이유로만 쓴다.',
    '',
  ];
}

export function renderMemory(spec: WorkspaceSpec): string {
  return [
    `# ${spec.title} 사실 메모`,
    '',
    `이 공간에 늘 맞는 사실만 "~이다" 형식으로 한 줄씩 쓴다(전체 ${MEMORY_LIMIT.toLocaleString('en-US')}자 이내). 절차는 스킬에 둔다.`,
    '',
  ].join('\n');
}

export function renderHistory(spec: WorkspaceSpec): string {
  return [
    `# ${spec.title} 기록`,
    '',
    `지금 상태만 둔다(${STATUS_LIMIT.toLocaleString('en-US')}자 안). 업무별 항목은 \`${HISTORY_DIR}/<YYYY-MM>.md\`에 그 업무 세션이 덧붙인다.`,
    `찾기: 최근 \`grep -h "^## " ${HISTORY_DIR}/*.md | tail -20\`, 제품 \`grep -h "^## .*records/<제품>/" ${HISTORY_DIR}/*.md\`, 키워드 \`grep -n "<키워드>" ${HISTORY_DIR}/*.md\`.`,
    '',
    '## 현재 상태',
    '',
    '- 아직 끝난 업무가 없다.',
    '',
  ].join('\n');
}

/** The brief's three parts on what the user wants (renderTaskBrief), as scripts/delegate-check brief looks them up. */
export const BRIEF_INTENT = '의도';
export const BRIEF_OUT_OF_SCOPE = '범위 밖 (하지 않는 것)';
export const BRIEF_USER_WORDS = '사용자 원문';
/** What an empty one says (delegate-check counts it as empty). */
export const BRIEF_EMPTY = '(비서가 적지 않음. 이 일에 걸리면 짐작하지 말고 [질문]으로 묻는다)';

export function renderTaskBrief(task: TaskSpec): string {
  return [
    `# ${task.title}`,
    '',
    '## 목표',
    '',
    task.goal.trim(),
    '',
    // Intent, out of scope and the user's words (2026-11-13, the user's call): written even when empty, so the worker sees
    // what it was not told and asks ([질문]) instead of guessing; delegate-check brief tells the secretary of an empty one.
    `## ${BRIEF_INTENT}`,
    '',
    task.intent?.trim() || BRIEF_EMPTY,
    '',
    `## ${BRIEF_OUT_OF_SCOPE}`,
    '',
    ...(task.outOfScope?.length ? task.outOfScope.map((o) => `- ${o}`) : [BRIEF_EMPTY]),
    '',
    `## ${BRIEF_USER_WORDS}`,
    '',
    task.userWords?.trim() || BRIEF_EMPTY,
    '',
    '## 알아둘 맥락',
    '',
    task.context?.trim() || '(비서가 넘긴 맥락 없음)',
    '',
    '## 완료 기준',
    '',
    ...task.doneCriteria.map((c) => `- ${c}`),
    '',
    '## 완료 확인 방법',
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

/** The common skills run-job's default folder lists (its common-skills.json when made; one missing from _skills is left out). */
export const RUN_JOB_HOME_SKILLS: string[] = [];

/**
 * The rules of run-job's default folder (workspaces/_run-job-home, workspace/aux-folders.ts makes it when missing; the
 * block follows the template through workspace-links like a workspace's): the jobs answer in text, not in reports, so the
 * lines say "답" where a workspace's say "보고서".
 */
export function renderRunJobHome(root = PROJECT_ROOT): string {
  return ['# run-job 작업 폴더', '', ...wrapBlock('run-job', runJobBlock(root)), ''].join('\n');
}

function runJobBlock(root: string): string[] {
  return [
    '비서가 run-job으로 맡긴 일을 하는 곳이다. 결과는 마지막 답에 글로 쓴다.',
    '',
    '- 웹은 검색·페이지 읽기 도구(WebSearch·WebFetch)로 되면 그걸 쓴다. 로그인된 사이트, 클릭·입력, 그 도구로 막히는 페이지에는 Ego Lite가 설치돼 있으면(`ego-browser` 명령이 있으면) Ego Lite를 쓰는데, 먼저 `ego-browser skill`을 실행해 출력대로 따른다. 캡차·보안 확인이 나오면 거기서 멈춰 어디서 막혔는지 알린다(캡차는 사용자가 푼다).',
    `- 비서가 넘긴 파일은 \`${OUTPUT_DIR}/${RESEARCH_DIR}/<날짜-일이름>/\`에 있다. 파일을 만들어야 하면 그 폴더 안에만 쓴다.`,
    '- 보조 에이전트를 뒤에서 띄웠으면 모두 끝날 때까지 기다렸다가 결과를 모아 답한다.',
    BACKGROUND_STOP_RULE,
    '- 같은 형식을 여러 개 만드는 일은 찍어 내는 코드를 만들어 돌린다. 판단이 필요한 부분만 직접 한다.',
    '- 많은 자료를 하나씩 열어 읽거나 같은 조작을 여러 번 되풀이할 일(예: 메일 수백 통을 브라우저로 하나씩 열기)은 도구·스크립트로 만들어 한꺼번에 처리한다. 아래 세 때에 따진다.',
    '  - 시작 전: 목적(이 일로 무엇을 얻으려는지), 규모(먼저 센다: 몇 건인지, 하나씩 직접 하면 얼마나 걸리는지), 길(하나씩 직접 하는 길과 한꺼번에 하는 길: 내보내기, 공식 API, 프로그램, 이미 있는 도구)을 본다. 지시가 방법을 정하지 않았으면 나은 길을 고른다. 방법까지 정했으면 그대로 하되, 훨씬 나은 길이 있으면 시간 차이를 숫자로 붙여 답에 제안한다.',
    '  - 도중: 처음 몇 건을 해 본 뒤 "한 건 시간 × 남은 건수"로 전체 시간을 계산하고, 너무 길거나 같은 조작을 되풀이하고 있으면 멈추고 방법을 바꾼다. 같은 조작이 한 턴에 여러 번 되풀이되면 훅이 `[반복 작업 알림]`으로 알린다.',
    '  - 끝난 뒤: 다음에 또 쓸 만하면 답에 그 도구 위치와 쓰는 법을 적는다.',
    '- 확인하지 못한 값은 "확인 안 됨"으로 적는다.',
    '- 나중까지 남는 것(이름 짓는 법(키·폴더·파일), 공간·업무 틀, 기억·비서 시스템, 프로그램, 구조)을 만들거나 바꿀 때는 답에 지금 안 옆에 "장기적 관점의 제안"을 나란히 적는다. 안마다 좋은 점, 지금 비용, 나중에 바꾸는 비용을 붙이고 추천을 표시한다. 두 안이 같으면 "장기적 관점으로 봐도 같음" 한 줄로 끝낸다. 맡은 범위 밖에서 본 더 나은 구조는 답 끝 "개선 후보" 항목에 적기만 한다(없으면 항목을 뺀다).',
    '- 비서 기억 읽기 도구(`recall`·`search_log`)가 있으면, 기억이 필요할 때 `recall`로 찾고 근거가 더 필요하면 `search_log`로 대화 원문을 조회한다. 쓰기 도구는 없으니 남길 사실은 답에 적는다.',
    '- 조사 보고서를 쓰면 맨 아래에 `## 출처` 항목을 두고, 근거로 쓴 자료(URL, 파일 경로)를 모아 적는다.',
  ];
}

