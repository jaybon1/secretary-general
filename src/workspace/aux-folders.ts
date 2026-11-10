/**
 * The aux folders beside the workspaces (in the workspaces folder, not workspaces: their names start with _):
 * _skills (common skills), _sandbox (throwaway tests), _run-job-home (run-job's default folder), _archived (retired
 * workspaces), and _staff with each staff member's run folder (staff/staff.ts, e.g. _staff/memory-consolidation).
 *
 * Two of them had other names before 2026-11-09: run-job-home, and old (later on 2026-11-09 _old, then _archived). `node src/cli.ts workspace-aux-folders`
 * (install check 'workspace-aux-folders') moves them to the new name (no link is left at the old name) and points the
 * database's workspaces recorded under old\ or _old\ (retired ones) at _archived\; a folder the user moved is followed the same way.
 * It also makes each staff member's folder, and run-job's default folder _run-job-home when it is missing (its rules
 * AGENTS.md, CLAUDE.md, .gitignore, common-skills.json, then the secretary link and skill links): run-job stops with an
 * error without it (2026-11-09), so a new install gets it from the install check. Files already there are never
 * rewritten (the user may have changed the rules). A release's user gets the same by the same command after an update;
 * a copy that never had the old folders has nothing to move.
 *
 * The staff members' folders were _consolidate and _board until later on 2026-11-09 (renamed memory-consolidation and
 * situation-board, each in _workers/<name>), then _staff/<name> (2026-11-09, "worker" kept for work sessions). The same
 * command moves them from either old place (run records kept, no link at the old name; an emptied _workers goes);
 * when a run has already made the new folder, the old one is merged into it: its run records go before the new ones,
 * its role files are dropped (the staff member's file makes them), and anything else stays for the user if the new folder
 * has the same name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixStaffFolder, OLD_STAFF_HOME, readStaff, STAFF_NAMES, STAFF_OLD_FOLDERS, staffFolder, staffFolderFiles, staffFolderProblems } from '../staff/staff.ts';
import { SKILL_GITIGNORE_LINES } from '../setup/skill-links.ts';
import { COMMON_SKILLS_ABOUT, COMMON_SKILLS_FILE } from './common-skills.ts';
import { CLAUDE_IMPORT } from './workspace-paths.ts';
import { renderRunJobHome, RUN_JOB_HOME_SKILLS } from './rules-text.ts';
import { commonSkillsDirOf, GITIGNORE_LINES, RUN_JOB_HOME, workspaceRootOf, writeLink } from './secretary-link.ts';

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

/** run-job's default folder files missing in dir (named under _run-job-home); all of them when the folder is. */
function runJobHomeMissing(root: string, dir = path.join(workspaceRootOf(root), RUN_JOB_HOME)): string[] {
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

/** Old name → new name, in the workspaces folder. */
export const AUX_RENAMES: { from: string; to: string }[] = [
  { from: 'run-job-home', to: '_run-job-home' },
  { from: 'old', to: '_archived' },
  { from: '_old', to: '_archived' },
];

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** Whether `p` is `dir` or inside it (any case, either slash). */
const under = (p: string, dir: string) => {
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(b + path.sep) || a.startsWith(`${b}/`);
};

export interface FolderPlan {
  /** Folders to rename (old name there, new name not). */
  rename: { from: string; to: string }[];
  /** Both names there: left for the user. */
  both: { from: string; to: string }[];
  /** Database workspaces recorded under an old folder: pointed at the new one. */
  repath: { id: number; title: string; from: string; to: string }[];
  /** Old staff folders (_consolidate, _board, _workers/<name>) to move to _staff/<name>; merge when the new one is there already. */
  staffMoves: { from: string; to: string; merge: boolean }[];
  /** Staff folders to make or put right. */
  staff: string[];
  /** run-job's default folder: files to make (none when an old run-job-home is moved there instead). */
  runJobHome: string[];
}

interface WorkspaceRow {
  id: number;
  title: string;
  folder: string;
}

function readWorkspaces(dbPath: string): WorkspaceRow[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get();
    return has ? (db.prepare('SELECT id, title, folder FROM workspaces ORDER BY id').all() as unknown as WorkspaceRow[]) : [];
  } finally {
    db.close();
  }
}

/** What `workspace-aux-folders` would do for the secretary at root. */
export function planAuxFolders(root: string, dbPath: string): FolderPlan {
  const ws = workspaceRootOf(root);
  const plan: FolderPlan = { rename: [], both: [], repath: [], staffMoves: [], staff: [], runJobHome: [] };
  for (const r of AUX_RENAMES) {
    const from = path.join(ws, r.from);
    const to = path.join(ws, r.to);
    if (!fs.existsSync(from)) continue;
    (fs.existsSync(to) ? plan.both : plan.rename).push({ from, to });
  }
  for (const w of readWorkspaces(dbPath)) {
    for (const r of AUX_RENAMES) {
      const from = path.join(ws, r.from);
      if (!under(w.folder, from)) continue;
      const rest = path.resolve(w.folder).slice(norm(from).length).replace(/^[\\/]+/, '');
      plan.repath.push({ id: w.id, title: w.title, from: w.folder, to: path.join(ws, r.to, rest) });
    }
  }
  for (const name of STAFF_NAMES) {
    const w = readStaff(name, root);
    const to = staffFolder(w, root);
    // Oldest first: the first one there moves (or merges into a new folder already there), the next ones merge into it.
    const olds = STAFF_OLD_FOLDERS[name].map((o) => path.join(ws, ...o.split('/'))).filter((o) => fs.existsSync(o));
    olds.forEach((from, i) => plan.staffMoves.push({ from, to, merge: i > 0 || fs.existsSync(to) }));
    // An old folder about to be moved there is the folder: what it lacks is put right after the move.
    const moved = olds.length && !fs.existsSync(to) ? olds[0] : to;
    const problems = staffFolderProblems(w, root, moved);
    if (problems.length) plan.staff.push(...problems);
  }
  // An old run-job-home about to be moved there is the folder: what it lacks is made after the move.
  const moving = plan.rename.find((r) => path.basename(r.to) === RUN_JOB_HOME);
  plan.runJobHome = runJobHomeMissing(root, moving?.from);
  return plan;
}

