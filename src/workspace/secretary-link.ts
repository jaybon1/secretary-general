/**
 * How a workspace's tools find the secretary's scripts: a small `secretary-link.local.json` at the top of each workspace
 * folder (until 2026-11-10 `secretary.json`: OLD_LINK_FILE below),
 * written by the secretary ({ bin: the secretary's entrance folder bin/, id: its secretary id }). Only the entrance
 * folder is named, not the secretary folder itself: tools call the fixed names in bin/ (core/paths.ts ENTRY_POINTS)
 * and nothing else of the secretary (a worker's shell commands that touch the secretary folder otherwise are blocked,
 * scripts/worker/worker-folder-guard.mjs). A tool reads the file (searching upward from its own folder; the code is in the
 * workspace charter, workspace/rules-text.ts findSecretaryCode) instead of an environment variable, so it needs no
 * variable name and a workspace moved to another secretary changes one file. Paths differ per PC, so the file stays
 * out of the workspace's git (.gitignore).
 *
 * Written when a workspace is made (workspace/workspace-create.ts) and put right whenever a task is handed to it
 * (create_task); the install check (setup/check-items.ts 'workspace-links') lists workspaces whose file is missing or
 * points elsewhere, and `node src/cli.ts workspace-links` fixes them all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENTRY_DIR, LEGACY_SECRETARY_DIR_ENV, secretaryDirEnv } from '../core/paths.ts';
import { readSecretaryId } from '../setup/secretary-id.ts';
import { fixSkillLinks, SKILLS_DIR, skillLayout, skillLinkProblems } from '../setup/skill-links.ts';
import { COMMON_PREFIX, COMMON_SKILLS_DIR, commonSkillProblem, fixCommonSkills } from './common-skills.ts';

export const LINK_FILE = 'secretary-link.local.json';
/**
 * The file's name until 2026-11-10. Workspace tools that copied the old finding code read it, so while one is there the
 * secretary keeps it the same as the new one (writeLink; never makes a new one), and workspace-links rewrites the
 * charter's code to the new name (LINK_NAME_FIXES). Goes once 0.10.0 is out and the workspaces' tools read the new name.
 */
export const OLD_LINK_FILE = 'secretary.json'; // legacy-name: secretary-link-file
/** The folder run-job works in when not given one (scripts/run-job/run-job.ps1); not a workspace in the database. */
export const RUN_JOB_HOME = '_run-job-home';

export interface SecretaryLink {
  about?: string;
  /** The secretary's entrance folder (<secretary folder>/bin). */
  bin: string;
  /** Its secretary id (setup/secretary-id.ts); absent while it has none. */
  id?: string;
}

const ABOUT = '비서가 써 두는 파일: 이 공간을 맡은 비서의 입구 폴더(bin)와 비서 고유 번호(id). 공간 도구는 이 bin 안의 이름으로만 비서 스크립트를 부른다. PC마다 달라 커밋하지 않는다(.gitignore).';

/** The file's text for the secretary at root. */
const linkText = (root: string) => `${JSON.stringify(linkFor(root), null, 2)}\n`;

/** What the file should hold for the secretary at root. */
export function linkFor(root: string): SecretaryLink {
  const id = readSecretaryId(root);
  return { about: ABOUT, bin: path.join(path.resolve(root), ENTRY_DIR), ...(id ? { id } : {}) };
}

export function readLink(folder: string): SecretaryLink | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(folder, LINK_FILE), 'utf8').replace(/^﻿/, ''));
    return v && typeof v.bin === 'string' ? v : null;
  } catch {
    return null;
  }
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

const ignores = (folder: string) => {
  try {
    return fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').split(/\r?\n/).some((l) => [LINK_FILE, `/${LINK_FILE}`, '*.local.json'].includes(l.trim()));
  } catch {
    return false;
  }
};

/** The old-name file's text when it is there and not the same as the new one (it is kept the same while there). */
function staleOldLink(folder: string, text: string): boolean { // legacy-name: secretary-link-file
  const old = path.join(folder, OLD_LINK_FILE);
  try {
    return fs.readFileSync(old, 'utf8') !== text;
  } catch {
    return false;
  }
}

