/**
 * How a workspace's tools find the secretary's scripts: a small `secretary.json` at the top of each workspace folder,
 * written by the secretary ({ bin: the secretary's entrance folder bin/, id: its install id }). Only the entrance
 * folder is named, not the secretary folder itself: tools call the fixed names in bin/ (core/paths.ts ENTRY_POINTS)
 * and nothing else of the secretary (a worker's shell commands that touch the secretary folder otherwise are blocked,
 * scripts/worker/worker-guard.mjs). A tool reads the file (searching upward from its own folder; the code is in the
 * workspace charter, workspace/rules-text.ts findSecretaryCode) instead of an environment variable, so it needs no
 * variable name and a workspace moved to another secretary changes one file. Paths differ per PC, so the file stays
 * out of the workspace's git (.gitignore).
 *
 * Written when a workspace is made (workspace/folders.ts) and put right whenever a task is handed to it
 * (create_task); the install check (setup/check-items.ts 'workspace-links') lists workspaces whose file is missing or
 * points elsewhere, and `node src/cli.ts workspace-links` fixes them all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENTRY_DIR } from '../core/paths.ts';
import { readInstallId } from '../setup/install-id.ts';
import { fixSkillLinks, SKILLS_DIR, skillLayout, skillLinkProblems } from '../setup/skill-links.ts';
import { COMMON_PREFIX, COMMON_SKILLS_DIR, commonSkillProblem, fixCommonSkills } from './common-skills.ts';

export const LINK_FILE = 'secretary.json';
/** The folder run-job works in when not given one (scripts/run-job/run-job.ps1); not a workspace in the database. */
export const RUN_JOB_HOME = 'run-job-home';

export interface SecretaryLink {
  about?: string;
  /** The secretary's entrance folder (<secretary folder>/bin). */
  bin: string;
  /** Its install id (setup/install-id.ts); absent while it has none. */
  id?: string;
}

const ABOUT = '비서가 써 두는 파일: 이 공간을 맡은 비서의 입구 폴더(bin)와 비서 고유 번호(id). 공간 도구는 이 bin 안의 이름으로만 비서 스크립트를 부른다. PC마다 달라 커밋하지 않는다(.gitignore).';

/** What the file should hold for the secretary at root. */
export function linkFor(root: string): SecretaryLink {
  const id = readInstallId(root);
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
    return fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').split(/\r?\n/).some((l) => l.trim() === LINK_FILE || l.trim() === `/${LINK_FILE}`);
  } catch {
    return false;
  }
};

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
  return skillProblem(folder, root);
}

/** The skill layout (setup/skill-links.ts), the charter's skill path and the common skills of a workspace; null when right. */
export function skillProblem(folder: string, root: string): string | null {
  const out = skillLinkProblems(skillLayout(folder));
  if (oldCharter(folder)) out.push('AGENTS.md에 옛 스킬 구조의 글(skills/ 경로, 스킬 목록 가리키기, 빈 스킬 목록)이 남음');
  const common = commonSkillProblem(folder, commonSkillsDirOf(root));
  if (common) out.push(common);
  return out.length ? out.join('; ') : null;
}

/**
 * What the workspace charter had before .agents/skills (workspace/rules-text.ts renderLearning, renderCharter): the skill
 * path, the start rule that pointed at the skill list, and the list kept by hand (the CLIs now list skills by their
 * description). Only an empty list goes by itself; a list with skills is the secretary's to fold into the skills'
 * descriptions first.
 */
const CHARTER_FIXES: [string, string][] = [
  ['업무 종류별 스킬(`skills/<이름>/SKILL.md`', `업무 종류별 스킬(\`${SKILLS_DIR}/<이름>/SKILL.md\``],
  ['아래 "스킬과 기억"의 목록에 맞는 스킬이 있으면', `맞는 스킬(\`${SKILLS_DIR}/\`, 공통 스킬은 \`${COMMON_PREFIX}<이름>\`)이 있으면`],
];
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
  return CHARTER_FIXES.some(([a]) => text.includes(a)) || EMPTY_LIST.test(text);
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
  const text = `${JSON.stringify(linkFor(root), null, 2)}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  fixSkillLinks(folder);
  fixCommonSkills(folder, commonSkillsDirOf(root));
  if (oldCharter(folder)) {
    let text = charterText(folder);
    for (const [a, b] of CHARTER_FIXES) text = text.replaceAll(a, b);
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), text.replace(EMPTY_LIST, ''));
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
