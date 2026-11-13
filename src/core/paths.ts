/**
 * Where things are, in one place: the secretary's own scripts (relative to the project root, written the way
 * the texts the secretary reads show them) and the folders outside it that several parts share.
 * The PowerShell side keeps the same folders in scripts/lib/common.ps1 (Get-SecretaryHome, Get-SecretaryLogDir, Get-SecretaryStateDir, Get-UsageDir).
 */
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { readSecretaryId } from './secretary-id.ts';

/**
 * ~/.secretary (2026-11-09 layout): what every secretary on this PC shares sits right under it, each a word with a vowel
 * (keys/, usage/, ntfy/ and the like); each secretary's own sits under its id (<id>/logs/, <id>/state/; an id has
 * no vowel, core/secretary-id.ts, so the two never share a name).
 */
export const SECRETARY_HOME = path.join(os.homedir(), '.secretary');

/**
 * This secretary's own logs: ~/.secretary/<its id>/logs (the id in .secretary-id, core/secretary-id.ts): server, idle
 * jobs, end notices. Two secretaries on one PC never write into one log. A copy without an id yet writes into
 * ~/.secretary/logs itself, as before ids. The logs from before stay where they are (logs/<id>/ until 2026-11-09, logs/
 * itself before ids; legacySecretaryLogDir). The PowerShell side: Get-SecretaryLogDir in scripts/lib/common.ps1.
 */
export function secretaryLogDir(root = PROJECT_ROOT, home = SECRETARY_HOME): string {
  const id = readSecretaryId(root);
  return id ? path.join(home, id, 'logs') : path.join(home, 'logs');
}

/** Where this secretary's logs were until 2026-11-09 (~/.secretary/logs/<id>); null without an id. Read only, never written. */
export function legacySecretaryLogDir(root = PROJECT_ROOT, home = SECRETARY_HOME): string | null { // legacy-name: log-dir
  const id = readSecretaryId(root);
  return id ? path.join(home, 'logs', id) : null;
}

/**
 * ~/.secretary/usage: what every secretary on this PC shares about usage: usage and the 90% lifts per account
 * (secretaries on one account read the same file), the refresh marks and failures, the usage reader's lock. A copy without
 * an id yet keeps its own records here too (secretaryStateDir). Tools outside the secretary may read it too.
 */
export const USAGE_DIR = path.join(SECRETARY_HOME, 'usage');

/**
 * ~/.claude/usage: the same until 2026-11-09 (it sat in Claude Code's own folder, where nothing said it was the
 * secretary's). Only read, while copies of the secretary that still write there are about: the usage guard, the status
 * line's readers and the dashboard take the newer of the two (usage/usage-files.ts readUsage, readOverrideUntil). Nothing
 * new is written there. Its old run-job records are compared and removed by state-dir-migrate.ts legacyRunJobCleanup.
 */
export const LEGACY_USAGE_DIR = path.join(os.homedir(), '.claude', 'usage'); // legacy-name: usage-dir

/**
 * This secretary's own records: ~/.secretary/<its id>/state (core/secretary-id.ts): its work sessions
 * (worker-sessions.json, worker-reuse.jsonl), run-jobs (run-job-sessions.json, run-job-calls.jsonl, run-job-active/),
 * detached jobs (bg-jobs/) and work-session watchers (watch/), so two secretaries on one PC never read or write each
 * other's. A copy without an id yet keeps them in USAGE_DIR. Its records from before (~/.secretary/state/<id> until
 * 2026-11-09, ~/.claude/usage before ids) are copied in once (core/state-dir-migrate.ts). The PowerShell side:
 * Get-SecretaryStateDir in scripts/lib/common.ps1.
 */
export function secretaryStateDir(root = PROJECT_ROOT, home = SECRETARY_HOME, usageDir = USAGE_DIR): string {
  const id = readSecretaryId(root);
  return id ? path.join(home, id, 'state') : usageDir;
}

/** Where this secretary's records were until 2026-11-09 (~/.secretary/state/<id>); null without an id. */
export function legacySecretaryStateDir(root = PROJECT_ROOT, home = SECRETARY_HOME): string | null { // legacy-name: state-dir
  const id = readSecretaryId(root);
  return id ? path.join(home, 'state', id) : null;
}

/** The secretary's scripts and local settings files that the TypeScript side starts, reads or names in its texts. */
export const SCRIPTS = {
  cli: 'src/cli.ts',
  runJob: 'scripts/run-job/run-job.ps1',
  /** Makes and removes the work copy (git worktree with a node_modules junction) for the secretary's own code work through run-job. */
  runJobWorktree: 'scripts/run-job/run-job-worktree.ps1',
  remoteServer: 'scripts/remote-server/remote-server.ps1',
  serverControl: 'scripts/remote-server/server-control.ps1',
  installScheduledTasks: 'scripts/scheduled/install-scheduled-tasks.ps1',
  backupDb: 'scripts/scheduled/backup-db.ps1',
  idleJobs: 'scripts/scheduled/idle-jobs.ps1',
  watchWorker: 'scripts/worker/watch-worker.ps1',
  watchSemanticSearchServer: 'scripts/semantic-search/watch-semantic-search-server.mjs',
  egoGrab: 'scripts/browser/ego-grab.mjs',
  usageGuard: 'scripts/usage/usage-guard.mjs',
  usageStatusline: 'scripts/usage/usage-statusline.mjs',
  installUsageGuard: 'scripts/usage/install-usage-guard.mjs',
  /** Reads providers' usage without tokens into ~/.secretary/usage/subscription-<account>.json (usage/usage-files.ts names it; usage/provider-usage.ts says how each is read). */
  usageQuery: 'scripts/usage/usage-query.ps1',
  providers: 'scripts/lib/providers.json',
  /** The dashboard (feature 'dashboard'): the web view, the "상태" text and read-only result folders (/share). */
  dashboard: 'src/dashboard/dashboard.ts',
  /** Prepares the ntfy server: server.yml in the user folder and its log-on task (no admin). */
  installNtfy: 'scripts/phone-push/install-ntfy.ps1',
  /** Before and after delegating (feature 'mistake-guards'): a brief against the decisions, a report against the files. */
  delegateCheck: 'scripts/delegate-check/delegate-check.ts',
} as const;