/**
 * The charter's finding code and sentence with the old file name (workspace/rules-text.ts findSecretaryCode,
 * renderFindSecretary, until 2026-11-10) → the new name; workspace-links rewrites them.
 */
const LINK_NAME_FIXES: [string, string][] = [ // legacy-name: secretary-link-file
  [`f = d / "${OLD_LINK_FILE}"`, `f = d / "${LINK_FILE}"`],
  [`$f = Join-Path $d '${OLD_LINK_FILE}'`, `$f = Join-Path $d '${LINK_FILE}'`],
  [`const f = path.join(d, '${OLD_LINK_FILE}');`, `const f = path.join(d, '${LINK_FILE}');`],
  [`입구 폴더는 이 공간 맨 위 \`${OLD_LINK_FILE}\`의 \`bin\`이다`, `입구 폴더는 이 공간 맨 위 \`${LINK_FILE}\`의 \`bin\`이다`],
];

/** Why folder's link is not right for the secretary at root; null when it is. */
export function linkProblem(folder: string, root: string): string | null {
  const file = path.join(folder, LINK_FILE);
  const link = readLink(folder);
  const want = linkFor(root);
  if (!link) return fs.existsSync(file) ? `${LINK_FILE}을 못 읽음` : `${LINK_FILE} 없음`;
  if (norm(link.bin) !== norm(want.bin)) return `다른 폴더를 가리킴: ${link.bin}`;
  if ((link.id ?? null) !== (want.id ?? null)) return `번호가 다름: ${link.id ?? '(없음)'}`;
  if (Object.keys(link).some((k) => !['about', 'bin', 'id'].includes(k))) return '다른 칸이 있음';
  if (!ignores(folder)) return `.gitignore에 ${LINK_FILE} 없음`;
  if (staleOldLink(folder, linkText(root))) return `옛 이름 ${OLD_LINK_FILE}이 새 파일과 다름`;
  return skillProblem(folder, root);
}

/** The skill layout (setup/skill-links.ts), the charter's skill path and the common skills of a workspace; null when right. */
export function skillProblem(folder: string, root: string): string | null {
  const out = skillLinkProblems(skillLayout(folder));
  if (oldCharter(folder)) out.push('AGENTS.md에 옛 스킬 구조의 글(skills/ 경로, 스킬 목록 가리키기, 빈 스킬 목록, 스킬 만드는 법, common- 없는 공통 스킬 경로)이 남음');
  if (oldFindText(folder, root)) out.push(`AGENTS.md의 비서 입구 찾는 글이 옛 꼴(옛 환경변수 ${LEGACY_SECRETARY_DIR_ENV}나 옛 파일 이름 ${OLD_LINK_FILE}, 또는 못 찾을 때 알림 없는 파이썬 코드)`);
  const common = commonSkillProblem(folder, commonSkillsDirOf(root));
  if (common) out.push(common);
  return out.length ? out.join('; ') : null;
}

/**
 * What the workspace charter had before .agents/skills (workspace/rules-text.ts renderLearning, renderCharter): the skill
 * path, the start rule that pointed at the skill list, and the list the secretary kept itself (the CLIs now list skills by their
 * description). Only an empty list goes by itself; a list with skills is the secretary's to fold into the skills'
 * descriptions first.
 */
/**
 * How a skill is made (agentskills.io, setup/skill-spec.ts checks it): the charter's "스킬과 기억" sentence
 * (workspace/rules-text.ts renderLearning); a charter with the sentence from before 2026-11-09 gets it (CHARTER_FIXES).
 */
