/**
 * What the install check (setup/setup-check.ts) looks at: what any copy of the secretary needs, then the items of
 * features that start turned off (other providers). Which feature each item belongs to is in features.json
 * (core/features.ts): items of a feature turned off there are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { baseTaskNames, disabledItems, FEATURES_FILE, featuresProblem } from '../core/features.ts';
import { readSecretaryId, taskNameWith } from '../core/secretary-id.ts';
import { ENTRY_DIR, ENTRY_POINTS, entryPath, SECRETARY_DIR_ENV_TEXT, secretaryDirEnv, scriptPath, SCRIPTS, type EntryName } from '../core/paths.ts';
import { CLAUDE_SKILLS_DIR, skillLayout, skillLinkProblems, SKILLS_DIR } from '../workspace/skill-links.ts';
import { formatFeatureSkills, OFF_SKILLS_DIR, planFeatureSkills } from './feature-skills.ts';
import { disabled as semanticSearchOff, MODEL_FILES } from '../semantic-search/client.ts';
import type { Check, Ctx, Outcome, Proc, SetupOptions } from './setup-check.ts';
import { readJsonFile } from '../core/json-file.ts';
import { hookKind, ownerOf } from './other-secretaries.ts';
import { missingReleaseFiles, readReleaseFiles, RELEASE_FILES } from './release-files.ts';
import { commonSkillsDirOf, LINK_FILE, linkedFolders, linkProblems } from '../workspace/secretary-link.ts';
import { formatSpecProblems, skillsDirProblems } from './skill-spec.ts';
import { commonSkillProblem, shippedCommonSkillProblem } from '../workspace/common-skills.ts';
import { formatFolderPlan, planAuxFolders } from './aux-folders.ts';
import { isClaudeCode, providersWithoutPersonalData } from './provider-personal-data.ts';
import { readNotifySettings } from '../phone-push/ntfy.ts';
import { CHECK, CLI, FEATURE, TASK } from '../core/names.ts';
import { parseTailscaleStatus, readTailscaleStatus } from '../core/tailscale.ts';
import { ALL_SECRETARIES_EXAMPLE, ALL_SECRETARIES_FILE, hasThisSecretary, readThisSecretary, THIS_SECRETARY_FILE } from '../core/this-secretary.ts';

const ok: Outcome = { status: 'ok' };
const missingOf = (names: string[]): Outcome => (names.length ? { status: 'missing', detail: names.join(', ') } : ok);

/**
 * Scheduled task names: the name in features.json (install-scheduled-tasks.ps1 reads the same file) with the checked copy's
 * secretary id after it (core/secretary-id.ts), e.g. 'Secretary Idle Jobs (A3F9)'. This copy's features.json stands in
 * when the checked copy's can't be read.
 */
const BASE_NAMES = baseTaskNames();
const baseName = (o: SetupOptions, id: string): string | undefined => baseTaskNames(o.root)[id] ?? BASE_NAMES[id];
/** The checked copy's task names (id → registered name), for the fix texts and tests. */
export function taskNamesFor(root: string): Record<string, string> {
  const id = readSecretaryId(root);
  const base = { ...BASE_NAMES, ...baseTaskNames(root) };
  return Object.fromEntries(Object.entries(base).map(([k, n]) => [k, taskNameWith(n, id)]));
}
const taskName = (o: SetupOptions, id: string): string | undefined => {
  const base = baseName(o, id);
  return base && taskNameWith(base, readSecretaryId(o.root));
};
/** The probe asks for the task by its name. */
const taskProbe = (id: string) => (o: SetupOptions) => {
  const name = taskName(o, id);
  return { tasks: name ? [name] : [] };
};

const scriptCmd = (id: string) => `\`${SCRIPTS.installScheduledTasks} -Task ${id}\`${id === TASK.server ? '(관리자 PowerShell에서)' : ''}`;

/** What to do about a task of this copy's name that runs another secretary's files (re-registering would take it over). */
const otherTaskFix = (name: string, folder: string, id: string) =>
  `이 비서의 이름(번호 포함)인 예약 작업 '${name}'이 이 PC의 다른 비서(${folder})의 파일을 부른다. 다시 등록하면 그 비서가 쓰던 작업을 이 비서로 바꾸게 되므로(\`${SCRIPTS.installScheduledTasks}\`도 건너뛴다) 사용자에게 묻는다. ` +
  `이 비서로 가져오기로 하면 ${scriptCmd(id)}에 \`-TakeOver\`를 붙여 돌리고, 그대로 두면 \`node src/cli.ts ${CLI.setupCheck} --skip ${id}-task\`로 빼 둔다`;

