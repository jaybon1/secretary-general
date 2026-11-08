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
import { PROJECT_ROOT, WORKSPACE_ROOT } from '../core/config.ts';
import { formatLocal, nowIso } from '../core/kst-time.ts';
import {
  CLAUDE_IMPORT,
  HISTORY_DIR,
  HISTORY_FILE,
  MEMORY_FILE,
  OUTPUT_DIR,
  PENDING_DIR,
  PRODUCTS_DIR,
  RECORDS_DIR,
  REPORT_FILE,
  RESEARCH_DIR,
  SLUG,
  TASK_FILE,
  type TaskSpec,
  type WorkspaceSpec,
} from './layout.ts';
import { renderAgent, renderCharter, renderHistory, renderMemory, renderTaskBrief } from './rules-text.ts';
import { SKILL_GITIGNORE_LINES } from '../setup/skill-links.ts';
import { GITIGNORE_LINES, LINK_FILE, writeLink } from './secretary-link.ts';

export * from './layout.ts';
export * from './rules-text.ts';
export * from './secretary-link.ts';


export function createWorkspaceFolder(spec: WorkspaceSpec, now = nowIso(), secretaryRoot = PROJECT_ROOT): { folder: string; files: string[] } {
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
  if (!spec.parentDir) fs.mkdirSync(parent, { recursive: true });
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
  if (spec.kind !== 'quick') {
    write(HISTORY_FILE, renderHistory(spec));
    write(path.join(HISTORY_DIR, '.gitkeep'), '');
    write(MEMORY_FILE, renderMemory(spec));
    write(path.join(PENDING_DIR, '.gitkeep'), '');
  }
  write('.gitignore', GITIGNORE);
  // This secretary's entrance folder bin/, for the workspace's tools (workspace/secretary-link.ts); kept out of git by the line above.
  writeLink(folder, secretaryRoot);
  files.push(LINK_FILE);
  fs.mkdirSync(path.join(folder, OUTPUT_DIR));
  initGit(folder);
  return { folder, files };
}

/** Big or rebuildable things stay out of the workspace's local history, and so does the secretary's link (a path on this PC). */
export const GITIGNORE = ['.venv/', 'venv/', 'node_modules/', '__pycache__/', '*.zip', '*.onnx', '*.tflite', '*.bin', ...GITIGNORE_LINES, ...SKILL_GITIGNORE_LINES, ''].join('\n');

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
