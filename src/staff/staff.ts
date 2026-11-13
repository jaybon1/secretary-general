/**
 * Staff: the secretary's repeated unattended jobs, each staff member with its values in one file here (src/staff/<name>.json:
 * provider, model, effort, fresh session, memory access, the tools it may use, time limit, the instructions file) and
 * an empty folder of its own to run in, beside the workspaces (workspaces/_staff/<name>, e.g.
 * _staff/memory-consolidation; named after the staff member, not set in the file). The folder holds only a short role
 * (AGENTS.md, and CLAUDE.md importing it) and the run records (runs-<secretary id>.jsonl); it is not a workspace (not in
 * the database), and it is shared by the secretaries on one PC like _run-job-home. Running there and
 * not in the secretary folder keeps the secretary's hooks (log saving, phone notices, memory injection) and its chat rules
 * away from the job (2026-11-09). "Staff" is set apart from "worker", which is a work session (scripts/worker/).
 * Earlier names of their folders: workspaces/_consolidate and _board, then (later on 2026-11-09, src/workers) _workers/<name>;
 * workspace/aux-folders.ts moves those (STAFF_OLD_FOLDERS).
 *
 * The run goes through scripts/run-job/run-job.ps1 -Staff <name>, which reads the same file (one place for the tool
 * list). The instructions are a skill's references file in this repository, so a skill keeps only what the
 * agentskills.io format allows.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { readSecretaryId } from '../core/secretary-id.ts';
import { workspaceRootOf } from '../workspace/secretary-link.ts';
import { CLAUDE_IMPORT } from '../workspace/workspace-paths.ts';
import { STAFF } from '../core/names.ts';

export const STAFF_DIR = 'src/staff';
export const STAFF_NAMES = [STAFF.memoryConsolidation, STAFF.situationBoard] as const;
export type StaffName = (typeof STAFF_NAMES)[number];
/** The folder in the workspaces folder that holds one folder per staff member (an aux folder, not a workspace). */
export const STAFF_HOME = '_staff';
/** The folder that held them for a while on 2026-11-09 (src/workers, run-job -Worker), emptied and removed by workspace-aux-folders. */
export const OLD_STAFF_HOME = '_workers'; // legacy-name: aux-folders
/**
 * Each staff member's earlier folders, relative to the workspaces folder (oldest first), moved to its folder by
 * workspace-aux-folders: directly in the workspaces folder before the first rename, then in _workers.
 */
export const STAFF_OLD_FOLDERS: Record<StaffName, string[]> = { // legacy-name: aux-folders
  [STAFF.memoryConsolidation]: ['_consolidate', `${OLD_STAFF_HOME}/${STAFF.memoryConsolidation}`],
  [STAFF.situationBoard]: ['_board', `${OLD_STAFF_HOME}/${STAFF.situationBoard}`],
};

export interface StaffConfig {
  /** The staff member's name (its file's name; set by readStaff, not written in the file). */
  name: string;
  about: string;
  provider: string;
  model: string;
  effort: string;
  newSession: boolean;
  /** none: no memory tools; read: recall and search_log; write: the memory MCP with its write tools (mcpTools). */
  memory: 'none' | 'read' | 'write';
  /** Built-in tools it keeps. */
  tools: string[];
  /** Secretary memory tools it may use, without the mcp__secretary__ prefix. */
  mcpTools: string[];
  /** Built-in tools refused outright (--tools alone left Bash in, 2026-11-05). */
  deniedTools: string[];
  timeoutMinutes: number;
  /** How long the idle jobs wait after a failed run before trying again (absent: no wait, e.g. the board). */
  retryAfterFailMinutes?: number;
  /** Its instructions, relative to the secretary folder; absent when its code builds the whole prompt (the board). */
  instructions?: string;
  /** The lines of its folder's AGENTS.md. */
  role: string[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOOL = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const staffFile = (name: string, root = PROJECT_ROOT) => path.join(root, ...STAFF_DIR.split('/'), `${name}.json`);

/** Why a staff member's file is not usable; empty when it is. */
export function staffConfigProblems(v: unknown): string[] {
  const out: string[] = [];
  const c = v as Partial<StaffConfig> | null;
  if (!c || typeof c !== 'object') return ['JSON 객체가 아님'];
  const str = (k: keyof StaffConfig) => typeof c[k] === 'string' && (c[k] as string).trim() !== '';
  for (const k of ['about', 'provider', 'model', 'effort'] as const) if (!str(k)) out.push(`${k} 없음`);
  if ('folder' in c) out.push(`folder 키는 쓰지 않음(폴더는 ${STAFF_HOME}/<담당자 이름>)`);
  if ('name' in c) out.push('name 키는 쓰지 않음(이름은 파일 이름)');
  if (c.instructions !== undefined && !str('instructions')) out.push('instructions는 파일 경로(없으면 키를 뺀다)');
  if (typeof c.newSession !== 'boolean') out.push('newSession은 true/false');
  if (!['none', 'read', 'write'].includes(c.memory as string)) out.push('memory는 none|read|write');
  for (const k of ['tools', 'mcpTools', 'deniedTools'] as const) {
    const list = c[k];
    if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && TOOL.test(t))) out.push(`${k}는 도구 이름 목록`);
  }
  if (c.memory === 'write' && !(c.mcpTools ?? []).length) out.push('memory write인데 mcpTools가 비었음');
  if (!(typeof c.timeoutMinutes === 'number' && c.timeoutMinutes > 0)) out.push('timeoutMinutes는 양수');
  if (c.retryAfterFailMinutes !== undefined && !(typeof c.retryAfterFailMinutes === 'number' && c.retryAfterFailMinutes > 0)) out.push('retryAfterFailMinutes는 양수(없으면 키를 뺀다)');
  if (!Array.isArray(c.role) || !c.role.every((l) => typeof l === 'string')) out.push('role은 글 줄 목록');
  return out;
}

