/**
 * The old names the secretary still reads beside the new ones, in one table: what is read, when it can go, and the date
 * to look again. Each place in the code that reads one carries the mark `legacy-name: <id>` in a comment (so the table and
 * the code find each other: npm test, test/legacy-names.test.ts, fails on a mark without a row or a row without a mark,
 * and from a row's date on it says the row is due, without failing). Removing one: take out the reading at each mark,
 * then the row. Moving the date: change `checkBy` (and say why in `alsoWhen` if the condition changed).
 *
 * `feature` is the features.json feature whose files hold the marks: a copy without that feature (a release leaves some
 * out) is not asked for them.
 */
import { formatLocal } from './kst-time.ts';

export interface LegacyName {
  id: string;
  /** The old name still read, and the new one. */
  old: string;
  now: string;
  /** Which of the two kinds the old name is (LEGACY_KINDS): that says when its reading can go. */
  kind: LegacyKind;
  /** What must also be true first, when something must. */
  alsoWhen?: string;
  /** From this day (YYYY-MM-DD, KST) npm test says to look at the row again. */
  checkBy: string;
  feature: string;
}

/**
 * When a reading can go (decided 2026-11-10): the release v0.10.0 carries the moves for users of v0.9.0 and before, and
 * this PC's own old names go once v0.10.0 is public (pushed and tagged). A row is one of the two kinds:
 * - pc-only: only this PC ever had the old name (a release never did).
 * - release-move: release users have it too: v0.10.0 keeps the reading, and it goes in the next version, after they updated.
 */
export type LegacyKind = 'pc-only' | 'release-move';
export const LEGACY_KINDS: Record<LegacyKind, { label: string; when: string }> = {
  'pc-only': { label: '이 PC 전용', when: '0.10.0 공개(push·tag) 뒤(배포판 사용자에게는 옛 이름이 없다)' },
  'release-move': { label: '배포판 옮기기', when: '0.10.0에만 두고, 배포판 사용자들이 0.10.0으로 올린 뒤 다음 버전에서(0.9.0 이하 사용자의 옛 이름을 0.10.0이 읽어 옮긴다)' },
};

/** When a row's reading can go, in a line: its kind, when that kind goes, and what must also be true first. */
export const removeWhen = (r: Pick<LegacyName, 'kind' | 'alsoWhen'>): string =>
  `[${LEGACY_KINDS[r.kind].label}] ${LEGACY_KINDS[r.kind].when}${r.alsoWhen ? ` — ${r.alsoWhen}` : ''}`;

