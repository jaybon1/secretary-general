/**
 * The aux folders beside the workspaces (in the workspaces folder, not workspaces: their names start with _):
 * _skills (common skills), _sandbox (throwaway tests), _run-job-home (run-job's default folder), _archived (retired
 * workspaces), and _staff with each staff member's run folder (staff/staff.ts, e.g. _staff/memory-consolidation).
 *
 * `node src/cli.ts workspace-aux-folders` (install check 'workspace-aux-folders') makes each staff member's folder, and
 * run-job's default folder _run-job-home when it is missing (its rules AGENTS.md, CLAUDE.md, .gitignore, common-skills.json,
 * then the secretary link and skill links): run-job stops with an error without it (2026-11-09), so a new install gets it
 * from the install check. Files already there are never rewritten here (the user may have changed the rules); the
 * secretary block of its AGENTS.md follows the template through workspace-links like a workspace's
 * (workspace/charter-blocks.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fixStaffFolder, readStaff, STAFF_NAMES, staffFolderProblems } from '../staff/staff.ts';
import { SKILL_GITIGNORE_LINES } from '../workspace/skill-links.ts';
import { COMMON_SKILLS_ABOUT, COMMON_SKILLS_FILE } from '../workspace/common-skills.ts';
import { CLAUDE_IMPORT } from '../workspace/workspace-paths.ts';
import { renderRunJobHome, RUN_JOB_HOME_SKILLS } from '../workspace/rules-text.ts';
import { commonSkillsDirOf, GITIGNORE_LINES, RUN_JOB_HOME, workspaceRootOf, writeLink } from '../workspace/secretary-link.ts';

/** What run-job's default folder holds when made (workspaces/_run-job-home); its common skills only those in _skills. */
export function runJobHomeFiles(root: string): Record<string, string> {
  const skills = RUN_JOB_HOME_SKILLS.filter((n) => fs.existsSync(path.join(commonSkillsDirOf(root), n, 'SKILL.md')));
  return {
    'AGENTS.md': renderRunJobHome(),
    'CLAUDE.md': CLAUDE_IMPORT,
    '.gitignore': [...GITIGNORE_LINES, '', ...SKILL_GITIGNORE_LINES, ''].join('\n'),
    [COMMON_SKILLS_FILE]: `${JSON.stringify({ about: COMMON_SKILLS_ABOUT, skills }, null, 2)}\n`,
  };
}

/** run-job's default folder files missing (named under _run-job-home); all of them when the folder is. */
function runJobHomeMissing(root: string): string[] {
  const dir = path.join(workspaceRootOf(root), RUN_JOB_HOME);
  return Object.keys(runJobHomeFiles(root))
    .filter((n) => !fs.existsSync(path.join(dir, n)))
    .map((n) => `${RUN_JOB_HOME}/${n}`);
}

/** Makes what is missing of run-job's default folder (never rewrites a file), then its secretary link and skill links. */
function fixRunJobHome(root: string): void {
  const dir = path.join(workspaceRootOf(root), RUN_JOB_HOME);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, text] of Object.entries(runJobHomeFiles(root))) {
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) fs.writeFileSync(f, text);
  }
  fs.mkdirSync(path.join(dir, 'output', 'research'), { recursive: true });
  writeLink(dir, root);
}

export interface FolderPlan {
  /** Staff folders to make or put right. */
  staff: string[];
  /** run-job's default folder: files to make. */
  runJobHome: string[];
}

/** What `workspace-aux-folders` would do for the secretary at root. */
export function planAuxFolders(root: string): FolderPlan {
  return { staff: STAFF_NAMES.flatMap((name) => staffFolderProblems(readStaff(name, root), root)), runJobHome: runJobHomeMissing(root) };
}

/** The plan as lines for the install check and the command. */
export function formatFolderPlan(p: FolderPlan, done = false): string[] {
  return [
    ...p.staff.map((w) => `${done ? '담당자 폴더 고침' : '담당자 폴더 고칠 것'}: ${w}`),
    ...(p.runJobHome.length ? [`${done ? 'run-job 기본 폴더 만듦' : 'run-job 기본 폴더 만들 것'}: ${p.runJobHome.join(', ')}`] : []),
  ];
}

/** Does the plan: the staff folders, then run-job's default folder when something of it is missing. */
export function fixAuxFolders(root: string): FolderPlan {
  const plan = planAuxFolders(root);
  for (const name of STAFF_NAMES) fixStaffFolder(readStaff(name, root), root);
  if (runJobHomeMissing(root).length) fixRunJobHome(root);
  return plan;
}