/** The staff member's values; throws with what is wrong. */
export function readStaff(name: string, root = PROJECT_ROOT): StaffConfig {
  if (!NAME.test(name)) throw new Error(`담당자 이름이 아님: ${name}`);
  const file = staffFile(name, root);
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`담당자 설정을 못 읽음(${file}): ${(err as Error).message}`);
  }
  const problems = staffConfigProblems(v);
  if (problems.length) throw new Error(`담당자 설정이 틀림(${file}): ${problems.join(', ')}`);
  return { ...(v as Omit<StaffConfig, 'name'>), name };
}

/** The staff member's folder as said to the user, relative to the workspaces folder (_staff/<name>). */
export const staffFolderLabel = (w: Pick<StaffConfig, 'name'>) => `${STAFF_HOME}/${w.name}`;

/** The staff member's run folder: workspaces/_staff/<name> beside the secretary (SECRETARY_WORKSPACE_ROOT when set). */
export const staffFolder = (w: Pick<StaffConfig, 'name'>, root = PROJECT_ROOT) => path.join(workspaceRootOf(root), STAFF_HOME, w.name);

/** Its instructions, read from the secretary folder; throws for a staff member whose code builds the prompt. */
export const staffInstructions = (w: StaffConfig, root = PROJECT_ROOT) => {
  if (!w.instructions) throw new Error(`담당자 설정에 instructions가 없음: ${w.name}`);
  // A checkout with core.autocrlf has CRLF; the prompt is the same text either way.
  return fs.readFileSync(path.join(root, ...w.instructions.split('/')), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
};

/** The files its folder holds besides the run records. */
export function staffFolderFiles(w: StaffConfig): Record<string, string> {
  return { 'AGENTS.md': `${w.role.join('\n')}\n`, 'CLAUDE.md': CLAUDE_IMPORT };
}

/** What is missing or different in the staff member's folder (or in `dir`, a folder about to be moved there); empty when right. */
export function staffFolderProblems(w: StaffConfig, root = PROJECT_ROOT, dir = staffFolder(w, root)): string[] {
  const label = staffFolderLabel(w);
  if (!fs.existsSync(dir)) return [`${label} 없음`];
  return Object.entries(staffFolderFiles(w)).flatMap(([n, text]) => {
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) return [`${label}/${n} 없음`];
    return fs.readFileSync(f, 'utf8') === text ? [] : [`${label}/${n}이 설정의 역할 글과 다름`];
  });
}

/** Makes the staff member's folder right (folder, role files); returns what it did. Run records are left. */
export function fixStaffFolder(w: StaffConfig, root = PROJECT_ROOT, dryRun = false): string[] {
  const problems = staffFolderProblems(w, root);
  if (dryRun || !problems.length) return problems;
  const dir = staffFolder(w, root);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, text] of Object.entries(staffFolderFiles(w))) {
    const f = path.join(dir, n);
    if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== text) fs.writeFileSync(f, text);
  }
  return problems;
}

/** The tag in a run record file's name: the secretary's secretary id, else 8 hex of its folder path (like Get-SecretaryFileTag). */
export function secretaryTag(root = PROJECT_ROOT): string {
  const id = readSecretaryId(root);
  if (id) return id;
  return crypto.createHash('sha256').update(path.resolve(root).replace(/[\\/]+$/, '').toLowerCase()).digest('hex').slice(0, 8);
}

/** Appends one line to the staff member's run records (runs-<secretary tag>.jsonl in its folder); never throws. */
export function recordStaffRun(w: StaffConfig, entry: Record<string, unknown>, root = PROJECT_ROOT): void {
  try {
    const dir = staffFolder(w, root);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `runs-${secretaryTag(root)}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch {}
}