export const LEGACY_NAMES: LegacyName[] = [
  {
    id: 'usage-dir',
    old: '~/.claude/usage (사용량 기록, 옛 사본이 쓰는 동안 새 자리와 함께 읽어 새것을 씀)',
    now: '~/.secretary/usage',
    kind: 'release-move',
    alsoWhen: '이 PC의 옛 run-job 기록을 legacyRunJobCleanup으로 정리한 뒤',
    checkBy: '2026-12-10',
    feature: 'usage-guard',
  },
  {
    id: 'usage-guard-override-old',
    old: '~/.claude/usage/guard-override-<계정>.json ("90% 넘어도 진행" 풀기)',
    now: '~/.secretary/usage/usage-guard-override-<계정>.json',
    kind: 'release-move',
    alsoWhen: 'usage-dir과 같이(옛 풀기는 초기화 시각까지만 쓰여 그 뒤로는 남을 일이 없다)',
    checkBy: '2026-12-10',
    feature: 'usage-guard',
  },
  {
    id: 'usage-guard-off',
    old: '~/.claude/usage-guard-off (사용량 정지 장치 끄기)',
    now: '~/.secretary/usage-guard-off',
    kind: 'release-move',
    alsoWhen: '이 PC의 옛 자리에 끄기 파일이 없을 때',
    checkBy: '2027-02-10',
    feature: 'usage-guard',
  },
  {
    id: 'usage-key-no-account',
    old: '사용량 파일의 옛 이름 <공급자>.json(계정 칸 없음)·<공급자>-<계정>.json (상태줄·usage-query.ps1이 새 이름으로 쓴 뒤 지우거나 옮김)',
    now: 'subscription-<계정>.json',
    kind: 'release-move',
    checkBy: '2027-02-10',
    feature: 'usage-guard',
  },
  {
    id: 'state-dir',
    old: '~/.secretary/state/<번호>와 그 전 ~/.claude/usage (업무 세션·run-job·감시·따로 띄운 일 기록)',
    now: '~/.secretary/<번호>/state',
    kind: 'release-move',
    alsoWhen: '이 PC에서 옛 자리에서 띄운 업무 세션·감시·따로 띄운 일이 다 끝나 기록이 옮겨진 뒤',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
  {
    id: 'log-dir',
    old: '~/.secretary/logs/<번호>와 그 전 ~/.secretary/logs (서버 기록 보기)',
    now: '~/.secretary/<번호>/logs',
    kind: 'release-move',
    alsoWhen: '서버 기록은 14일 치만 두므로 옛 자리의 기록이 다 지난 뒤',
    checkBy: '2027-02-10',
    feature: 'remote-server',
  },
  {
    id: 'env-usage-guard-pct',
    old: '환경변수 USAGE_PAUSE_PCT',
    now: 'SECRETARY_USAGE_GUARD_PCT',
    kind: 'release-move',
    alsoWhen: '이 PC의 사용자 환경변수·설정·공간 규칙 어디에도 옛 이름이 없을 때',
    checkBy: '2027-02-10',
    feature: 'usage-guard',
  },
  {
    id: 'env-semantic-search',
    old: '환경변수 SECRETARY_EMBED(=off), SECRETARY_EMBED_IDLE_MIN·_MODEL_DIR·_MODEL_REPO',
    now: 'SECRETARY_SEMANTIC_SEARCH, SECRETARY_SEMANTIC_SEARCH_IDLE_MIN·_MODEL_DIR·_MODEL_REPO',
    kind: 'release-move',
    alsoWhen: '이 PC의 사용자 환경변수·설정 어디에도 옛 이름이 없을 때',
    checkBy: '2027-02-10',
    feature: 'memory-core',
  },
  {
    id: 'env-secretary-dir',
    old: '환경변수 SECRETARY_DIR (비서 스크립트가 띄우는 것에 함께 넣고, 설치 점검이 남은 것을 알림)',
    now: 'SECRETARY_<번호>_DIR, 작업 공간은 secretary-link.local.json의 bin',
    kind: 'release-move',
    alsoWhen: '이 PC의 비서 폴더 밖(공간 도구·공간 규칙·사용자 설정)에서 SECRETARY_DIR를 읽는 파일이 없고 사용자 환경변수에서도 지운 뒤',
    checkBy: '2026-12-10',
    feature: 'setup-check',
  },
  {
    id: 'setup-check-ids',
    old: '설치 점검 항목의 옛 id(건너뛰기 목록에 적힌 것)',
    now: '새 id(src/core/names.ts CHECK)',
    kind: 'release-move',
    alsoWhen: '이 PC들의 설치 점검 기록(skip 목록)이 새 id로 다시 쓰인 뒤',
    checkBy: '2027-02-10',
    feature: 'setup-check',
  },
  {
    id: 'task-name-no-id',
    old: '번호 없는 예약 작업 이름(features.json의 이름 그대로, v8 전): 이 비서 것이면 새 이름으로 옮김',
    now: '<이름> (<비서 번호>)',
    kind: 'release-move',
    alsoWhen: 'v7에서 바로 올리는 사용자가 없을 때(v8부터는 번호가 붙어 있다)',
    checkBy: '2027-02-10',
    feature: 'setup-check',
  },
  {
    id: 'old-skills-layout',
    old: '옛 스킬 구조(skills/<이름>/와 스킬마다의 연결, 옛 .gitignore 줄): skill-links·workspace-links가 옮김',
    now: '.agents/skills/<이름>/, .claude/skills는 그리로 가는 연결 하나',
    kind: 'release-move',
    alsoWhen: 'v7에서 바로 올리는 사용자가 없고, 이 PC의 비서와 모든 공간이 새 구조일 때(skill-links·workspace-links가 조용할 때)',
    checkBy: '2027-02-10',
    feature: 'setup-check',
  },
  {
    id: 'local-files',
    old: '이 비서 설정 파일과 DB 옆 파일의 옛 이름(scripts/*.local.json, <db>.embedder*)',
    now: '새 이름(src/core/local-settings.ts의 표)',
    kind: 'release-move',
    alsoWhen: '이 PC들에서 옛 이름 파일이 다 옮겨지거나 지워진 뒤(설치 점검 renamed-local-files가 조용할 때)',
    checkBy: '2027-02-10',
    feature: 'memory-core',
  },
  {
    id: 'this-secretary-merge',
    old: '이 PC 설정으로 따로 있던 파일(scripts/*.local.json, tools.local.json): 읽지 않고 this-secretary-merge·업데이트가 옮김(features.json thisSecretary의 from)',
    now: 'this-secretary.local.json 한 파일의 기능별 칸(src/core/this-secretary.ts)',
    kind: 'release-move',
    alsoWhen: '이 PC들에서 옛 파일이 다 옮겨진 뒤(설치 점검 renamed-local-files가 조용할 때). 지울 때는 옮기기 코드와 features.json의 from을 함께 뺀다',
    checkBy: '2027-02-10',
    feature: 'memory-core',
  },
  {
    id: 'secretary-link-file',
    old: '작업 공간의 비서 위치 파일 옛 이름 secretary.json: 있으면 새 파일과 같게 맞춰 두고(새로 만들지는 않음), 공간 AGENTS.md의 찾는 코드는 workspace-links가 새 이름으로 고침',
    now: '공간 맨 위 secretary-link.local.json(src/workspace/secretary-link.ts)',
    kind: 'release-move',
    alsoWhen: '이 PC와 사용자들의 공간 도구가 옛 이름을 더는 읽지 않을 때(공간 도구 안에 복사해 둔 찾는 코드까지 새 이름으로 고친 뒤). 지울 때는 공간의 옛 secretary.json도 지운다(이 PC 공간의 옛 파일은 0.10.0 공개 뒤 먼저 지운다)',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
  {
    id: 'common-skill-prefix',
    old: '공통 스킬의 옛 꼴(목록에 common- 없이, 폴더 _skills/<이름>, 공간 AGENTS.md의 옛 경로)',
    now: '_skills/common-<이름>, 목록에도 common-',
    kind: 'release-move',
    alsoWhen: '이 PC의 모든 공간과 비서의 공통 스킬 목록·폴더·AGENTS.md 경로가 새 꼴인 뒤(workspace-links·skill-links가 조용할 때)',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
  {
    id: 'aux-folders',
    old: '작업 공간 옆 보조 폴더의 옛 이름(run-job-home, old·_old, _consolidate·_board·_workers)',
    now: '_run-job-home, _archived, _staff/<담당자>',
    kind: 'release-move',
    alsoWhen: '이 PC들에서 옛 이름 폴더가 다 옮겨진 뒤(설치 점검 workspace-aux-folders가 조용할 때)',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
  {
    id: 'purge-pending-prefix',
    old: 'DB meta의 옛 대화 삭제 미리 보기 칸 purge_pending:<…> ("확인"으로 지우던 때): 만나면 지움',
    now: 'purge_code:<승인 코드>',
    kind: 'release-move',
    checkBy: '2027-02-10',
    feature: 'memory-core',
  },
  {
    id: 'answer-check-head',
    old: 'Stop 훅이 답을 되돌릴 때 붙이던 머리 "[답 검사]"(2026-11-11 전)와 "[답변 검사]"(2026-11-11, 2차 말 바꾸기 전): 대화 기록에서 되돌림 줄로 알아봄',
    now: '"[답변 검사·Stop 훅]"(src/mistake-guards/stop-guard.ts FILL_HEAD)',
    kind: 'release-move',
    alsoWhen: '바꾸기 전에 열린 세션이 더 이어지지 않을 때(옛 머리는 그 세션 대화 기록에만 남는다)',
    checkBy: '2027-02-10',
    feature: 'mistake-guards',
  },
  {
    id: 'link-gitignore-comment',
    old: '공간 .gitignore의 비서 진입점 줄 머리 주석 "# 이 공간을 맡은 비서의 입구 폴더(…)"(2026-11-11 전): workspace-links가 그 자리에서 새 주석으로 고침',
    now: '"# 이 공간을 맡은 비서의 진입점 폴더(…)"(src/workspace/secretary-link.ts GITIGNORE_LINES)',
    kind: 'release-move',
    alsoWhen: '이 PC의 모든 공간 .gitignore가 새 주석인 뒤(workspace-links가 조용할 때)',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
  {
    id: 'charter-unmarked',
    old: '비서 표시(<!-- secretary:begin … -->) 없는 공간 AGENTS.md(2026-11-12 전): workspace-links가 옛 틀 줄 표(src/workspace/old-charter-lines.ts)로 틀 줄과 공간 몫을 갈라 표시로 감싸 옮김',
    now: '절마다 비서 표시로 감싼 공간 AGENTS.md(src/workspace/rules-text.ts charterBlockLines, charter-blocks.ts가 표시 안만 다시 씀)',
    kind: 'release-move',
    alsoWhen: '이 PC의 모든 공간 AGENTS.md와 _run-job-home/AGENTS.md에 비서 표시가 있는 뒤(workspace-links가 "비서 표시가 없음"을 말하지 않을 때). 지울 때는 old-charter-lines.ts와 charter-blocks.ts의 옮기기(moveCharter·moveRunJob, --add-missing)를 함께 지운다',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
  {
    id: 'skill-gitignore-header',
    old: '비서·공간 .gitignore의 스킬 줄 머리 주석 "# 스킬 연결(…)"(2026-11-11 전): skill-links·workspace-links가 그 자리에서 새 주석으로 고침',
    now: '"# 스킬 링크(…)"(src/setup/skill-links.ts SKILL_GITIGNORE_LINES)',
    kind: 'release-move',
    alsoWhen: '이 PC의 비서와 모든 공간 .gitignore가 새 주석인 뒤(skill-links·workspace-links가 조용할 때)',
    checkBy: '2027-02-10',
    feature: 'setup-check',
  },
  {
    id: 'session-reuse-words',
    old: 'run-job·업무 세션 재사용의 옛 글자(2026-11-11 전): run-job 출력 끝 줄 "(이어 부름) 세션: …", 기록(run-job-calls.jsonl·worker-reuse.jsonl)의 새로 시작한 이유 "문맥 초과"·"문맥 모름"·"이어 부르기 실패"',
    now: '"(재사용) 세션: …", "컨텍스트 초과"·"컨텍스트 모름"·"재사용 실패"(scripts/run-job/run-job.ps1, scripts/worker/worker-lib.ps1). 끝 줄은 src/staff/launch.ts가, 옛 이유는 run-job-stats.ps1이 새 이유와 같이 센다',
    kind: 'release-move',
    alsoWhen: 'run-job-stats.ps1이 보는 최근 기록에 옛 이유가 더 없을 때(기록 파일은 고치지 않는다)',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
];

/** Today in KST, YYYY-MM-DD. */
export const todayKst = (now = Date.now()) => formatLocal(now, true);

/** The rows whose date has come (checkBy on or before today). */
export function dueLegacyNames(today = todayKst(), list: LegacyName[] = LEGACY_NAMES): LegacyName[] {
  return list.filter((r) => r.checkBy <= today);
}
