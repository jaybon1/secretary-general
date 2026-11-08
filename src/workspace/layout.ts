/** Names and shapes of workspace folders, shared by the folder maker (workspace/folders.ts) and the rules text (workspace/rules-text.ts). */
import path from 'node:path';
import { WORKSPACE_ROOT } from '../core/config.ts';
import type { WorkspaceKind } from '../store/store.ts';

export const REPORT_FILE = 'REPORT.md';
export const TASK_FILE = 'TASK.md';
export const OUTPUT_DIR = 'output';
export const PRODUCTS_DIR = 'products';
export const RECORDS_DIR = 'records';
export const RESEARCH_DIR = 'research';
/** The workspace's current state only; quick has none since its tasks are unrelated. */
export const HISTORY_FILE = 'notes/history.md';
/**
 * Finished-task entries, one append-only file per month (YYYY-MM.md). Sessions never read
 * these whole: headings are the index (grep "^## " … | tail), like Claude Code keeping its
 * always-loaded MEMORY.md small and reading topic files on demand.
 */
export const HISTORY_DIR = 'notes/history';
export const STATUS_LIMIT = 2000;
/** Throwaway test folders (empty-environment runs, install trials) sit beside the workspaces, where no rules file or git above them leaks in. */
export const SANDBOX_DIR = path.join(WORKSPACE_ROOT, '_sandbox');
/**
 * What the workspace learns, kept apart from the task log: one skill per kind of work
 * (procedures, pitfalls, corrections) and a small file of facts that always hold.
 * Workers fix skills on a user correction; anything they find on their own waits in
 * pending/ until the secretary gets it approved. Quick has none of these.
 */
/** Same place as the secretary's own (setup/skill-links.ts): real folders, .claude/skills is a link to it. */
export const SKILLS_DIR = '.agents/skills';
export const MEMORY_FILE = 'MEMORY.md';
export const PENDING_DIR = 'notes/pending';
export const MEMORY_LIMIT = 2000;
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

export type CodeScale = 'small' | 'medium' | 'large';

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
  /** Code workspaces only; adds rules on top of the small (default) set. */
  scale?: CodeScale;
  /** Commands every task here runs before reporting; empty until the first tasks show what works. */
  verify?: string[];
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
  /** What to run and what it must show for the task to count as done. */
  proof: string[];
  risks?: string[];
  /** The product this task builds or changes; none means research. */
  product?: string;
  /** The worker writes plan.md and waits for approval before changing anything. */
  planFirst?: boolean;
  /** Test files are off limits (worker-guard.mjs enforces it when started with -LockTests). */
  lockTests?: boolean;
  /** The user sees the result before it counts as done (the report says what to look at). */
  review?: boolean;
}

export const QUICK_SPEC: WorkspaceSpec = {
  kind: 'quick',
  name: QUICK_NAME,
  title: '간단한 결과물 모음',
  purpose: '따로 작업 공간을 만들 만큼 크지 않고, 다시 열어 고쳐 쓸 작은 결과물(제품, 파일 한두 개)이 남는 일을 처리하고 모아 두는 공용 공간. 보고서·기록만 남는 조사·시험은 이 공간이 아니라 비서의 run-job(run-job-home)이 맡는다.',
};
