/**
 * Command-line entry point: `node src/cli.ts <command> …`. Every command, what it takes and what it does is one entry of
 * COMMANDS below; the usage line (`node src/cli.ts` with no command, or a word it does not know) is made from them.
 *
 * A command that fails prints one line, `오류: <message> (<file:line>)`, and exits 1; the whole trace goes to the records
 * folder's cli-errors.log (core/cli-errors.ts). A hook's failure is kept apart (core/hook-errors.ts) and exits 0.
 *
 * Only the hooks and the commands that write make secretary.db when it is missing. The ones that only look (an entry's
 * viewOnly: any --dry-run, memory-stats, situation-board-show, db-backup, purge-log without --confirm …) say there is none
 * and skip what needs it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionHandoffWake } from './session-continuity/session-handoff.ts';
import { BEFORE_TODO_KEY, runBoardUpdate, spawnBoardJobAfterUpdate } from './session-continuity/situation-board.ts';
import { readBoard, type Board } from './store/board-state.ts';
import { catchUpTranscripts } from './log/catch-up.ts';
import { currentHookSession, hookFailureOutput, runHook } from './hooks/run-hook.ts';
import { noteHookError } from './core/hook-errors.ts';
import { cliErrorLine, noteCliError } from './core/cli-errors.ts';
import { DB_PATH, PROJECT_ROOT } from './core/config.ts';
import { readJsonStrict } from './core/json-file.ts';
import { commonSkillsDirOf, LINK_FILE, linkedFolders, linkFor, linkProblem, writeLink } from './workspace/secretary-link.ts';
import { commonSkillProblem, fixCommonSkills, installShippedCommonSkills, shippedCommonSkillProblem } from './workspace/common-skills.ts';
import { backupDb, openDb } from './store/schema.ts';
import { offFeatureChecks } from './core/features.ts';
import { ingestTranscript } from './log/ingest-transcript.ts';
import { executePurge, formatPlan, formatResult, parseSpec, planPurge, rowLine } from './log/purge.ts';
import { restorePurged } from './log/log-delete.ts';
import { runPreview } from './log/purge-initials.ts';
import { cleanRewound } from './log/rewind.ts';
import { runServer } from './semantic-search/client.ts';
import { checkSetup, formatReport, saveReport, setSkip, setupOptions } from './setup/setup-check.ts';
import { fixSkillLinks, formatSkillLinkFix } from './workspace/skill-links.ts';
import { fixFeatureSkills, formatFeatureSkills } from './setup/feature-skills.ts';
import { Store } from './store/store.ts';
import { formatLocal, nowIso } from './core/kst-time.ts';
import { runIdleJobs } from './idle/idle-jobs.ts';
import { secretaryStateDir } from './core/paths.ts';
import { runConsolidate, spawnConsolidate, type ConsolidateJob } from './memory/consolidate-run.ts';
import { fixAuxFolders, formatFolderPlan, planAuxFolders } from './setup/aux-folders.ts';
import { runUsagePoll } from './usage/usage-poller.ts';
import { subscriptionPick } from './usage/subscription-routing.ts';
import { CLI } from './core/names.ts';
import { ACTION_OWNERS, ACTION_STATES, parseCondition, type ActionInput, type ActionOwner, type ActionState } from './store/store.ts';
import { todoListLines } from './session-continuity/board-todos.ts';
import { fetchCalendar } from './todo-summary/calendar.ts';
import { buildSummary, renderSummary } from './todo-summary/todo-summary.ts';
import { markAnswered, markAskingFromTranscript } from './workspace/worker-asking.ts';
import { WORKER_TRANSCRIPT_WHAT, workerTranscript } from './workspace/worker-transcript.ts';
import { findAgent, readAgentsWith, readScreenWith, workerStatus } from './workspace/worker-status.ts';
import { clearStreak, listStalls, recordStall, watchStalls, type StallInput } from './workspace/job-stalls.ts';
import { recordBackup, type BackupRun } from './core/backup-record.ts';

/**
 * One command. `args` are the words after its name. A command with `db` opens the database and gets the store; its
 * `viewOnly` says when a run only looks (a missing database is then said and skipped, not made empty).
 */
