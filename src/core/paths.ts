/**
 * Where things are, in one place: the secretary's own scripts (relative to the project root, written the way
 * the texts the secretary reads show them) and the folders outside it that several parts share.
 * The PowerShell side keeps the same folders in scripts/lib/common.ps1 (Get-SecretaryHome, Get-SecretaryLogDir, Get-SecretaryStateDir, Get-UsageDir).
 */
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { SKILLS_DIR } from '../setup/skill-links.ts';
import { readInstallId } from '../setup/install-id.ts';

/** ~/.secretary: the keys folder (keys/), each secretary's logs (logs/<id>/: server, idle jobs, end notices) and records (state/<id>/). */
export const SECRETARY_HOME = path.join(os.homedir(), '.secretary');

/**
 * This secretary's own logs: ~/.secretary/logs/<its id> (the id in .secretary-id, setup/install-id.ts), so two
 * secretaries on one PC never write into one log. A copy without an id yet writes into logs/ itself, as before ids.
 * The logs from before (logs/server-a, logs/idle-jobs.log, logs/notify.log) stay where they are. The PowerShell side: Get-SecretaryLogDir in scripts/lib/common.ps1.
 */
export function secretaryLogDir(root = PROJECT_ROOT, home = SECRETARY_HOME): string {
  const id = readInstallId(root);
  return id ? path.join(home, 'logs', id) : path.join(home, 'logs');
}

/**
 * ~/.claude/usage: what every secretary on this PC shares: usage and the 90% lifts per account (secretaries on one
 * account read the same file), the usage reader's lock, the tool version table. A copy without an id yet keeps its own
 * records here too (secretaryStateDir).
 * Tools outside the secretary may read it too, so the name stays.
 */
export const USAGE_DIR = path.join(os.homedir(), '.claude', 'usage');

/**
 * This secretary's own records: ~/.secretary/state/<its id> (setup/install-id.ts): its work sessions (worker-sessions.json,
 * worker-reuse.jsonl), run-jobs (run-job-sessions.json, run-job-calls.jsonl, run-job-active/), detached jobs (bg-jobs/)
 * and work-session watchers (watch/), so two secretaries on one PC never read or write each other's. A copy without an
 * id yet keeps them in USAGE_DIR, as before ids. Its old records there are copied in once (core/state-dir.ts). The
 * PowerShell side: Get-SecretaryStateDir in scripts/lib/common.ps1.
 */
export function secretaryStateDir(root = PROJECT_ROOT, home = SECRETARY_HOME, usageDir = USAGE_DIR): string {
  const id = readInstallId(root);
  return id ? path.join(home, 'state', id) : usageDir;
}

/** The secretary's scripts and local settings files that the TypeScript side starts, reads or names in its texts. */
export const SCRIPTS = {
  cli: 'src/cli.ts',
  runJob: 'scripts/run-job/run-job.ps1',
  remoteServer: 'scripts/server/remote-server.ps1',
  serverControl: 'scripts/server/server-control.ps1',
  installTasks: 'scripts/tasks/install-tasks.ps1',
  backupDb: 'scripts/tasks/backup-db.ps1',
  idleJobs: 'scripts/tasks/idle-jobs.ps1',
  watchWorker: 'scripts/worker/watch-worker.ps1',
  watchEmbedder: 'scripts/semantic/watch-embedder.mjs',
  egoGrab: 'scripts/browser/ego-grab.mjs',
  usageGuard: 'scripts/usage/usage-guard.mjs',
  usageStatusline: 'scripts/usage/usage-statusline.mjs',
  installUsageGuard: 'scripts/usage/install-usage-guard.mjs',
  /** Reads providers' usage without tokens into ~/.claude/usage/subscription-<account>.json (usage/files.ts names it; usage/providers.ts says how each is read). */
  usageQuery: 'scripts/usage/usage-query.ps1',
  providers: 'scripts/lib/providers.json',
  /** The dashboard (feature 'dashboard'): the web view, the "상태" text and read-only result folders (/share). */
  dashboard: 'src/dashboard/dashboard.ts',
  /** This PC's dashboard settings (not committed): addresses to listen on, port, share names (src/dashboard/settings.ts). */
  dashboardLocal: 'scripts/dashboard.local.json',
  /** This PC's choice of providers whose usage the dashboard reads (not committed; its settings page writes it). */
  usageLocal: 'scripts/usage.local.json',
  /** This PC's end notice settings (not committed): the ntfy server and topic the Stop hook sends to (src/notify/ntfy.ts). */
  notifyLocal: 'scripts/notify.local.json',
  /** Prepares the ntfy server: server.yml in the user folder and its log-on task (no admin). */
  installNtfy: 'scripts/notify/install-ntfy.ps1',
  /** Before and after delegating (feature 'guards'): a brief against the decisions, a report against the files. */
  delegateCheck: 'scripts/delegate-check/delegate-check.ts',
} as const;

export type ScriptName = keyof typeof SCRIPTS;

/**
 * The secretary's own skills (delegate, consolidate, …), each <name>/SKILL.md, read where they really are:
 * .agents/skills/, here and in the general release (.claude/skills is only a link to it, which a fresh clone, a release
 * and an update do not have: setup/skill-links.ts). A workspace keeps its own the same way (workspace/layout.ts SKILLS_DIR).
 */