function taskOutcome(c: Ctx, id: string): Outcome {
  const name = taskName(c.o, id);
  if (!name) return { status: 'unknown', detail: `${FEATURES_FILE}에 작업 이름이 없음` };
  const registered = c.probe?.tasks[name];
  if (registered === true) {
    const file = c.probe?.taskFiles?.[name];
    if (file) {
      // Another secretary on this PC behind this copy's name: not this copy's old path, so not to re-register.
      const owner = ownerOf(file, c.o.root);
      const gone = !fs.existsSync(file);
      if (owner.whose === 'other') {
        const folder = owner.folder ?? file;
        return { status: 'missing', detail: `다른 비서의 파일을 부름${gone ? '(가리키는 파일 없음)' : ''}: ${file}`, fix: otherTaskFix(name, folder, id) };
      }
      // Registered from an older layout (a script that moved since) or from a copy that is gone: it fails every run.
      if (gone) return { status: 'missing', detail: `등록됐지만 가리키는 파일 없음: ${file}` };
      // This copy's left-behind copy (same secretary id): re-register here.
      if (owner.copy) return { status: 'missing', detail: `이 비서의 옛 사본(같은 고유 번호)을 부름: ${file}` };
    }
    return ok;
  }
  if (registered === false) return { status: 'missing' };
  return { status: 'unknown', detail: '예약 작업 조회 실패' };
}

/** `-Provider x` on the command line, as scripts/remote-server/server-lib.ps1 Get-ArgProvider reads it. */
const argProvider = (cmd: string) => /-Provider\s+"?([\w.-]+)/i.exec(cmd)?.[1] ?? '';

/**
 * The window running this copy's remote-server.ps1 for the main account (no -Provider). Any remote-server.ps1 under
 * this copy's scripts folder counts, so a window started before the script moved folders is still found.
 */