export const SKILL_FORMAT_RULE =
  '새 스킬은 머리말에 name(폴더 이름과 같게, 소문자·숫자·하이픈, `common-`으로 시작하지 않음)과 description(무엇을 하고 언제 쓰는지 한 줄)을 넣어 만든다(agentskills.io 사양). SKILL.md는 500줄 미만으로 원칙과 "언제 어느 파일을 읽을지"만 두고, 스킬이 쓰는 코드는 그 폴더의 `scripts/`, 참고 문서는 `references/`, 템플릿·설정·데이터는 `assets/`에 둔다. 남이 만든 설치본·가상환경은 스킬에 넣지 않고 사용자 폴더 `%USERPROFILE%\\tools`에 둔다.';
const CHARTER_FIXES: [string, string][] = [ // legacy-name: charter-skill-text
  ['업무 종류별 스킬(`skills/<이름>/SKILL.md`', `업무 종류별 스킬(\`${SKILLS_DIR}/<이름>/SKILL.md\``],
  ['아래 "스킬과 기억"의 목록에 맞는 스킬이 있으면', `맞는 스킬(\`${SKILLS_DIR}/\`, 공통 스킬은 \`${COMMON_PREFIX}<이름>\`)이 있으면`],
  ['새 스킬은 머리말에 이름과 언제 쓰는지 한 줄(description)을 넣어 만든다.', SKILL_FORMAT_RULE],
  // A charter from before the skill-making sentence: the "스킬과 기억" paragraph ends at the history files.
  ['(업무별 항목)에 따로 둔다.\n', `(업무별 항목)에 따로 둔다. ${SKILL_FORMAT_RULE}\n`],
  ['(업무별 항목)에 따로 둔다.\r\n', `(업무별 항목)에 따로 둔다. ${SKILL_FORMAT_RULE}\r\n`],
];
/**
 * The charter's lines on finding the secretary (workspace/rules-text.ts renderFindSecretary, findSecretaryCode) as written
 * until 2026-11-10, with the old SECRETARY_DIR read after this secretary's own variable, and as written now (old → new).
 * workspace-links rewrites them; the tools that copied the old code keep working while the scripts still set the old
 * variable (scripts/lib/common.ps1 Get-SecretaryDirVars). None for a copy without an id (its variable is the old name).
 */
export function oldFindSecretaryFixes(root: string): [string, string][] { // legacy-name: charter-find-text
  const env = secretaryDirEnv(readSecretaryId(root));
  const old = LEGACY_SECRETARY_DIR_ENV;
  if (env === old) return [];
  return [
    [`환경변수 \`${env}\` 아래 \`${ENTRY_DIR}\`, 그다음 환경변수 \`${old}\` 아래 \`${ENTRY_DIR}\`을 쓴다`, `환경변수 \`${env}\` 아래 \`${ENTRY_DIR}\`을 쓴다`],
    [`os.environ.get("${env}") or os.environ.get("${old}")`, `os.environ.get("${env}")`],
    [`@($env:${env}, $env:${old})`, `@($env:${env})`],
    [`process.env.${env} || process.env.${old};`, `process.env.${env};`],
    // Until 2026-11-10 the Python code ended on Path(<variable>) and stopped with a bare TypeError when neither was there.
    [`    return Path(os.environ.get("${env}")) / "${ENTRY_DIR}"`, pythonFallbackLines(env).join('\n')],
  ];
}

/**
 * The end of the charter's Python finding code (workspace/rules-text.ts findSecretaryCode): with no link file found, this
 * secretary's variable, and a plain message rather than Path(None)'s TypeError when that is empty too.
 */
export function pythonFallbackLines(env: string): string[] {
  return [
    `    d = os.environ.get("${env}")`,
    `    if not d: raise SystemExit("비서 입구를 못 찾음: 위 폴더들에 비서 위치 파일이 없고 환경변수 ${env}도 비었다(비서에게 workspace-links를 부탁한다)")`,
    `    return Path(d) / "${ENTRY_DIR}"`,
  ];
}

