/**
 * The names other places know the secretary by, in one file: cli commands (`node src/cli.ts <command>`, called by scripts,
 * scheduled tasks and skills), the prompt hook's notice ids (features.json notices, hooks/prompt-notices.ts), the install
 * check's item ids (features.json checks, a user's skip list, setup/check-items.ts), the scheduled tasks' ids
 * (features.json scheduledTasks, install-scheduled-tasks.ps1 -Task) and the tags the hooks inject
 * (`<secretary-…>`, read by AGENTS.md and the eval set). Code takes them from here, never as a string of its own, so a
 * rename is one line here plus its readers outside the code (AGENTS.md, skills, scripts, features.json); npm test
 * (test/names.test.ts) finds one written out again anywhere else in src/.
 */

/** cli commands (src/cli.ts). */
export const CLI = {
  hook: 'hook',
  setupCheck: 'setup-check',
  skillLinks: 'skill-links',
  contextTokens: 'context-tokens',
  semanticSearchServer: 'semantic-search-server',
  usagePoll: 'usage-poll',
  subscriptionPick: 'subscription-pick',
  workspaceLinks: 'workspace-links',
  workspaceAuxFolders: 'workspace-aux-folders',
  memoryStats: 'memory-stats',
  userTitle: 'user-title',
  dbBackup: 'db-backup',
  ingestTranscript: 'ingest-transcript',
  rewindClean: 'rewind-clean',
  purgeLog: 'purge-log',
  catchUpTranscripts: 'catch-up-transcripts',
  situationBoardUpdate: 'situation-board-update',
  situationBoardShow: 'situation-board-show',
  idleJobs: 'idle-jobs',
  memoryConsolidation: 'memory-consolidation',
  sessionHandoffWake: 'session-handoff-wake',
  archiveWorkspace: 'archive-workspace',
  /** Once, updating from v7: the profile's 큰 일 칸 → the big-work board (upgrade/big-work-move.ts). */
  bigWorkFromProfile: 'big-work-from-profile',
  thisSecretaryMerge: 'this-secretary-merge',
} as const;

/** The prompt hook's notices (hooks/prompt-notices.ts; features.json notices). */
export const NOTICE = {
  usageGuardOverride: 'usage-guard-override',
  subscriptionRouting: 'subscription-routing',
  setupCheck: 'setup-check',
  watchMissing: 'watch-missing',
  contextSize: 'context-size',
  memoryConsolidation: 'memory-consolidation',
  rewind: 'rewind',
  purge: 'purge',
  situationBoard: 'situation-board',
  memoryCore: 'memory-core',
  answerCheckWarn: 'answer-check-warn',
  questionLabel: 'question-label',
} as const;

/** The install check's items (setup/check-items.ts; features.json checks, `setup-check --skip`). */
export const CHECK = {
  features: 'features',
  db: 'db',
  npmPackages: 'npm-packages',
  semanticSearchModel: 'semantic-search-model',
  skills: 'skills',
  entryPoints: 'entry-points',
  releaseFiles: 'release-files',
  renamedLocalFiles: 'renamed-local-files',
  secretaryDirEnv: 'secretary-dir-env',
  workspaceLinks: 'workspace-links',
  workspaceAuxFolders: 'workspace-aux-folders',
  serverTask: 'server-task',
  serverRunning: 'server-running',
  backupTask: 'backup-task',
  idleJobsTask: 'idle-jobs-task',
  usageHooks: 'usage-hooks',
  phonePush: 'phone-push',
  providerKey: 'provider-key',
} as const;

/**
 * The scheduled tasks' ids (features.json scheduledTasks id, scripts/scheduled/install-scheduled-tasks.ps1 -Task; the
 * registered name is features.json's name with the secretary id after it, setup/check-items.ts).
 */
export const TASK = {
  server: 'server',
  backup: 'backup',
  idleJobs: 'idle-jobs',
  ntfy: 'ntfy',
} as const;

/** The staff members: src/staff/<name>.json, run through run-job -Staff <name> in workspaces/_staff/<name>. */
export const STAFF = {
  situationBoard: 'situation-board',
  memoryConsolidation: 'memory-consolidation',
} as const;

/** The feature ids (features.json) the code itself asks about: whether the feature is turned on. */
export const FEATURE = {
  phonePush: 'phone-push',
  usagePoll: 'usage-poll',
  dashboard: 'dashboard',
  mistakeGuards: 'mistake-guards',
} as const;

/** The tags the hooks wrap what they inject in: `<secretary-…>` (AGENTS.md says what each asks of the secretary). */
export const TAG = {
  profile: 'secretary-profile',
  bigWork: 'secretary-big-work',
  status: 'secretary-status',
  resultPaths: 'secretary-paths',
  situationBoard: 'secretary-board',
  situationBoardFailure: 'secretary-board-failure',
  continuity: 'secretary-continuity',
  memory: 'secretary-memory',
  semanticSearchServer: 'secretary-semantic-search-server',
  watch: 'secretary-watch',
  usage: 'secretary-usage',
  contextSize: 'secretary-context-size',
  questionLabel: 'secretary-question-label',
  answerCheck: 'secretary-answer-check',
  setup: 'secretary-setup',
  rewind: 'secretary-rewind',
  purge: 'secretary-purge',
  purgePreview: 'secretary-purge-preview',
  purgeCode: 'secretary-purge-code',
  purgeDone: 'secretary-purge-done',
  consolidate: 'secretary-consolidate',
  consolidateReport: 'secretary-consolidate-report',
} as const;