export function serverWindow(procs: Proc[], root: string): Proc | undefined {
  const scripts = path.win32.join(root, 'scripts').toLowerCase() + '\\';
  const name = path.win32.basename(SCRIPTS.remoteServer).toLowerCase();
  return procs.find((p) => {
    const cmd = p.cmd?.toLowerCase() ?? '';
    const at = cmd.indexOf(scripts);
    // scripts\<name> or scripts\<one folder>\<name>
    const rest = at >= 0 ? cmd.slice(at + scripts.length).split(/["\s]/)[0] : '';
    const isServer = rest === name || (rest.endsWith(`\\${name}`) && rest.split('\\').length === 2);
    return /(^|[\\/"])(powershell|pwsh)\.exe"?\s/.test(cmd) && isServer && !argProvider(cmd);
  });
}

/** Same folder on Windows: resolved, no trailing separator, any case. */
const samePath = (a: string, b: string) => {
  const norm = (p: string) => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

/**
 * bin entries missing for a script that is there, or there for a script that is not (moved without its entry).
 * Neither there is fine: a copy without that feature (a release may leave out original-only scripts with their entries).
 */
function entryProblems(root: string): string[] {
  return (Object.keys(ENTRY_POINTS) as EntryName[]).flatMap((name) => {
    const entry = fs.existsSync(entryPath(name, root));
    const target = fs.existsSync(scriptPath(ENTRY_POINTS[name], root));
    if (entry === target) return [];
    return [entry ? `${ENTRY_DIR}/${name}의 ${SCRIPTS[ENTRY_POINTS[name]]} 없음` : `${ENTRY_DIR}/${name} 없음`];
  });
}

interface ClaudeSettings {
  statusLine?: { command?: string };
  hooks?: { PreToolUse?: { hooks?: { command?: string }[] }[] };
}

export interface UsageHookState {
  /** What keeps this config folder from running a usage guard; [] when nothing does. */
  problems: string[];
  /** Another secretary's hook or status line doing the job for this PC (usage is kept per PC, in ~/.secretary/usage). */
  shared: string[];
  /** Some problem is another secretary's entry whose file is gone: fixed from that secretary's folder, not from here. */
  otherGone: boolean;
}

/**
 * One Claude config folder's settings.json: the status line (it records usage) and the PreToolUse hook should call this
 * copy's bin entries (scripts/usage/install-usage-guard.mjs writes them so). Another secretary's on this PC does the
 * same job and is left alone (shared); an old path of this copy is to be fixed.
 */
export function usageHookState(dir: string, root: string): UsageHookState {
  const settings = readJsonFile<ClaudeSettings>(path.join(dir, 'settings.json')) ?? {};
  const problems: string[] = [];
  const shared: string[] = [];
  let otherGone = false;
  const status = hookKind(settings.statusLine?.command, 'usage-statusline.mjs', root);
  if (status.kind === 'none') problems.push('상태줄 없음');
  else if (status.kind === 'old') problems.push('상태줄이 옛 경로');
  else if (status.kind === 'foreign') problems.push('다른 상태줄');
  else if (status.kind === 'other') shared.push(`상태줄은 다른 비서(${status.folder}) 것을 함께 씀`);
  else if (status.kind === 'other-gone') {
    problems.push(`상태줄이 다른 비서(${status.folder})의 없는 파일을 부름`);
    otherGone = true;
  }
  const guards = (settings.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks ?? []).map((h) => hookKind(h.command, 'usage-guard.mjs', root));
  const other = guards.find((g) => g.kind === 'other');
  const gone = guards.find((g) => g.kind === 'other-gone');
  if (guards.some((g) => g.kind === 'this')) {
    // this copy's guard runs
  } else if (guards.some((g) => g.kind === 'old')) problems.push('정지 훅이 옛 경로');
  else if (other && 'folder' in other) shared.push(`정지 훅은 다른 비서(${other.folder}) 것을 함께 씀`);
  else if (gone && 'folder' in gone) {
    problems.push(`정지 훅이 다른 비서(${gone.folder})의 없는 파일을 부름`);
    otherGone = true;
  } else problems.push('정지 훅 없음');
  return { problems, shared, otherGone };
}

/** What keeps one config folder from running a usage guard ([] when nothing does): usageHookState's problems. */
export const usageHookProblems = (dir: string, root: string): string[] => usageHookState(dir, root).problems;

/** The usage-hooks item's fix when every problem is another secretary's entry whose file is gone. */
const OTHER_GONE_FIX =
  `다른 비서의 훅·상태줄이 그 비서 폴더에서 없어진 파일을 부른다(그 비서를 옮겼거나 업데이트한 뒤). 그 비서 폴더에서 \`node ${SCRIPTS.installUsageGuard}\`를 다시 돌리게 한다. ` +
  '이 비서에서 돌리면 다른 비서의 설정은 건드리지 않는다. 그 비서를 더는 쓰지 않으면(폴더를 지웠으면 옛 경로로 나온다) 사용자에게 물어 그 줄을 지운 뒤 이 비서에서 돌린다';

/** The command that registers this copy's folder variable (from the secretary folder; no administrator needed). */
const setDirCmd = (name: string) => `\`[Environment]::SetEnvironmentVariable('${name}', (Get-Location).Path, 'User')\``;

/** The secretary-dir item's fix: register this copy's own variable SECRETARY_<id>_DIR. */
const dirFix = (name: string) =>
  `비서 폴더의 PowerShell에서 ${setDirCmd(name)} 한 번(관리자 권한 필요 없음, 그 뒤 새로 띄운 프로그램부터 보인다. 비서 폴더를 옮겼으면 새 위치에서 다시). ` +
  `비서 폴더 밖 도구(작업 공간 도구 등)는 이 값에 \`${ENTRY_DIR}\\<이름>\`을 붙여 이 비서의 스크립트를 부른다. 이름에 이 비서의 고유 번호가 들어 있어 한 PC의 비서마다 따로다`;

/** The skills item's fix: one command makes or mends the layout (no administrator needed). */
const SKILL_LINK_FIX =
  `비서 폴더에서 \`node src/cli.ts ${CLI.skillLinks}\` (먼저 보기만: \`--dry-run\`). 스킬 원본은 \`${SKILLS_DIR}/<이름>/\`(Codex·Antigravity가 읽는 곳)에 실제 폴더로 두고, Claude Code가 읽는 \`${CLAUDE_SKILLS_DIR}\`은 그곳을 가리키는 링크(Windows 디렉터리 정션, 관리자 권한 필요 없음) 하나만 둔다. ` +
  `선택 기능의 스킬은 그 기능이 켜져 있으면 \`${SKILLS_DIR}/<이름>/\`, 꺼져 있으면 \`${OFF_SKILLS_DIR}/<이름>/\`(어느 CLI도 읽지 않는 곳)에 두고, 이 명령이 \`features.json\`대로 폴더째 옮긴다(두 곳에 다 있으면 옮기지 않으니 비교해 사용자에게 묻는다). 링크(정션)는 git·배포판에 들어가지 않아 받은 저장소·새 설치·폴더를 옮긴 뒤에는 다시 만든다. 없으면 업무 위임·정리 같은 스킬이 안 읽힌다`;
/** A real folder that meets another of the same name: the command leaves it; what to do is the user's call. */
const REAL_SKILL_FIX =
  `같은 이름이 이미 있어 옮기지 못한 실제 폴더는 명령이 지우거나 합치지 않는다. \`${SKILLS_DIR}/<이름>\`과 비교해 사용자에게 보여 주고 묻는다: 고친 내용을 \`${SKILLS_DIR}/<이름>\`에 옮기고 그 폴더를 지울지(다른 이름의 사용자 스킬이면 \`${SKILLS_DIR}/<새 이름>\`으로 옮길지). 정리한 뒤 \`node src/cli.ts ${CLI.skillLinks}\`를 다시 돌린다`;
/** A skill against the format (setup/skill-spec.ts): no command fixes it, the secretary fixes the skill directly. */
const SPEC_FIX =
  '스킬 사양(agentskills.io): SKILL.md 머리말(`---`)의 name은 폴더 이름과 같게(소문자·숫자·하이픈), description은 무엇을·언제(1024자 안), SKILL.md는 500줄 미만, 옆에는 scripts/(코드)·references/(참고 문서)·assets/(템플릿·설정·데이터)만 둔다(맨 위의 참고 파일은 references/로 옮기고 SKILL.md의 경로를 고친다). 공간 스킬 이름은 common-으로 시작하지 않는다(공통 스킬 링크 이름과 겹친다). 사양 밖 머리말(`---`) 키를 일부러 두는 스킬은 src/setup/skill-spec.ts의 SPEC_KEY_EXCEPTIONS 한 곳에 이유와 함께 적는다';

/** The model files the first automatic download leaves; it skips special_tokens_map.json, which loading does not need. */
export const LOADED_MODEL_FILES = MODEL_FILES.filter((f) => f !== 'special_tokens_map.json');

export const CHECKS: Check[] = [
  {
    id: CHECK.features,
    label: '기능 목록(features.json)',
    fix: '비서 폴더 맨 위 `features.json`을 저장소의 것으로 되돌리거나(`git checkout -- features.json`) JSON 문법을 고친다. 그동안은 꺼 둔 기능까지 모두 켜진 것으로 돈다',
    run: ({ o }) => {
      const problem = featuresProblem(o.root);
      return problem ? { status: 'missing', detail: problem } : ok;
    },
  },
  {
    id: CHECK.db,
    label: '기억 DB',
    fix: '처음 설치라면 정상(빈 DB를 새로 만들었고 대화하며 채워진다). 기억이 있던 PC라면 `SECRETARY_DB` 경로나 `backups/`의 백업을 확인',
    run: ({ o }) => ((o.dbExisted ?? fs.existsSync(o.dbPath)) ? ok : { status: 'missing', detail: `${o.dbPath} 없음` }),
  },
  {
    id: CHECK.npmPackages,
    label: '패키지(npm install)',
    fix: '비서 폴더에서 `npm install` (README 설치 2단계). 없으면 기억 서버(MCP)가 뜨지 않는다',
    run: ({ o }) => {
      const deps = Object.keys(readJsonFile<{ dependencies?: Record<string, string> }>(path.join(o.root, 'package.json'))?.dependencies ?? {});
      return missingOf(deps.filter((d) => !fs.existsSync(path.join(o.root, 'node_modules', d, 'package.json'))));
    },
  },
  {
    id: CHECK.semanticSearchModel,
    label: '의미 검색 모델 파일',
    fix: '처음 쓰는 PC면 정상: 첫 질문 때 의미 검색 서버가 `models/`에 자동으로 받는다(약 570MB, 1분 남짓, 그동안 질문은 받기가 끝나기를 기다린다). 받은 뒤에도 그대로면 인터넷 연결을 확인하고 `node scripts/semantic-search/watch-semantic-search-server.mjs --retry`로 다시 띄운다(README "의미 검색")',
    applies: () => !semanticSearchOff(),
    run: ({ o }) => missingOf(LOADED_MODEL_FILES.filter((f) => !fs.existsSync(path.join(o.modelPath, f)))),
  },
  {
    id: CHECK.skills,
    label: `스킬(${SKILLS_DIR}, ${CLAUDE_SKILLS_DIR} 링크, 공통 스킬)`,
    fix: SKILL_LINK_FIX,
    run: ({ o }) => {
      const layout = skillLayout(o.root);
      const problems = skillLinkProblems(layout);
      // A general release's own common skills first: the folder's links to them need them in _skills.
      const shipped = shippedCommonSkillProblem(o.root, commonSkillsDirOf(o.root));
      if (shipped) problems.push(shipped);
      const common = commonSkillProblem(o.root, commonSkillsDirOf(o.root));
      if (common) problems.push(common);
      // An optional feature's skill in the place of the other state (on: .agents/skills, off: .agents/skills-off).
      problems.push(...formatFeatureSkills(planFeatureSkills(o.root)));
      const spec = [
        formatSpecProblems('비서', skillsDirProblems(path.join(o.root, ...SKILLS_DIR.split('/')), { own: true })),
        formatSpecProblems('공통(_skills)', skillsDirProblems(commonSkillsDirOf(o.root))),
      ].filter((s): s is string => !!s);
      if (!problems.length && !spec.length) return ok;
      if (!problems.length) return { status: 'missing', detail: spec.join(' / '), fix: SPEC_FIX };
      problems.push(...spec);
      // Only real folders in the way: the command leaves them, so the fix is a question to the user first.
      const onlyKept = !common && !spec.length && layout.kept.length > 0 && problems.length === 1;
      const fix = layout.kept.length ? (onlyKept ? REAL_SKILL_FIX : `${SKILL_LINK_FIX}. ${REAL_SKILL_FIX}`) : spec.length ? `${SKILL_LINK_FIX}. ${SPEC_FIX}` : undefined;
      return { status: 'missing', detail: problems.join(' / '), ...(fix ? { fix } : {}) };
    },
  },
  {
    id: CHECK.entryPoints,
    label: `바깥용 진입점 스크립트(${ENTRY_DIR}/)`,
    fix: `비서 폴더에서 \`git checkout -- ${ENTRY_DIR}\`로 되돌린다. 스크립트를 옮긴 뒤라면 그 진입점 파일의 경로를 \`src/core/paths.ts\`의 SCRIPTS에 맞춘다(\`npm test\`의 test/entry-points.test.ts가 맞는 글을 보여 준다). 비서 폴더 밖(공간 도구, 예약 작업, 사용자 설정의 훅·상태줄)이 이 이름으로 비서 스크립트를 부르므로, 없으면 그쪽이 멈춘다`,
    run: ({ o }) => missingOf(entryProblems(o.root)),
  },
  {
    id: CHECK.releaseFiles,
    label: `배포판 파일(${RELEASE_FILES})`,
    fix: `빠진 파일을 받았던 배포판(zip, 또는 GitHub 저장소의 같은 버전 tag)에서 같은 위치로 복사한다. 사용자가 일부러 지운 파일이면 그대로 둘지 묻고, 그대로 두면 \`node src/cli.ts ${CLI.setupCheck} --skip release-files\`로 빼 둔다. 업데이트 중이면 업데이트를 마친 뒤 다시 본다`,
    // Only a general release carries the list (the release builder writes it).
    applies: (o) => fs.existsSync(path.join(o.root, RELEASE_FILES)),
    run: ({ o }) => {
      const list = readReleaseFiles(o.root);
      if (!list) return { status: 'unknown', detail: `${RELEASE_FILES}을 못 읽음` };
      const gone = missingReleaseFiles(o.root, list);
      return gone.length ? { status: 'missing', detail: `빠진 비서 파일 ${gone.length}개: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ' 외' : ''}` } : ok;
    },
  },
  {
    id: CHECK.secretaryDirEnv,
    label: `비서 폴더 환경변수(${SECRETARY_DIR_ENV_TEXT})`,
    fix: `비서 폴더의 PowerShell에서 ${setDirCmd(SECRETARY_DIR_ENV_TEXT)} 한 번(번호는 비서 폴더 \`.secretary-id\`, 관리자 권한 필요 없음). 비서 폴더 밖 도구는 이 값에 \`${ENTRY_DIR}\\<이름>\`을 붙여 비서 스크립트를 부른다`,
    windows: true,
    // This copy's own variable (its secretary id in the name).
    probe: (o) => ({ env: [secretaryDirEnv(readSecretaryId(o.root))] }),
    run: ({ o, probe }) => {
      const name = secretaryDirEnv(readSecretaryId(o.root));
      const value = probe?.env?.[name];
      const fix = dirFix(name);
      if (value === undefined || value === null) return { status: 'unknown', detail: '환경변수 조회 실패' };
      if (!value) return { status: 'missing', detail: `${name} 등록 안 됨`, fix };
      if (samePath(value, o.root)) return ok;
      const owner = ownerOf(value, o.root);
      if (owner.copy) return { status: 'missing', detail: `${name}이 이 비서의 옛 사본(같은 고유 번호)을 가리킴: ${value}`, fix };
      return { status: 'missing', detail: `${name}이 다른 폴더를 가리킴: ${value}`, fix };
    },
  },
  {
    id: CHECK.workspaceLinks,
    label: `작업 공간의 비서 위치 파일(${LINK_FILE})과 공통 스킬 링크`,
    fix: `비서 폴더에서 \`node src/cli.ts ${CLI.workspaceLinks}\` (공간마다 맨 위 \`${LINK_FILE}\`에 이 비서의 진입점 폴더(bin)와 번호를 쓰고 \`.gitignore\`에 넣는다. 스킬 위치도 비서 폴더와 같게 맞춘다: 스킬 원본은 \`.agents/skills/<이름>/\`, \`.claude/skills\`는 그곳을 가리키는 링크(정션) 하나다. 공간의 \`common-skills.json\`에 적힌 공통 스킬(\`workspaces/_skills/common-<이름>\`, 목록에도 \`common-\`까지 적는다)은 \`.agents/skills/common-<이름>\` 링크(정션)와 Antigravity용 \`.agents/skills.json\`으로 붙인다. 먼저 보기만: \`--dry-run\`). 공간 도구는 이 파일로 비서 진입점을 찾고, 없으면 환경변수를 본다. "공통 스킬 없음"은 목록의 이름을 고치거나 _skills에 그 스킬을 만든다. "스킬 사양과 다름"은 명령이 고치지 않는다: ${SPEC_FIX}`,
    // The database's workspaces and run-job's home; a fresh install without workspaces has nothing to look at.
    run: ({ o }) => {
      const bad = linkProblems(o.dbPath, o.root).map((b) => `${path.basename(b.folder)}: ${b.problem}`);
      // The format of each workspace's own skills (setup/skill-spec.ts), apart from the links: no command fixes it.
      for (const f of linkedFolders(o.dbPath, o.root)) {
        const spec = formatSpecProblems(path.basename(f), skillsDirProblems(path.join(f, ...SKILLS_DIR.split('/')), { own: true }));
        if (spec) bad.push(spec);
      }
      return bad.length ? { status: 'missing', detail: bad.join(', ') } : ok;
    },
  },
  {
    id: CHECK.workspaceAuxFolders,
    label: '작업 공간 옆 보조 폴더(_run-job-home, 담당자 폴더 _staff/<담당자>)',
    fix: `비서 폴더에서 \`node src/cli.ts ${CLI.workspaceAuxFolders}\` (먼저 보기만: \`--dry-run\`). 담당자 폴더(\`_staff/<담당자>\`, 역할 AGENTS.md)를 만들고, run-job 기본 폴더 \`_run-job-home\`이 없으면 규칙(AGENTS.md)과 함께 만든다(있는 파일은 고치지 않는다). \`_run-job-home\`이 없으면 run-job이 \`-Folder\` 없이는 멈춘다. 담당자 폴더는 없어도 담당자가 돌 때 만든다`,
    run: ({ o }) => {
      const lines = formatFolderPlan(planAuxFolders(o.root));
      return lines.length ? { status: 'missing', detail: lines.join(', ') } : ok;
    },
  },
  {
    id: CHECK.providerPersonalData,
    label: '공급자 개인정보 값(providers.json의 personalDataAllowed)',
    fix: '비서가 값이 없는 공급자를 사용자에게 보여 주고 공급자마다 개인정보를 보내도 되는지 물어, 고른 대로 `scripts/lib/providers.json`의 그 공급자에 `"personalDataAllowed": true`나 `false`를 넣는다(구독 계정과 사용자 자신의 유료 API 키는 true를 추천, 외부 게이트웨이·무료 플랜·무료 키는 false). 값이 없는 동안은 개인정보를 보내면 안 되는 공급자로 본다: 그 공급자로 도는 run-job·업무 세션에 비서 기억 도구가 붙지 않고, run-job을 비서 폴더에서 돌리지 못한다',
    // Only telling: the user decides each value. The Claude Code providers only, the ones memory tools could go to.
    applies: (o) => fs.existsSync(scriptPath('providers', o.root)),
    run: ({ o }) => {
      const without = providersWithoutPersonalData(scriptPath('providers', o.root));
      if (!without) return { status: 'unknown', detail: 'providers.json을 못 읽음' };
      return missingOf(without.filter(isClaudeCode).map((p) => `${p.name}(${p.type})`));
    },
  },
  {
    id: CHECK.serverTask,
    label: '비서 서버 자동 시작 예약 작업',
    fix: `README "다른 기기에서 쓰기"(선택): 처음 한 번 \`claude auth login\` 후 비서 폴더에서 \`claude remote-control\`을 직접 실행해 \`y\`로 답하고, 관리자 PowerShell에서 \`${SCRIPTS.installScheduledTasks} -Task ${TASK.server}\`. 다른 기기에서 쓰지 않으면 빼 둔다. 없으면 로그인할 때 서버가 안 떠 다른 기기에서 새 비서 세션을 못 열고, 열린 세션만 Remote Control로 쓰면 자주 끊긴다`,
    windows: true,
    probe: taskProbe(TASK.server),
    run: (c) => taskOutcome(c, TASK.server),
  },
  {
    id: CHECK.serverRunning,
    label: '비서 서버 실행',
    fix: `예약 작업이 있으면 \`Start-ScheduledTask -TaskName '<비서 서버 작업 이름>'\`(3~4분 뒤 연결), 안 붙으면 \`${SCRIPTS.serverControl} -Action log\`로 기록을 본다`,
    windows: true,
    probe: () => ({ images: ['powershell.exe', 'pwsh.exe'] }),
    run: ({ o, probe }) => {
      if (!probe?.procs) return { status: 'unknown', detail: '프로세스 조회 실패' };
      const window = serverWindow(probe.procs, o.root);
      const fix = `예약 작업이 있으면 \`Start-ScheduledTask -TaskName '${taskNamesFor(o.root)[TASK.server] ?? TASK.server}'\`(3~4분 뒤 연결), 안 붙으면 \`${SCRIPTS.serverControl} -Action log\`로 기록을 본다`;
      if (window) return { status: 'ok', procs: [window] };
      // A window started with higher rights may hide its command line from this session: it could be the server.
      const unreadable = probe.procs.filter((p) => !p.cmd).length;
      if (unreadable) return { status: 'unknown', detail: `명령줄을 못 읽은 PowerShell 창 ${unreadable}개(권한)` };
      return { status: 'missing', detail: 'remote-server.ps1 창이 없음', fix };
    },
  },
  {
    id: CHECK.backupTask,
    label: '매일 DB 백업 예약 작업',
    fix: `비서 폴더의 PowerShell에서 \`${SCRIPTS.installScheduledTasks} -Task ${TASK.backup}\` (매일 22:30 \`${SCRIPTS.backupDb}\`가 이 PC의 \`backups/\`에 백업하고 14일 지난 것을 지움, 관리자 권한 필요 없음, README "기억 DB 매일 백업"). 안 쓰면 빼 둔다`,
    windows: true,
    probe: taskProbe(TASK.backup),
    run: (c) => taskOutcome(c, TASK.backup),
  },
  {
    id: CHECK.idleJobsTask,
    label: '쉬는 시간 작업 예약 작업(상황판 미리 갱신, 기억 정리)',
    fix: `비서 폴더의 PowerShell에서 \`${SCRIPTS.installScheduledTasks} -Task ${TASK.idleJobs}\` (5분마다 \`${SCRIPTS.idleJobs}\`, 관리자 권한 필요 없음). 없으면 상황판이 새 세션에서만 갱신되고 기억 정리가 자동으로 돌지 않는다`,
    windows: true,
    probe: taskProbe(TASK.idleJobs),
    run: (c) => taskOutcome(c, TASK.idleJobs),
  },
  {
    id: CHECK.usageHooks,
    label: '사용량 정지 훅·상태줄(사용자 설정)',
    fix: `비서 폴더에서 \`node ${SCRIPTS.installUsageGuard}\` (옛 경로로 등록된 것도 \`${ENTRY_DIR}/\` 진입점으로 고친다). 안 쓰면 빼 둔다. 두 번째 구독처럼 다른 설정 폴더는 \`$env:CLAUDE_CONFIG_DIR='<그 폴더>'; node ${SCRIPTS.installUsageGuard}; Remove-Item env:CLAUDE_CONFIG_DIR\`. "다른 상태줄"이면 그 상태줄을 그대로 둘지 사용자에게 묻는다(사용량 기록이 안 돼 정지 장치가 동작하지 않는다). 이 PC의 다른 비서가 등록한 훅·상태줄은 옛 경로로 보지 않고 스크립트도 그대로 둔다(사용량 기록은 PC에 하나라 함께 쓴다)`,
    run: ({ o }) => {
      const states = o.configDirs.filter((d) => fs.existsSync(d)).map((d) => ({ d, ...usageHookState(d, o.root) }));
      const problems = states.flatMap((s) => (s.problems.length ? [`${s.d}: ${s.problems.join(', ')}`] : []));
      if (problems.length) {
        // Only another secretary's broken entries: the fix is in that secretary's folder.
        const onlyOthers = states.every((s) => !s.problems.length || (s.otherGone && s.problems.length === s.problems.filter((p) => p.includes('다른 비서')).length));
        return { status: 'missing', detail: problems.join(', '), ...(onlyOthers ? { fix: OTHER_GONE_FIX } : {}) };
      }
      const shared = states.flatMap((s) => (s.shared.length ? [`${s.d}: ${s.shared.join(', ')}`] : []));
      return shared.length ? { status: 'ok', detail: shared.join(', ') } : ok;
    },
  },
  {
    id: CHECK.phonePush,
    label: '끝 알림 서버(ntfy)',
    fix: `\`${THIS_SECRETARY_FILE}\`의 \`${FEATURE.phonePush}\` 키의 url·topic을 확인한다(\`src/phone-push/ntfy.ts\` 맨 위 주석). 이 PC의 ntfy 서버가 꺼져 있으면 예약 작업을 띄운다: \`Start-ScheduledTask -TaskName '<Secretary ntfy Server (고유 번호)>'\`(관리자 불필요). 작업이 없으면 \`${SCRIPTS.installNtfy}\`(server.yml도 만든다). 그동안은 답이 끝나도 폰 알림이 안 간다(보내기 실패는 ~/.secretary/<비서 고유 번호>/logs/notify.log)`,
    windows: true,
    // Only where the section is (this PC chose to send); its server is looked for only when it is on this PC.
    applies: (o) => hasThisSecretary(FEATURE.phonePush, o.root),
    probe: () => ({ images: ['ntfy.exe'] }),
    run: ({ o, probe }) => {
      const { settings, problem } = readNotifySettings(o.root);
      if (!settings) return problem ? { status: 'missing', detail: `설정 파일 문제: ${problem}` } : ok;
      if (problem) return { status: 'missing', detail: `설정 파일 문제: ${problem}` };
      const host = new URL(settings.url).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return { status: 'ok', detail: `다른 곳의 서버(${host})라 프로세스는 보지 않음` };
      if (!probe?.procs) return { status: 'unknown', detail: '프로세스 조회 실패' };
      const proc = probe.procs.find((p) => p.name.toLowerCase() === 'ntfy.exe');
      return proc ? { status: 'ok', procs: [proc] } : { status: 'missing', detail: 'ntfy.exe가 안 떠 있음' };
    },
  },
  // Feature 'external-providers' (off until the user turns it on): the default provider's key.
  {
    id: CHECK.providerKey,
    label: '기본 공급자 키 파일',
    fix: '`feature-toggle` 스킬의 공급자 안내(`.agents/skills/feature-toggle/references/external-providers.md`)대로 키 폴더에 `<공급자이름>.env`를 사용자가 직접 둔다(업무 세션·run-job이 이 공급자로 돈다)',
    run: ({ o }) => {
      const config = readJsonFile<{ default?: string; providers?: Record<string, { type?: string }> }>(scriptPath('providers', o.root));
      const def = config?.default;
      // The PC's own subscription login needs no key file.
      if (!def || def === 'subscription') return ok;
      // "auto" (feature multi-subscription): any subscription but a may be picked, so each needs its key file.
      const names = def === 'auto' ? Object.entries(config?.providers ?? {}).filter(([n, p]) => p?.type === 'claude-subscription' && n !== 'subscription').map(([n]) => n) : [def];
      const absent = names.map((n) => path.join(o.keysDir, `${n}.env`)).filter((f) => !fs.existsSync(f));
      return absent.length ? { status: 'missing', detail: absent.map((f) => `${f} 없음`).join(', ') } : ok;
    },
  },
];

/** The items whose feature is on in root's features.json (all of them without the file). */
export function activeChecks(root: string, checks: Check[] = CHECKS): Check[] {
  const off = disabledItems('checks', root);
  return checks.filter((c) => !off.has(c.id));
}