export type ScriptName = keyof typeof SCRIPTS;

/**
 * The secretary's own skills (delegate, consolidate, …), each <name>/SKILL.md, read where they really are:
 * .agents/skills/, here and in the general release (.claude/skills is only a link to it, which a fresh clone, a release
 * and an update do not have: setup/skill-links.ts). A workspace keeps its own the same way (workspace/workspace-paths.ts SKILLS_DIR).
 */
export const SECRETARY_SKILLS_DIR = '.agents/skills';

/** Absolute path of skill <name>'s SKILL.md in this copy (or in `root`). */
export const skillFile = (name: string, root = PROJECT_ROOT) => path.join(root, ...SECRETARY_SKILLS_DIR.split('/'), name, 'SKILL.md');

/** Absolute path of one of them in this copy (or in `root`). */
export const scriptPath = (name: ScriptName, root = PROJECT_ROOT) => path.join(root, ...SCRIPTS[name].split('/'));

/**
 * The entrances for everything outside the secretary folder (workspace tools and rules, the user settings' hook and
 * status line, scheduled tasks, shortcuts): fixed names in bin/ that never move. A workspace tool finds bin/ in the
 * workspace's secretary-link.local.json (the secretary writes it with bin/ only, never its own folder: workspace/secretary-link.ts),
 * else under the secretary's own environment variable SECRETARY_<id>_DIR (the secretary id from core/secretary-id.ts, so
 * two secretaries on one PC each have their own); where a path is written once (scheduled tasks, user settings), by its
 * full path. Texts and the workspace charter's code no longer name the old SECRETARY_DIR (2026-11-10). Each passes everything through to the real script, so moving a script changes SCRIPTS
 * and its bin file only (test/entry-points.test.ts keeps each bin file equal to entryText). The scripts in
 * scripts/lib/common.ps1 set the variables for what they start; the install check (setup/check-items.ts) looks for the
 * user's own. The old name without the id (SECRETARY_DIR) is only read while tools outside move on.
 */
export const ENTRY_DIR = 'bin';
/** The variable's name as texts write it for any install. */
export const SECRETARY_DIR_ENV_TEXT = 'SECRETARY_<번호>_DIR';
/** How a tool outside finds the entrance folder, as texts write it. */
export const FIND_SECRETARY_TEXT = `작업 공간에서는 맨 위 secretary-link.local.json의 bin, 없으면 환경변수 ${SECRETARY_DIR_ENV_TEXT} 아래 ${ENTRY_DIR}`;
/** The name before secretary ids: set for what the scripts start and read as a fallback while tools outside move on. */
export const LEGACY_SECRETARY_DIR_ENV = 'SECRETARY_DIR'; // legacy-name: env-secretary-dir
/** One install's variable, e.g. SECRETARY_A3F9_DIR; the old name while there is no id yet. */
export const secretaryDirEnv = (id: string | null | undefined): string => (id ? `SECRETARY_${id.toUpperCase()}_DIR` : LEGACY_SECRETARY_DIR_ENV);

export const ENTRY_POINTS = {
  'run-job.ps1': 'runJob',
  'run-job-worktree.ps1': 'runJobWorktree',
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
      `// 비서 진입점: 비서 폴더 밖에서는 이 고정 이름(진입점 폴더 ${ENTRY_DIR}의 ${name}. 진입점 폴더는 ${FIND_SECRETARY_TEXT})으로 부른다. 실제 파일: ${target}`,
      '// 스크립트를 옮기면 이 줄과 src/core/paths.ts의 SCRIPTS만 고친다(test/entry-points.test.ts).',
      `export * from '../${target}';`,
      '',
    ].join('\n');
  }
  return [
    `# 비서 진입점: 비서 폴더 밖에서는 이 고정 이름(진입점 폴더 ${ENTRY_DIR}의 ${name}. 진입점 폴더는 ${FIND_SECRETARY_TEXT})으로 부른다. 실제 스크립트: ${target}`,
    '# 받은 인자를 그대로 넘기고 그 종료 코드로 끝난다. 스크립트를 옮기면 이 줄과 src/core/paths.ts의 SCRIPTS만 고친다(test/entry-points.test.ts).',
    `& "$PSScriptRoot\\..\\${target.replace(/\//g, '\\')}" @args`,
    'if ($?) { exit 0 }',
    'exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })',
    '',
  ].join('\n');
}