type Command =
  | { usage: string; db?: false; run: (args: string[]) => void | Promise<void> }
  | { usage: string; db: true; viewOnly?: (args: string[]) => boolean; run: (args: string[], store: Store) => void | Promise<void> };

/** The word after `name` in `args` (from index `from` on); undefined when the name is not there. */
const option = (args: string[], name: string, from = 0): string | undefined => {
  const i = args.indexOf(name, from);
  return i >= 0 ? args[i + 1] : undefined;
};
/** Like option, and the name and its word are taken out of `args`. */
const takeOption = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
/** A usage error whose place (core/cli-errors.ts firstPlace) is the command that threw it, not this helper. */
const usageError = (name: string): Error => {
  const err = new Error(`usage: ${name} ${COMMANDS[name].usage}`);
  Error.captureStackTrace(err, usageError);
  return err;
};
const always = () => true;

const COMMANDS: Record<string, Command> = {
  // Called by Claude Code hooks (JSON on stdin). A memory hiccup must never block the conversation: report and exit 0.
  // Claude Code shows no stderr of a hook that exits 0, so the failure goes into the records folder, and the session-start
  // and prompt hooks say in one line what is missing (core/hook-errors.ts).
  [CLI.hook]: {
    usage: 'session-start|prompt|stop',
    async run([name]) {
      try {
        await runHook(name);
      } catch (err) {
        process.stderr.write(`[secretary] ${name} hook failed: ${(err as Error).stack ?? err}\n`);
        noteHookError(name, err, undefined, { session: currentHookSession() });
        const out = hookFailureOutput(name);
        if (out) process.stdout.write(out);
      }
    },
  },
  // The install check (what the session-start notice is built from). No database: a fresh copy can check itself before its first session.
  [CLI.setupCheck]: {
    usage: '[--skip <id,…> | --unskip <id,…|all>]',
    async run(args) {
      const o = setupOptions();
      const flag = args.findIndex((a) => a === '--skip' || a === '--unskip');
      if (flag >= 0) {
        const ids = (args[flag + 1] ?? '').split(',').filter(Boolean);
        if (!ids.length) throw usageError(CLI.setupCheck);
        console.log(`뺀 항목: ${setSkip(o.cacheFile, ids, args[flag] === '--unskip').join(', ') || '(없음)'}`);
        return;
      }
      const cache = saveReport(await checkSetup(o), o.cacheFile);
      console.log(formatReport(cache, cache.skip, offFeatureChecks(o.root)));
    },
  },
  // This folder's skills (install check item 'skills'): skills in .agents/skills, .claude/skills a link to it, common skills
  // from common-skills.json; a real .claude/skills folder's skills moved into .agents/skills, an off feature's skill to
  // .agents/skills-off (back when on). --dry-run only lists. No database.
  [CLI.skillLinks]: {
    usage: '[--dry-run]',
    run(args) {
      const dry = args.includes('--dry-run');
      // An optional feature's skill to its place first (on: .agents/skills, off: .agents/skills-off; setup/feature-skills.ts).
      const placed = fixFeatureSkills(PROJECT_ROOT, dry);
      for (const line of formatFeatureSkills(placed.plan, !dry)) console.log(line);
      for (const f of placed.failed) console.log(`실패: ${f}`);
      if (placed.failed.length) process.exitCode = 1;
      const fix = fixSkillLinks(PROJECT_ROOT, { dryRun: dry });
      for (const line of formatSkillLinkFix(fix, dry)) console.log(line);
      shippedCommonSkills(dry);
      const common = commonSkillProblem(PROJECT_ROOT, commonSkillsDirOf(PROJECT_ROOT));
      if (common) {
        if (!dry) fixCommonSkills(PROJECT_ROOT, commonSkillsDirOf(PROJECT_ROOT));
        const left = dry ? common : commonSkillProblem(PROJECT_ROOT, commonSkillsDirOf(PROJECT_ROOT));
        console.log(`공통 스킬(common-skills.json): ${dry ? `고칠 것 (${common})` : left ? `고쳤고 남은 것 (${left})` : `고침 (${common})`}`);
      }
      if (fix.failed.length) process.exitCode = 1;
    },
  },
  // What the work-session scripts (scripts/worker/) read from a work session's transcript, only through this: its last
  // answer, the last call's context size, the file; received: 있음|없음 and the file, whether a line carries the text
  // (send-worker checks its message reached the session). Nothing printed and exit code 2 when none
  // (workspace/worker-transcript.ts). No database.
  [CLI.workerTranscript]: {
    usage: `<${WORKER_TRANSCRIPT_WHAT.join('|')}> <config folder> <work session id> [<session uuid>] [--text <글> (received)]`,
    run(args) {
      const rest = args.slice(1);
      const text = takeOption(rest, '--text');
      const [configDir, id, sessionId] = rest;
      const what = WORKER_TRANSCRIPT_WHAT.find((w) => w === args[0]);
      if (!what || !configDir || !id || (what === 'received' && !text)) throw usageError(CLI.workerTranscript);
      const lines = workerTranscript(what, configDir, id, sessionId, text);
      if (lines) for (const line of lines) console.log(line);
      else process.exitCode = 2;
    },
  },
  // The watcher's verdict (scripts/worker/watch-worker.ps1) as one JSON line: gone, approval, rest or working, how far the
  // session wrote, a summary for the notice; the list and the screen from <exe>, or from the files in tests
  // (workspace/worker-status.ts). No database.
  [CLI.workerStatus]: {
    usage: '<config folder> <work session id> [--claude <exe>] [--prev <signature>] [--agents-file <file>] [--screen-file <file>]',
    run(args) {
      const [configDir, id] = args;
      const [claude, prev, agentsFile, screenFile] = ['--claude', '--prev', '--agents-file', '--screen-file'].map((n) => option(args, n, 2));
      if (!configDir || !id || (!claude && !agentsFile)) throw usageError(CLI.workerStatus);
      // PowerShell's Out-File may start the file with a byte order mark (readJsonStrict takes it off).
      const agents = agentsFile ? readJsonStrict<unknown>(agentsFile) : readAgentsWith(claude!);
      const readScreen = (): string | null => {
        if (screenFile) return fs.existsSync(screenFile) ? fs.readFileSync(screenFile, 'utf8') : null;
        return claude ? readScreenWith(claude, id) : null;
      };
      console.log(JSON.stringify(workerStatus({ configDir, id, agents, readScreen, prevSignature: prev })));
    },
  },
  // A work session's entry in `claude agents --json` of this process's config folder (worker-lib.ps1 Get-WorkerAgent), as
  // one JSON line, by findAgent's id rules (short id, uuid, bg:, name); nothing printed and exit code 2 when none
  // (workspace/worker-status.ts). No database.
  [CLI.workerAgent]: {
    usage: '<work session id | name> [--claude <exe>] [--agents-file <file>]',
    run(args) {
      const [claude, agentsFile] = [option(args, '--claude', 1), option(args, '--agents-file', 1)];
      if (!args[0] || (!claude && !agentsFile)) throw usageError(CLI.workerAgent);
      const agents = agentsFile ? readJsonStrict<unknown>(agentsFile) : readAgentsWith(claude!);
      const hit = findAgent(agents, args[0]);
      if (hit) console.log(JSON.stringify(hit));
      else process.exitCode = 2;
    },
  },
  // Stalled jobs in job-stalls.jsonl (workspace/job-stalls.ts): a tool that cut a stalled job records it (record) or clears
  // its in-a-row count after a run that did not stall (ok); the watcher reads the lines after an offset as JSON (watch);
  // the newest lines for a person (list). No database.
  [CLI.jobStall]: {
    usage: 'record|ok --file <json> | watch [--from <offset>] | list [--n <count>]',
    run(args) {
      const [what] = args;
      if (what === 'record' || what === 'ok') {
        const file = option(args, '--file', 1);
        if (!file) throw usageError(CLI.jobStall);
        const input = readJsonStrict<StallInput>(file);
        if (!input.source || !input.job) throw new Error(`usage: ${CLI.jobStall} ${COMMANDS[CLI.jobStall].usage} (the json needs source and job)`);
        if (what === 'record') console.log(JSON.stringify(recordStall(input)));
        else clearStreak(input);
      } else if (what === 'watch') {
        const from = option(args, '--from', 1);
        console.log(JSON.stringify(watchStalls(from === undefined ? undefined : Number(from) || 0)));
      } else if (what === 'list') {
        for (const line of listStalls(Number(option(args, '--n', 1)) || 10)) console.log(line);
      } else throw usageError(CLI.jobStall);
    },
  },
  // One DB backup run's result (core/backup-record.ts), from scripts/scheduled/backup-db.ps1. No database.
  [CLI.backupRecord]: {
    usage: '--file <json>',
    run(args) {
      const file = option(args, '--file');
      if (!file) throw usageError(CLI.backupRecord);
      console.log(JSON.stringify(recordBackup(readJsonStrict<BackupRun>(file))));
    },
  },
  // The semantic-search server: started by the secretary server (--parent, lives as long as <pid>, else idles out), or on
  // demand by the first recall; --refetch downloads the model first.
  [CLI.semanticSearchServer]: {
    usage: '[--parent <pid>] [--refetch]',
    async run(args) {
      const parent = args[0] === '--parent' ? Number(args[1]) || undefined : undefined;
      await runServer(parent, args.includes('--refetch'));
    },
  },
  // The usage reader (feature usage-poll): the checked providers every 5 minutes, one per PC; ends with <pid>, or at once
  // when the feature is off. Started by the secretary server. No database.
  [CLI.usagePoll]: {
    usage: '[--parent <pid>]',
    run(args) {
      const parent = args[0] === '--parent' ? Number(args[1]) || undefined : undefined;
      if (args[0] !== undefined && !parent) throw usageError(CLI.usagePoll);
      runUsagePoll(parent);
    },
  },
  // The provider "auto" means now (providers.json's default, or -Provider auto): the subscription with the most room,
  // feature multi-subscription; Use-Provider in providers.ps1 runs it. --root: the secretary folder whose providers.json to
  // read (Use-Provider passes its own, the same as this one outside the tests). No database.
  [CLI.subscriptionPick]: {
    usage: '[--root <secretary folder>]',
    run(args) {
      const has = args.includes('--root');
      const root = option(args, '--root');
      if (has && !root) throw usageError(CLI.subscriptionPick);
      console.log(subscriptionPick(Date.now(), undefined, { account: root ? { root } : undefined }));
    },
  },
  // Each workspace's secretary-link.local.json (and its .gitignore line), where its tools find this secretary, and its
  // AGENTS.md secretary blocks kept to the template; --dry-run only lists. Reads the database read-only
  // (secretary-link.ts linkedFolders); with none it does run-job's home folder only.
  [CLI.workspaceLinks]: {
    usage: '[--dry-run]',
    run(args) {
      const dry = args.includes('--dry-run');
      // A general release's common skills into _skills first, so the workspaces' links to them can be made (an update's finish runs this).
      shippedCommonSkills(dry);
      if (!fs.existsSync(DB_PATH)) console.log(noDbLine('공간 목록은 건너뛰고 run-job 기본 폴더만 봐요'));
      const folders = linkedFolders(DB_PATH, PROJECT_ROOT);
      let fixed = 0;
      for (const f of folders) {
        const problem = linkProblem(f, PROJECT_ROOT);
        if (!problem) continue;
        if (!dry) writeLink(f, PROJECT_ROOT);
        const left = dry ? null : linkProblem(f, PROJECT_ROOT);
        if (!left) fixed++;
        console.log(`${dry ? '고칠 것' : left ? '못 고침' : '고침'}: ${f} (${left ?? problem})`);
      }
      const { bin, id } = linkFor(PROJECT_ROOT);
      console.log(`공간 ${folders.length}개 중 ${dry ? '고칠 것' : '고친 것'} ${fixed}개 (${LINK_FILE}: ${JSON.stringify({ bin, id })})`);
    },
  },
  // The aux folders beside the workspaces (install check 'workspace-aux-folders'): the staff folders made or put right,
  // _run-job-home made when missing (setup/aux-folders.ts); --dry-run only lists. No database.
  [CLI.workspaceAuxFolders]: {
    usage: '[--dry-run]',
    run(args) {
      const dry = args.includes('--dry-run');
      const lines = formatFolderPlan(dry ? planAuxFolders(PROJECT_ROOT) : fixAuxFolders(PROJECT_ROOT), !dry);
      console.log(lines.length ? lines.join('\n') : '고칠 것 없음');
    },
  },
  [CLI.memoryStats]: {
    usage: '',
    db: true,
    viewOnly: always,
    run(_args, store) {
      console.log(JSON.stringify(store.stats(), null, 2));
    },
  },
  [CLI.dbBackup]: {
    usage: '',
    db: true,
    viewOnly: always,
    run(_args, store) {
      console.log(backupDb(store.db, path.join(PROJECT_ROOT, 'backups')));
    },
  },
  // The name the user is called by, kept in the DB only (meta user_title; the rules and code say 사용자): shown, set, or
  // cleared (store/user-title.ts). The checks that read memories written with it.
  [CLI.userTitle]: {
    usage: '[<호칭> | --clear]',
    db: true,
    viewOnly: (args) => args.length === 0,
    run(words, store) {
      if (words[0] === '--clear') store.clearUserTitle();
      else if (words.length) store.setUserTitle(words.join(' '));
      const t = store.userTitle();
      console.log(t ? `호칭: ${t} (글 검사는 '사용자'와 '${t}'(뒤의 '님' 있어도)을 사용자로 읽어요)` : `호칭 없음 (글 검사는 '사용자'만 읽어요). 넣기: node src/cli.ts ${CLI.userTitle} <호칭>`);
    },
  },
  [CLI.ingestTranscript]: {
    usage: '<transcript.jsonl>',
    db: true,
    run([file], store) {
      if (!file) throw usageError(CLI.ingestTranscript);
      console.log(ingestTranscript(store, file));
    },
  },
  // Drop branches a rewind abandoned in one transcript, the way purge-log deletes (rows kept in backups/error/); run
  // directly by the user or the secretary (the hooks do the same on their own). Rows as id, time, who and length only,
  // as "비서 대화 삭제" lists them: never the text.
  [CLI.rewindClean]: {
    usage: '<transcript.jsonl> [--dry-run] [--keep-memories]',
    db: true,
    viewOnly: (args) => args.includes('--dry-run'),
    run(args, store) {
      if (!args[0]) throw usageError(CLI.rewindClean);
      const dryRun = args.includes('--dry-run');
      const r = cleanRewound(store, args[0], { dryRun, keepMemories: args.includes('--keep-memories') });
      for (const b of r.branches) console.log(`갈래 ${b.root.slice(0, 8)} (${b.via}, ${formatLocal(b.from)}~${formatLocal(b.to)}): 줄 ${b.uuids.length}개, remember 결과 ${b.memoryIds.map((i) => `#${i}`).join(', ') || '없음'}`);
      for (const e of r.rows) console.log(`  ${rowLine(e)}`);
      console.log(`무효 처리할 기억: ${r.memoryIds.map((i) => `#${i}`).join(', ') || '없음'}`);
      console.log(`상황판: ${r.boardReset ? (dryRun ? '이 대화를 이미 읽었으니 비우고 다시 써요' : '비웠어요(다시 써요)') : '그대로'} · 남은 질문에서 ${dryRun ? '뺄' : '뺀'} 것: ${r.questions.join(', ') || '없음'}`);
      if (!dryRun) console.log(`지운 줄 ${r.quarantine ? r.rows.length : 0}개, 무효 처리 ${r.forgotten.map((i) => `#${i}`).join(', ') || '없음'}`);
      if (r.quarantine) console.log(`지운 줄 보관(격리 DB, 비서는 읽지 않고 언제 지워도 돼요): ${r.quarantine}`);
    },
  },
  // What the "비서 대화 삭제" phrase does, run directly by the user or the secretary: preview (rows, first letters of their
  // words, approval code); delete (lists unless --confirm; rows kept in backups/error/); restore (put deleted rows back
  // from that file). No row text is printed.
  [CLI.purgeLog]: {
    usage: '[preview|restore] <2턴 | 120 | 120-135> [--here <session id> | --session <id>] [--confirm]',
    db: true,
    viewOnly: (args) => !args.includes('--confirm'),
    run(given, store) {
      const args = [...given];
      const confirm = args.includes('--confirm');
      const sessionPrefix = takeOption(args, '--session');
      const here = takeOption(args, '--here');
      // --summarize (the old Haiku summaries) is still taken and ignored, for an order written before 2026-11-06.
      const words = args.filter((a) => a !== '--confirm' && a !== '--summarize');
      if (words[0] === 'preview') {
        const spec = parseSpec(words.slice(1).join(' '));
        if (!spec) throw new Error('usage: purge-log preview <2턴 | 120 | 120-135> [--here <session id> | --session <id>]  (PowerShell에서는 # 없이)');
        console.log(runPreview(store, spec, { here, sessionPrefix }));
        return;
      }
      if (words[0] === 'restore') {
        const spec = parseSpec(words.slice(1).join(' '));
        if (!spec || spec.kind === 'turns') throw new Error('usage: purge-log restore <120 | 120-135> [--confirm]');
        const [from, to] = spec.kind === 'turn' ? [spec.id, spec.id] : [spec.from, spec.to];
        const rows = restorePurged(store, from, to, !confirm);
        if (!rows.length) console.log(`격리 DB에 #${from}~#${to}이 없어요.`);
        const label = { restore: '되돌릴 것', restored: '되돌림', 'in-log': '이미 대화 기록에 있음' } as const;
        for (const r of rows) console.log(`- #${r.logId}${r.newId && r.newId !== r.logId ? ` → #${r.newId}` : ''} ${formatLocal(r.created_at)} ${r.role} ${r.chars}자: ${label[r.state]}`);
        if (!confirm && rows.some((r) => r.state === 'restore')) console.log('되돌리려면 --confirm을 붙여 다시 실행하세요. 무효 처리된 기억은 그대로 둬요.');
        return;
      }
      const spec = parseSpec(words.join(' '));
      if (!spec) throw new Error('usage: purge-log <2턴 | 120 | 120-135> [--session <id>] [--confirm]  (PowerShell에서는 # 없이)');
      const plan = planPurge(store, spec, { sessionPrefix });
      if ('error' in plan) throw new Error(plan.error);
      console.log(formatPlan(plan));
      if (confirm) console.log(formatResult(executePurge(store, plan)));
      else console.log('지우려면 --confirm을 붙여 다시 실행하세요.');
    },
  },
  // server-control.ps1 restart: log every secretary transcript right after the server stops, so the turn that asked for
  // the restart (cut off before its Stop hook) is not lost.
  [CLI.catchUpTranscripts]: {
    usage: '',
    db: true,
    run(_args, store) {
      console.log(JSON.stringify({ added: catchUpTranscripts(store, undefined, 0) }));
    },
  },
  // Rewrite the situation board. Started detached by the first prompt of a new session; the user or the secretary can also
  // run it directly to test the rewrite. --detach (the secretary-update skill, right after an update): start it in the
  // background and return, so the next session reads the new format.
  [CLI.situationBoardUpdate]: {
    usage: '[--detach]',
    db: true,
    async run([arg], store) {
      if (arg === '--detach') {
        console.log(spawnBoardJobAfterUpdate(store));
        return;
      }
      if (arg !== undefined) throw usageError(CLI.situationBoardUpdate);
      console.log(JSON.stringify(await runBoardUpdate(store)));
    },
  },
  // Print the board, or (--before-todo) the last board that still had the to-do sections.
  [CLI.situationBoardShow]: {
    usage: '[--before-todo]',
    db: true,
    viewOnly: always,
    run([arg], store) {
      if (arg === '--before-todo') {
        const old = store.getJson<Board>(BEFORE_TODO_KEY);
        console.log(old ? `(${formatLocal(old.updatedAt)} 상황판, 할 일 칸이 있던 마지막 판)\n${old.text}` : '(할 일 칸이 있던 옛 상황판 없음)');
      } else console.log(readBoard(store)?.text || '(상황판 없음)');
    },
  },
  // Idle jobs (board rewrite and memory consolidation when talk has paused): every 5 minutes from Task Scheduler
  // ('Secretary Idle Jobs (<secretary id>)').
  [CLI.idleJobs]: {
    usage: '',
    db: true,
    async run(_args, store) {
      const did = await runIdleJobs(store, { bgJobsRoot: path.join(secretaryStateDir(), 'bg-jobs') });
      console.log(`${formatLocal(nowIso())} ${did.join(', ')}`);
    },
  },
  // One memory consolidation now by the staff member of that name, unless one is running (memory/consolidate-run.ts),
  // started directly by the user or the secretary; --detach (the consolidate skill's /consolidate): started apart, returns at once.
  [CLI.memoryConsolidation]: {
    usage: '[--detach]',
    db: true,
    async run([arg], store) {
      const running = (j?: ConsolidateJob) =>
        `이미 도는 정리가 있어요(${j ? `${formatLocal(j.startedAt)}부터, ${j.by === 'idle' ? '쉬는 시간 정리' : j.by === 'manual' ? '/consolidate' : '시작한 곳 모름'}` : '기록 없음'}). 새로 띄우지 않았어요.`;
      if (arg === '--detach') {
        const s = spawnConsolidate(store);
        console.log(s.started ? `기억 정리를 뒤에서 시작했어요(pid ${s.pid}). 끝나면 다음 답에 '기억 정리 확인' 안내가 붙어요.` : running(s.running));
        return;
      }
      if (arg !== undefined) throw usageError(CLI.memoryConsolidation);
      const r = await runConsolidate(store, 'manual');
      console.log(`${formatLocal(nowIso())} ${r.report === null ? running(r.running) : r.report.ok ? 'consolidate' : 'consolidate-failed'}`);
    },
  },
  // New session after a handoff: log the old one, rewrite and print the board.
  [CLI.sessionHandoffWake]: {
    usage: '<old session id>',
    db: true,
    async run([old], store) {
      if (!old) throw usageError(CLI.sessionHandoffWake);
      console.log(await sessionHandoffWake(store, old));
    },
  },
  // An action memory's owner, due date, condition, state (store/memory-actions.ts), set by the secretary or the user
  // (moving the old to-dos into the table, or fixing a mark).
  [CLI.actionSet]: {
    usage: '<memory id> [--owner user|secretary] [--due <YYYY-MM-DD|YYYY-MM-DDTHH:MM+09:00|none>] [--cond <kind:value|none>] [--state waiting|met|maybe_met] [--clear-done] [--log <row id>]',
    db: true,
    run(args, store) {
      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) throw usageError(CLI.actionSet);
      const [owner, state, due, cond, log] = ['--owner', '--state', '--due', '--cond', '--log'].map((n) => option(args, n, 1));
      if (owner && !ACTION_OWNERS.includes(owner as ActionOwner)) throw new Error(`--owner는 ${ACTION_OWNERS.join('|')}`);
      if (state && !ACTION_STATES.includes(state as ActionState)) throw new Error(`--state는 ${ACTION_STATES.join('|')}`);
      const input: ActionInput = {
        by: 'cli',
        ...(owner ? { owner: owner as ActionOwner } : {}),
        ...(state ? { state: state as ActionState } : {}),
        ...(due !== undefined ? { due: due === 'none' ? null : due } : {}),
        ...(cond !== undefined ? { condition: cond === 'none' ? null : parseCondition(cond) } : {}),
        ...(args.includes('--clear-done') ? { clearDone: true } : {}),
        ...(log !== undefined ? { logId: Number(log) } : {}),
      };
      store.setAction(id, input);
      console.log(todoListLines(store).find((l) => l.startsWith(`- #${id} `)) ?? `#${id} 저장`);
    },
  },
  // Every live action memory with its values.
  [CLI.actionList]: {
    usage: '',
    db: true,
    viewOnly: always,
    run(_args, store) {
      console.log(todoListLines(store).join('\n'));
    },
  },
  // The to-do summary as the prompt hook builds it.
  [CLI.todoSummary]: {
    usage: '',
    db: true,
    viewOnly: always,
    run(_args, store) {
      console.log(renderSummary(buildSummary(store)));
    },
  },
  // Fetch the calendar's events now, when a key is set (todo-summary/calendar.ts; never prints the address). The Stop hook
  // starts this apart after a turn that changed the calendar; the idle jobs fetch every 30 minutes.
  [CLI.calendarFetch]: {
    usage: '',
    db: true,
    async run(_args, store) {
      const r = await fetchCalendar(store);
      console.log(r === 'skipped' ? '일정 받기 건너뜀: 키 설정 없음' : r.ok ? `일정 ${r.count}개 받음 (${r.ms}ms)` : `일정 받기 실패: ${r.error}`);
    },
  },
  // watch-worker.ps1 at idle: when the session's transcript in that config folder ends on a [질문], its running task goes
  // to asking (workspace/worker-asking.ts); nothing printed when nothing changed. send-worker.ps1 after a message went in
  // (--answered): the session's asking tasks go back to running.
  [CLI.workerAsking]: {
    usage: '<work session id> <config folder> [<session uuid>] | <work session id> --answered',
    db: true,
    run([id, configDir, sessionId], store) {
      if (!id || !configDir) throw usageError(CLI.workerAsking);
      const lines = configDir === '--answered' ? markAnswered(store, id) : markAskingFromTranscript(store, id, configDir, sessionId);
      for (const line of lines) console.log(line);
    },
  },
  // The caller moves the workspace's folder first; this records where it went and hides it from list_workspaces.
  [CLI.archiveWorkspace]: {
    usage: '<id> <moved folder>',
    db: true,
    run([idText, folder], store) {
      const id = Number(idText);
      if (!id || !folder || !fs.existsSync(folder)) throw usageError(CLI.archiveWorkspace);
      const w = store.archiveWorkspace(id, path.resolve(folder));
      console.log(`공간 #${w.id} ${w.title} 보관 → ${w.folder}`);
    },
  },
};

/** Every command with what it takes, for a missing or unknown command. */
const USAGE = `usage: node src/cli.ts <command> …\n${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name}${c.usage ? ` ${c.usage}` : ''}`)
  .join('\n')}`;

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  const cmd = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!cmd) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!cmd.db) {
    await cmd.run(args);
    return;
  }
  // Commands that only look (or back up) never make a database: a missing one is said and skipped, not created empty.
  if (cmd.viewOnly?.(args) && !fs.existsSync(DB_PATH)) {
    console.log(noDbLine('이 명령은 아무것도 하지 않았어요'));
    return;
  }
  const store = new Store(openDb());
  try {
    await cmd.run(args, store);
  } finally {
    store.db.close();
  }
}

/** A general release's common skills copied into workspaces/_skills when missing there (workspace/common-skills.ts; the original ships none, so nothing is said). */
function shippedCommonSkills(dry: boolean): void {
  const dir = commonSkillsDirOf(PROJECT_ROOT);
  const problem = shippedCommonSkillProblem(PROJECT_ROOT, dir);
  if (!problem) return;
  const made = dry ? [] : installShippedCommonSkills(PROJECT_ROOT, dir);
  const left = dry ? problem : shippedCommonSkillProblem(PROJECT_ROOT, dir);
  console.log(`배포판 공통 스킬(${dir}): ${dry ? `고칠 것 (${problem})` : `${made.length ? `깖 ${made.join(', ')}` : '깐 것 없음'}${left ? ` · 남은 것 (${left})` : ''}`}`);
}

const noDbLine = (what: string) => `비서 DB가 없어요(${DB_PATH}). 보기만 하는 명령이라 새로 만들지 않고, ${what}.`;

try {
  await main();
} catch (err) {
  process.stderr.write(`${cliErrorLine(err)}\n`);
  try {
    noteCliError(err, process.argv.slice(2));
  } catch {
    // The record could not be written: the line above is still there.
  }
  process.exitCode = 1;
}