export const SECRETARY_SKILLS_DIR = SKILLS_DIR;

/** Absolute path of skill <name>'s SKILL.md in this copy (or in `root`). */
export const skillFile = (name: string, root = PROJECT_ROOT) => path.join(root, ...SECRETARY_SKILLS_DIR.split('/'), name, 'SKILL.md');

/** Absolute path of one of them in this copy (or in `root`). */
export const scriptPath = (name: ScriptName, root = PROJECT_ROOT) => path.join(root, ...SCRIPTS[name].split('/'));

/**
 * The entrances for everything outside the secretary folder (workspace tools and rules, the user settings' hook and
 * status line, scheduled tasks, shortcuts): fixed names in bin/ that never move. A workspace tool finds bin/ in the
 * workspace's secretary.json (the secretary writes it with bin/ only, never its own folder: workspace/secretary-link.ts),
 * else under the secretary's own environment variable SECRETARY_<id>_DIR (the install id from setup/install-id.ts, so
 * two secretaries on one PC each have their own), else under the old SECRETARY_DIR; where a path is written once
 * (scheduled tasks, user settings), by its full path. Each passes everything through to the real script, so moving a script changes SCRIPTS
 * and its bin file only (test/entry-points.test.ts keeps each bin file equal to entryText). The scripts in
 * scripts/lib/common.ps1 set the variables for what they start; the install check (setup/check-items.ts) looks for the
 * user's own. The old name without the id (SECRETARY_DIR) is only read while tools outside move on.
 */
export const ENTRY_DIR = 'bin';
/** The variable's name as texts write it for any install. */
export const SECRETARY_DIR_ENV_TEXT = 'SECRETARY_<번호>_DIR';
/** How a tool outside finds the entrance folder, as texts write it. */
export const FIND_SECRETARY_TEXT = `작업 공간에서는 맨 위 secretary.json의 bin, 없으면 환경변수 ${SECRETARY_DIR_ENV_TEXT} 아래 ${ENTRY_DIR}, 그다음 옛 SECRETARY_DIR 아래 ${ENTRY_DIR}`;
/** The name before install ids: set for what the scripts start and read as a fallback while tools outside move on. */
export const LEGACY_SECRETARY_DIR_ENV = 'SECRETARY_DIR';
/** One install's variable, e.g. SECRETARY_A3F9_DIR; the old name while there is no id yet. */
export const secretaryDirEnv = (id: string | null | undefined): string => (id ? `SECRETARY_${id.toUpperCase()}_DIR` : LEGACY_SECRETARY_DIR_ENV);

export const ENTRY_POINTS = {
  'run-job.ps1': 'runJob',
  'ego-grab.mjs': 'egoGrab',
  'usage-guard.mjs': 'usageGuard',
  'usage-statusline.mjs': 'usageStatusline',
  'server-control.ps1': 'serverControl',
  'backup-db.ps1': 'backupDb',
  'idle-jobs.ps1': 'idleJobs',
  'dashboard.mjs': 'dashboard',
  'delegate-check.mjs': 'delegateCheck',
} as const satisfies Record<string, ScriptName>;

export type EntryName = keyof typeof ENTRY_POINTS;

/** Absolute path of bin/<name> in this copy (or in `root`). */
export const entryPath = (name: EntryName, root = PROJECT_ROOT) => path.join(root, ENTRY_DIR, name);

/**
 * What bin/<name> holds: run the real script with what it was given. PowerShell: arguments as given (arrays and
 * switches too), and the script's exit code (0 when it ends without exit, as `powershell -File` gives). Node: the
 * module itself, so a hook runs as before and ego-grab's grab is exported. .ps1 files are written with a BOM
 * (Windows PowerShell 5.1 reads a file without one in the ANSI code page).
 */
export function entryText(name: EntryName): string {
  const target = SCRIPTS[ENTRY_POINTS[name]];
  if (name.endsWith('.mjs')) {
    return [
      `// 비서 입구: 비서 폴더 밖에서는 이 고정 이름(입구 폴더 ${ENTRY_DIR}의 ${name}. 입구 폴더는 ${FIND_SECRETARY_TEXT})으로 부른다. 실제 파일: ${target}`,
      '// 스크립트를 옮기면 이 줄과 src/core/paths.ts의 SCRIPTS만 고친다(test/entry-points.test.ts).',
      `export * from '../${target}';`,
      '',
    ].join('\n');
  }
  return [
    `# 비서 입구: 비서 폴더 밖에서는 이 고정 이름(입구 폴더 ${ENTRY_DIR}의 ${name}. 입구 폴더는 ${FIND_SECRETARY_TEXT})으로 부른다. 실제 스크립트: ${target}`,
    '# 받은 인자를 그대로 넘기고 그 종료 코드로 끝난다. 스크립트를 옮기면 이 줄과 src/core/paths.ts의 SCRIPTS만 고친다(test/entry-points.test.ts).',
    `& "$PSScriptRoot\\..\\${target.replace(/\//g, '\\')}" @args`,
    'if ($?) { exit 0 }',
    'exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })',
    '',
  ].join('\n');
}