/** The plan as lines for the install check and the command. */
export function formatFolderPlan(p: FolderPlan, done = false): string[] {
  const verb = done ? '옮김' : '옮길 것';
  return [
    ...p.rename.map((r) => `${verb}: ${r.from} → ${r.to}`),
    ...p.both.map((r) => `둘 다 있어 옮기지 않음(사용자에게 묻는다): ${r.from}, ${r.to}`),
    ...p.repath.map((r) => `${done ? 'DB 고침' : 'DB 고칠 것'}: 공간 #${r.id} ${r.title} ${r.from} → ${r.to}`),
    ...p.staffMoves.map((r) =>
      r.merge ? `${done ? '담당자 폴더 합침' : '담당자 폴더 합칠 것'}(새 폴더가 이미 있어 실행 기록을 이어 붙임): ${r.from} → ${r.to}` : `${verb}: ${r.from} → ${r.to}`,
    ),
    ...p.staff.map((w) => `${done ? '담당자 폴더 고침' : '담당자 폴더 고칠 것'}: ${w}`),
    ...(p.runJobHome.length ? [`${done ? 'run-job 기본 폴더 만듦' : 'run-job 기본 폴더 만들 것'}: ${p.runJobHome.join(', ')}`] : []),
  ];
}

const RUN_RECORDS = /^runs-.+\.jsonl$/;

/**
 * Merges an old staff folder into its new one: run records go before the new folder's (same file name) or move as they
 * are; the old role files are dropped; anything else moves when the new folder has no such name. Removes the old
 * folder when emptied; returns what was left.
 */
function mergeStaffFolder(from: string, to: string, roleFiles: string[]): string[] {
  const left: string[] = [];
  for (const n of fs.readdirSync(from)) {
    const src = path.join(from, n);
    const dst = path.join(to, n);
    if (roleFiles.includes(n)) fs.rmSync(src, { force: true });
    else if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    else if (RUN_RECORDS.test(n) && fs.statSync(src).isFile()) {
      fs.writeFileSync(dst, fs.readFileSync(src, 'utf8') + fs.readFileSync(dst, 'utf8'));
      fs.rmSync(src);
    } else left.push(n);
  }
  if (left.length) return left;
  fs.rmdirSync(from);
  return [];
}

/**
 * Does the plan: renames first (a folder in use fails and is reported, nothing else moves for it), then the database
 * rows whose new folder is there, then the staff folders (an emptied _workers is removed). `moveWorkspace` writes one row (store.moveWorkspace).
 */
export function fixAuxFolders(root: string, dbPath: string, moveWorkspace: (id: number, folder: string) => void): { plan: FolderPlan; failed: string[] } {
  const plan = planAuxFolders(root, dbPath);
  const failed: string[] = [];
  for (const r of plan.rename) {
    try {
      fs.renameSync(r.from, r.to);
    } catch (err) {
      failed.push(`${r.from} → ${r.to}: ${(err as Error).message}`);
    }
  }
  for (const r of plan.repath) {
    if (fs.existsSync(r.to) || !fs.existsSync(r.from)) moveWorkspace(r.id, r.to);
    else failed.push(`공간 #${r.id}: 새 자리가 아직 없어 DB를 고치지 않음(${r.to})`);
  }
  for (const r of plan.staffMoves) {
    try {
      if (!fs.existsSync(r.to)) {
        fs.mkdirSync(path.dirname(r.to), { recursive: true });
        fs.renameSync(r.from, r.to);
        continue;
      }
      const roleFiles = Object.keys(staffFolderFiles(readStaff(path.basename(r.to), root)));
      const left = mergeStaffFolder(r.from, r.to, roleFiles);
      if (left.length) failed.push(`${r.from}: 새 폴더에도 같은 이름이 있어 남김(${left.join(', ')})`);
    } catch (err) {
      failed.push(`${r.from} → ${r.to}: ${(err as Error).message}`);
    }
  }
  // The folder that held the staff folders for a while goes once they are out of it (left when something else is in it).
  const oldHome = path.join(workspaceRootOf(root), OLD_STAFF_HOME);
  try {
    if (fs.existsSync(oldHome) && !fs.readdirSync(oldHome).length) fs.rmdirSync(oldHome);
  } catch {}
  for (const name of STAFF_NAMES) fixStaffFolder(readStaff(name, root), root);
  if (runJobHomeMissing(root).length) fixRunJobHome(root);
  return { plan, failed };
}