/** A path to a common skill in its old folder (…\_skills\web-tools\…, before the common- prefix, 2026-11-09). */
const OLD_COMMON_PATH = /([\\/]_skills[\\/]+)(?!common-)([a-z0-9][a-z0-9-]*)(?=[\\/])/g; // legacy-name: common-skill-prefix
const EMPTY_LIST = /\n스킬 목록\(새 스킬이 생기면 비서가 이름과 한 줄 설명을 더한다\):\r?\n\r?\n- 아직 없음\r?\n/;
const charterText = (folder: string) => {
  try {
    return fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8');
  } catch {
    return '';
  }
};
const oldCharter = (folder: string) => {
  const text = charterText(folder);
  return CHARTER_FIXES.some(([a]) => text.includes(a)) || EMPTY_LIST.test(text) || new RegExp(OLD_COMMON_PATH.source).test(text);
};

const oldFindText = (folder: string, root: string) => {
  const text = charterText(folder);
  return [...oldFindSecretaryFixes(root), ...LINK_NAME_FIXES].some(([a]) => text.includes(a));
};

/** The common skills folder for the secretary at root (workspace/common-skills.ts). */
export const commonSkillsDirOf = (root: string) => path.join(workspaceRootOf(root), COMMON_SKILLS_DIR);

/** The lines .gitignore gets: the reason, then the file. */
export const GITIGNORE_LINES = ['# 이 공간을 맡은 비서의 입구 폴더(비서가 써 둔다, PC마다 다르다)', LINK_FILE];

/**
 * Writes folder's link for the secretary at root, and its .gitignore line first (so a worker's `git add -A` never
 * takes it). Returns whether anything changed.
 */
export function writeLink(folder: string, root: string): boolean {
  if (!linkProblem(folder, root)) return false;
  if (!ignores(folder)) {
    const file = path.join(folder, '.gitignore');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const sep = old && !old.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, `${old}${sep}${GITIGNORE_LINES.join('\n')}\n`);
  }
  const file = path.join(folder, LINK_FILE);
  const text = linkText(root);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  // The old-name file, where it is, is kept the same for tools that still read it (never made new).
  if (staleOldLink(folder, text)) fs.writeFileSync(path.join(folder, OLD_LINK_FILE), text); // legacy-name: secretary-link-file
  fixSkillLinks(folder);
  fixCommonSkills(folder, commonSkillsDirOf(root));
  if (oldCharter(folder) || oldFindText(folder, root)) {
    let text = charterText(folder);
    for (const [a, b] of [...CHARTER_FIXES, ...oldFindSecretaryFixes(root), ...LINK_NAME_FIXES]) text = text.replaceAll(a, b);
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), text.replace(EMPTY_LIST, '').replace(OLD_COMMON_PATH, `$1${COMMON_PREFIX}$2`));
  }
  return true;
}

/** Where workspaces live for the secretary at root (core/config.ts WORKSPACE_ROOT, for any root). */
export const workspaceRootOf = (root: string) => process.env.SECRETARY_WORKSPACE_ROOT ?? path.join(path.dirname(path.resolve(root)), 'workspaces');

/**
 * The folders that should carry a link: every workspace in the database that takes work and is on this PC, and
 * run-job's home folder. A workspace recorded at a path that is gone is left to create_task (it finds moved ones).
 */
export function linkedFolders(dbPath: string, root: string): string[] {
  const folders: string[] = [];
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get();
      if (has) for (const r of db.prepare('SELECT folder FROM workspaces WHERE archived_at IS NULL ORDER BY id').all() as { folder: string }[]) folders.push(r.folder);
    } finally {
      db.close();
    }
  }
  folders.push(path.join(workspaceRootOf(root), RUN_JOB_HOME));
  const seen = new Set<string>();
  return folders.filter((f) => fs.existsSync(f) && fs.statSync(f).isDirectory() && !seen.has(norm(f)) && !!seen.add(norm(f)));
}

/** Each linked folder whose link is not right, with why. */
export function linkProblems(dbPath: string, root: string): { folder: string; problem: string }[] {
  return linkedFolders(dbPath, root).flatMap((folder) => {
    const problem = linkProblem(folder, root);
    return problem ? [{ folder, problem }] : [];
  });
}
