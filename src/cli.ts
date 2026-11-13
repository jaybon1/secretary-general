/**
 * Command-line entry point.
 *
 *   node src/cli.ts hook session-start|prompt|stop   (called by Claude Code hooks; JSON on stdin)
 *   node src/cli.ts situation-board-update [--detach] | situation-board-show   (rewrite the situation board, --detach: in the background after an update / print it)
 *   node src/cli.ts idle-jobs   (idle jobs: board rewrite and memory consolidation when talk has paused; Task Scheduler runs it every 5 min)
 *   node src/cli.ts memory-consolidation [--detach]   (one memory consolidation now by the staff member of that name, unless one is running; --detach: started apart, returns at once (/consolidate))
 *   node src/cli.ts workspace-aux-folders [--dry-run]   (the aux folders beside the workspaces: old names run-job-home and old (or _old) moved to _run-job-home and _archived with the database's workspaces under them, the staff folders made (old ones moved), _run-job-home made when missing; --dry-run only lists)
 *   node src/cli.ts session-handoff-wake <old session id>   (new session after a handoff: log the old one, rewrite and print the board)
 *   node src/cli.ts setup-check [--skip <id,…> | --unskip <id,…|all>]   (install check; what the session-start notice is built from)
 *   node src/cli.ts this-secretary-merge [--dry-run]   (this PC's separate settings files scripts/*.local.json into this-secretary.local.json, one section per feature; never overwrites, the old file goes to backups/this-secretary-merge/; --dry-run only lists; exit 1 while a file is left)
 *   node src/cli.ts workspace-links [--dry-run] [--add-missing <폴더 이름,…>]   (write each workspace's secretary-link.local.json, where its tools find this secretary, and keep its AGENTS.md secretary blocks to the template; --dry-run only lists; --add-missing: those workspaces' unmarked AGENTS.md also get the template sections they lack)
 *   node src/cli.ts skill-links [--dry-run]   (skills in .agents/skills, .claude/skills a link to it, common skills from common-skills.json; moves the old skills/ layout and an off feature's skill to .agents/skills-off (back when on); --dry-run only lists)
 *   node src/cli.ts memory-stats
 *   node src/cli.ts user-title [<호칭> | --clear]   (the name the user is called by, kept in the DB (meta user_title): shown, set, or cleared; store/user-title.ts)
 *   node src/cli.ts db-backup
 *   node src/cli.ts ingest-transcript <transcript.jsonl>
 *   node src/cli.ts rewind-clean <transcript.jsonl> [--dry-run] [--keep-memories]   (drop branches a rewind abandoned, the way purge-log deletes; rows kept in backups/error/)
 *   node src/cli.ts purge-log preview <2턴 | 120 | 120-135> [--here <session id> | --session <id>]   ("비서 대화 삭제" preview: rows, first letters of their words, approval code)
 *   node src/cli.ts purge-log <2턴 | 120 | 120-135> [--session <id>] [--confirm]   (delete conversation rows; lists unless --confirm; rows kept in backups/error/)
 *   node src/cli.ts purge-log restore <120 | 120-135> [--confirm]   (put deleted rows back from that file)
 *   node src/cli.ts context-tokens <transcript.jsonl>   (last model call's context size from the last 4 MB; nothing printed if none)
 *   node src/cli.ts main-agenda-from-profile <plan.json> [--apply]   (once, updating from v7: profile's 큰 일 칸 → main-agenda board; first run writes the plan to check, --apply puts it in)
 *   node src/cli.ts semantic-search-server [--parent <pid>] [--refetch]   (the semantic-search server; lives as long as <pid>, else idles out; --refetch downloads the model first)
 *   node src/cli.ts usage-poll [--parent <pid>]   (usage reader, feature usage-poll: the checked providers every 5 minutes; one per PC; ends with <pid>, or at once when the feature is off)
 *   node src/cli.ts subscription-pick [--root <secretary folder>]   (the provider "auto" means now: the subscription with the most room, feature multi-subscription; Use-Provider in providers.ps1 runs it)
 *
 * Only the hooks and the commands that write make secretary.db when it is missing. The ones that only look (any --dry-run,
 * setup-check, memory-stats, situation-board-show, db-backup, purge-log without --confirm) say there is none and skip what needs it (viewOnly).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionHandoffWake } from './session-continuity/session-handoff.ts';
import { applyPlan, planFromProfile, planProblems, type MovePlan } from './upgrade/main-agenda-move.ts';
import { readBoard, runBoardUpdate, spawnBoardJobAfterUpdate } from './session-continuity/situation-board.ts';
import { catchUpTranscripts } from './log/catch-up.ts';
import { runHook } from './hooks/run-hook.ts';
import { DB_PATH, PROJECT_ROOT } from './core/config.ts';
import { commonSkillsDirOf, LINK_FILE, linkedFolders, linkFor, linkProblem, writeLink } from './workspace/secretary-link.ts';
import { commonSkillProblem, fixCommonSkills } from './workspace/common-skills.ts';
import { lastContextTokens } from './hooks/context-size-nudge.ts';
import { backupDb, openDb } from './store/schema.ts';
import { offFeatureChecks } from './core/features.ts';
import { ingestTranscript } from './log/ingest-transcript.ts';
import { executePurge, formatPlan, formatResult, parseSpec, planPurge, restorePurged, rowLine } from './log/purge.ts';
import { runPreview } from './log/purge-initials.ts';
import { cleanRewound } from './log/rewind.ts';
import { runServer } from './semantic-search/client.ts';
import { checkSetup, formatReport, saveReport, setSkip, setupOptions } from './setup/setup-check.ts';
import { fixSkillLinks, formatSkillLinkFix } from './setup/skill-links.ts';
import { fixFeatureSkills, formatFeatureSkills } from './setup/feature-skills.ts';
import { Store } from './store/store.ts';
import { formatLocal, nowIso } from './core/kst-time.ts';
import { runIdleJobs } from './idle/idle-jobs.ts';
import { runConsolidate, spawnConsolidate, type ConsolidateJob } from './memory/consolidate-run.ts';
import { fixAuxFolders, formatFolderPlan, planAuxFolders } from './workspace/aux-folders.ts';
import { runUsagePoll } from './usage/usage-poller.ts';
import { subscriptionPick } from './usage/subscription-routing.ts';
import { CLI } from './core/names.ts';
import { moveRenamedLocalFiles } from './core/local-settings.ts';
import { mergeThisSecretaryFiles } from './core/this-secretary.ts';

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  // This PC's files under names changed since (core/local-settings.ts) move before any command can make the new ones: the
  // semantic-search server and the hooks write files beside the database, and a new one made first left the old one behind
  // (2026-11-09: the server started before the first session's hook moved them).
  moveRenamedLocalFiles(PROJECT_ROOT, DB_PATH);
  if (cmd === CLI.hook) {
    try {
      await runHook(arg);
    } catch (err) {
      // A memory hiccup must never block the conversation: report and exit 0.
      process.stderr.write(`[secretary] ${arg} hook failed: ${(err as Error).stack ?? err}\n`);
    }
    return;
  }
  if (cmd === CLI.setupCheck) {
    // Needs no database: a fresh copy can check itself before its first session.
    const o = setupOptions();
    const flag = process.argv.findIndex((a) => a === '--skip' || a === '--unskip');
    if (flag >= 0) {
      const ids = (process.argv[flag + 1] ?? '').split(',').filter(Boolean);
      if (!ids.length) throw new Error('usage: setup-check --skip <id,…> | --unskip <id,…|all>');
      console.log(`뺀 항목: ${setSkip(o.cacheFile, ids, process.argv[flag] === '--unskip').join(', ') || '(없음)'}`);
      return;
    }
    const cache = saveReport(await checkSetup(o), o.cacheFile);
    console.log(formatReport(cache, cache.skip, offFeatureChecks(o.root)));
    return;
  }
  if (cmd === CLI.skillLinks) {
    // This folder's skills (install check item 'skills'): .agents/skills, the .claude/skills link, the common skills; no database needed.
    const dry = process.argv.includes('--dry-run');
    // An optional feature's skill to its place first (on: .agents/skills, off: .agents/skills-off; setup/feature-skills.ts).
    const placed = fixFeatureSkills(PROJECT_ROOT, dry);
    for (const line of formatFeatureSkills(placed.plan, !dry)) console.log(line);
    for (const f of placed.failed) console.log(`실패: ${f}`);
    if (placed.failed.length) process.exitCode = 1;
    const fix = fixSkillLinks(PROJECT_ROOT, { dryRun: dry });
    for (const line of formatSkillLinkFix(fix, dry)) console.log(line);
    const common = commonSkillProblem(PROJECT_ROOT, commonSkillsDirOf(PROJECT_ROOT));
    if (common) {
      if (!dry) fixCommonSkills(PROJECT_ROOT, commonSkillsDirOf(PROJECT_ROOT));
      const left = dry ? common : commonSkillProblem(PROJECT_ROOT, commonSkillsDirOf(PROJECT_ROOT));
      console.log(`공통 스킬(common-skills.json): ${dry ? `고칠 것 (${common})` : left ? `고쳤고 남은 것 (${left})` : `고침 (${common})`}`);
    }
    if (fix.failed.length) process.exitCode = 1;
    return;
  }
  if (cmd === CLI.contextTokens) {
    // For the work-session scripts (worker-lib.ps1); no database needed.
    if (!arg) throw new Error('usage: context-tokens <transcript.jsonl>');
    const tokens = lastContextTokens(arg, 4 * 1024 * 1024);
    if (tokens) console.log(tokens);
    return;
  }
  if (cmd === CLI.semanticSearchServer) {
    // The semantic-search server: started by the secretary server (--parent), or on demand by the first recall.
    const parent = arg === '--parent' ? Number(process.argv[4]) || undefined : undefined;
    await runServer(parent, process.argv.includes('--refetch'));
    return;
  }
  if (cmd === CLI.usagePoll) {
    // The usage reader (feature usage-poll): started by the secretary server (--parent); no database needed.
    const parent = arg === '--parent' ? Number(process.argv[4]) || undefined : undefined;
    if (arg !== undefined && !parent) throw new Error('usage: usage-poll [--parent <pid>]');
    runUsagePoll(parent);
    return;
  }
  if (cmd === CLI.subscriptionPick) {
    // What providers.json's default "auto" (or -Provider auto) runs on now; no database needed. --root: the secretary folder
    // whose providers.json to read (Use-Provider passes its own, the same as this one outside the tests).
    const i = process.argv.indexOf('--root');
    const root = i >= 0 ? process.argv[i + 1] : undefined;
    if (i >= 0 && !root) throw new Error('usage: subscription-pick [--root <secretary folder>]');
    console.log(subscriptionPick(Date.now(), undefined, { account: root ? { root } : undefined }));
    return;
  }
  if (cmd === CLI.workspaceLinks) {
    // Each workspace's secretary-link.local.json (and its .gitignore line): what its tools read to find this secretary. Reads the
    // database read-only (secretary-link.ts linkedFolders); with none it does run-job's home folder only.
    const dry = process.argv.includes('--dry-run');
    const a = process.argv.indexOf('--add-missing');
    const addMissing = new Set(a >= 0 ? (process.argv[a + 1] ?? '').split(',').filter(Boolean) : []);
    if (a >= 0 && !addMissing.size) throw new Error('usage: workspace-links [--dry-run] [--add-missing <폴더 이름,…>]');
    if (!fs.existsSync(DB_PATH)) console.log(noDbLine('공간 목록은 건너뛰고 run-job 기본 폴더만 봐요'));
    const folders = linkedFolders(DB_PATH, PROJECT_ROOT);
    let fixed = 0;
    for (const f of folders) {
      const add = addMissing.has(path.basename(f));
      const problem = linkProblem(f, PROJECT_ROOT);
      if (!problem && !add) continue;
      if (!dry) writeLink(f, PROJECT_ROOT, add);
      const left = dry ? null : linkProblem(f, PROJECT_ROOT);
      if (!left) fixed++;
      console.log(`${dry ? '고칠 것' : left ? '못 고침' : '고침'}: ${f} (${left ?? problem ?? '빠진 절 더하기'})`);
    }
    const { bin, id } = linkFor(PROJECT_ROOT);
    console.log(`공간 ${folders.length}개 중 ${dry ? '고칠 것' : '고친 것'} ${fixed}개 (${LINK_FILE}: ${JSON.stringify({ bin, id })})`);
    return;
  }
  if (cmd === CLI.thisSecretaryMerge) {
    // The separate scripts/*.local.json files into this-secretary.local.json (core/this-secretary.ts): nothing overwritten, an old file
    // moved to backups/this-secretary-merge/ once all of it is in. No database needed. Exit 1 while a file is left.
    const { lines, left } = mergeThisSecretaryFiles(PROJECT_ROOT, { dryRun: process.argv.includes('--dry-run') });
    console.log(lines.join('\n'));
    if (left.length) process.exitCode = 1;
    return;
  }
  if (cmd === CLI.workspaceAuxFolders) {
    // The aux folders beside the workspaces (install check 'workspace-aux-folders'): old names moved, retired workspaces
    // recorded under old\ or _old\ pointed at _archived\, the staff folders made. The database is read read-only (aux-folders.ts)
    // and opened for writing only to record a moved workspace, which a missing database has none of.
    if (!fs.existsSync(DB_PATH)) console.log(noDbLine('공간 기록 옮기기는 건너뛰고 폴더만 봐요'));
    if (process.argv.includes('--dry-run')) {
      const lines = formatFolderPlan(planAuxFolders(PROJECT_ROOT, DB_PATH));
      console.log(lines.length ? lines.join('\n') : '고칠 것 없음');
      return;
    }
    let store: Store | undefined;
    try {
      const { plan, failed } = fixAuxFolders(PROJECT_ROOT, DB_PATH, (id, folder) => void (store ??= new Store(openDb())).moveWorkspace(id, folder));
      const lines = formatFolderPlan(plan, true);
      console.log(lines.length ? lines.join('\n') : '고칠 것 없음');
      for (const f of failed) console.log(`실패: ${f}`);
      if (failed.length) process.exitCode = 1;
    } finally {
      store?.db.close();
    }
    return;
  }
  if (!DB_COMMANDS.has(cmd ?? '')) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  // Commands that only look (or back up) never make a database: a missing one is said and skipped, not created empty.
  if (viewOnly(cmd, process.argv.slice(3)) && !fs.existsSync(DB_PATH)) {
    console.log(noDbLine('이 명령은 아무것도 하지 않았어요'));
    return;
  }

  const store = new Store(openDb());
  try {
    switch (cmd) {
      case CLI.memoryStats:
        console.log(JSON.stringify(store.stats(), null, 2));
        break;
      case CLI.dbBackup:
        console.log(backupDb(store.db, path.join(PROJECT_ROOT, 'backups')));
        break;
      case CLI.userTitle: {
        // The name the user is called by, in the DB only (the rules and code say 사용자): the checks that read memories written with it.
        const words = process.argv.slice(3);
        if (words[0] === '--clear') store.clearUserTitle();
        else if (words.length) store.setUserTitle(words.join(' '));
        const t = store.userTitle();
        console.log(t ? `호칭: ${t} (글 검사는 '사용자'와 '${t}'(뒤의 '님' 있어도)을 사용자로 읽어요)` : `호칭 없음 (글 검사는 '사용자'만 읽어요). 넣기: node src/cli.ts ${CLI.userTitle} <호칭>`);
        break;
      }
      case CLI.ingestTranscript:
        if (!arg) throw new Error('usage: ingest-transcript <transcript.jsonl>');
        console.log(ingestTranscript(store, arg));
        break;
      case CLI.rewindClean: {
        // Run directly by the user or the secretary: what a rewind left behind in one transcript (the hooks do the same on their own).
        if (!arg) throw new Error('usage: rewind-clean <transcript.jsonl> [--dry-run] [--keep-memories]');
        // Rows as id, time, who and length only, as "비서 대화 삭제" lists them: never the text.
        const dryRun = process.argv.includes('--dry-run');
        const r = cleanRewound(store, arg, { dryRun, keepMemories: process.argv.includes('--keep-memories') });
        for (const b of r.branches) console.log(`갈래 ${b.root.slice(0, 8)} (${b.via}, ${formatLocal(b.from)}~${formatLocal(b.to)}): 줄 ${b.uuids.length}개, remember 결과 ${b.memoryIds.map((i) => `#${i}`).join(', ') || '없음'}`);
        for (const e of r.rows) console.log(`  ${rowLine(e)}`);
        console.log(`무효 처리할 기억: ${r.memoryIds.map((i) => `#${i}`).join(', ') || '없음'}`);
        console.log(`상황판: ${r.boardReset ? (dryRun ? '이 대화를 이미 읽었으니 비우고 다시 써요' : '비웠어요(다시 써요)') : '그대로'} · 남은 질문에서 ${dryRun ? '뺄' : '뺀'} 것: ${r.questions.join(', ') || '없음'}`);
        if (!dryRun) console.log(`지운 줄 ${r.quarantine ? r.rows.length : 0}개, 무효 처리 ${r.forgotten.map((i) => `#${i}`).join(', ') || '없음'}`);
        if (r.quarantine) console.log(`지운 줄 보관(격리 DB, 비서는 읽지 않고 언제 지워도 돼요): ${r.quarantine}`);
        break;
      }
      case CLI.purgeLog: {
        // Run directly by the user or the secretary, what the "비서 대화 삭제" phrase does: lists unless --confirm. No row text is printed.
        const args = process.argv.slice(3);
        const flag = (name: string) => {
          const i = args.indexOf(name);
          return i >= 0 ? args.splice(i, 2)[1] : undefined;
        };
        const confirm = args.includes('--confirm');
        const sessionPrefix = flag('--session');
        const here = flag('--here');
        // --summarize (the old Haiku summaries) is still taken and ignored, for an order written before 2026-11-06.
        const words = args.filter((a) => a !== '--confirm' && a !== '--summarize');
        if (words[0] === 'preview') {
          // What the secretary runs for a "비서 대화 삭제" phrase: rows and memories with each word's first letter, then the approval code.
          const spec = parseSpec(words.slice(1).join(' '));
          if (!spec) throw new Error('usage: purge-log preview <2턴 | 120 | 120-135> [--here <session id> | --session <id>]  (PowerShell에서는 # 없이)');
          console.log(runPreview(store, spec, { here, sessionPrefix }));
          break;
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
          break;
        }
        const spec = parseSpec(words.join(' '));
        if (!spec) throw new Error('usage: purge-log <2턴 | 120 | 120-135> [--session <id>] [--confirm]  (PowerShell에서는 # 없이)');
        const plan = planPurge(store, spec, { sessionPrefix });
        if ('error' in plan) throw new Error(plan.error);
        console.log(formatPlan(plan));
        if (confirm) console.log(formatResult(executePurge(store, plan)));
        else console.log('지우려면 --confirm을 붙여 다시 실행하세요.');
        break;
      }
      case CLI.catchUpTranscripts:
        // server-control.ps1 restart: log every secretary transcript right after the server stops,
        // so the turn that asked for the restart (cut off before its Stop hook) is not lost.
        console.log(JSON.stringify({ added: catchUpTranscripts(store, undefined, 0) }));
        break;
      case CLI.situationBoardUpdate: {
        // Started detached by the first prompt of a new session; the user or the secretary can also run it directly to test the rewrite.
        // --detach (the secretary-update skill, right after an update): start it in the background and return, so the next session reads the new format.
        if (arg === '--detach') {
          console.log(spawnBoardJobAfterUpdate(store));
          break;
        }
        if (arg !== undefined) throw new Error(`usage: ${CLI.situationBoardUpdate} [--detach]`);
        const job = await runBoardUpdate(store);
        console.log(JSON.stringify(job));
        break;
      }
      case CLI.idleJobs: {
        // Every 5 minutes from Task Scheduler ('Secretary Idle Jobs (<secretary id>)').
        const did = await runIdleJobs(store);
        console.log(`${formatLocal(nowIso())} ${did.join(', ')}`);
        break;
      }
      case CLI.memoryConsolidation: {
        // One consolidation now, started directly by the user or the secretary (the consolidate skill's /consolidate adds --detach); never two at once (memory/consolidate-run.ts).
        const running = (j?: ConsolidateJob) =>
          `이미 도는 정리가 있어요(${j ? `${formatLocal(j.startedAt)}부터, ${j.by === 'idle' ? '쉬는 시간 정리' : j.by === 'manual' ? '/consolidate' : '시작한 곳 모름'}` : '기록 없음'}). 새로 띄우지 않았어요.`;
        if (arg === '--detach') {
          const s = spawnConsolidate(store);
          console.log(s.started ? `기억 정리를 뒤에서 시작했어요(pid ${s.pid}). 끝나면 다음 답에 '기억 정리 확인' 안내가 붙어요.` : running(s.running));
          break;
        }
        if (arg !== undefined) throw new Error(`usage: ${CLI.memoryConsolidation} [--detach]`);
        const r = await runConsolidate(store, 'manual');
        console.log(`${formatLocal(nowIso())} ${r.report === null ? running(r.running) : r.report.ok ? 'consolidate' : 'consolidate-failed'}`);
        break;
      }
      case CLI.sessionHandoffWake:
        if (!arg) throw new Error('usage: session-handoff-wake <old session id>');
        console.log(await sessionHandoffWake(store, arg));
        break;
      case CLI.situationBoardShow:
        console.log(readBoard(store)?.text || '(상황판 없음)');
        break;
      case CLI.archiveWorkspace: {
        // The caller moves the folder first; this records where it went and hides it from list_workspaces.
        const [id, folder] = [Number(arg), process.argv[4]];
        if (!id || !folder || !fs.existsSync(folder)) throw new Error('usage: archive-workspace <id> <moved folder>');
        const w = store.archiveWorkspace(id, path.resolve(folder));
        console.log(`공간 #${w.id} ${w.title} 보관 → ${w.folder}`);
        break;
      }
      case CLI.mainAgendaFromProfile: {
        if (!arg) throw new Error('usage: main-agenda-from-profile <plan.json> [--apply]');
        if (process.argv.includes('--apply')) {
          const plan = JSON.parse(fs.readFileSync(arg, 'utf8')) as MovePlan;
          const r = applyPlan(store, plan);
          console.log(`주요 현안 ${r.board}줄 넣음, 프로필 v${r.profileVersion} 저장(큰 일 칸 뺌)`);
          break;
        }
        const profile = store.getProfile();
        if (!profile) throw new Error('프로필이 없어요.');
        if (fs.existsSync(arg)) throw new Error(`계획 파일이 이미 있어요: ${arg} (고쳤으면 --apply, 새로 만들려면 지우고 다시)`);
        const plan = planFromProfile(profile.content, profile.version);
        fs.writeFileSync(arg, JSON.stringify(plan, null, 2), 'utf8');
        const problems = planProblems(plan);
        console.log(
          [
            `프로필 v${profile.version}의 큰 일 칸 ${plan.section.length}줄 → 주요 현안 ${plan.rows.length}줄 (계획: ${arg})`,
            ...plan.rows.map((r) => `- ${r.name} — ${r.state}${r.note ? ` (${r.note})` : ''}`),
            problems.length ? `고칠 것:\n- ${problems.join('\n- ')}` : '고칠 것 없음. 줄마다 상태가 맞는지 보고 --apply로 넣는다.',
          ].join('\n'),
        );
        break;
      }
      default:
        console.error(USAGE);
        process.exitCode = 1;
    }
  } finally {
    store.db.close();
  }
}

const USAGE =
  `usage: node src/cli.ts <${CLI.hook} session-start|prompt|stop | ${CLI.setupCheck} [--skip ids|--unskip ids] | ${CLI.memoryStats} | ${CLI.userTitle} [<호칭>|--clear] | ${CLI.dbBackup} | ${CLI.ingestTranscript} <file> | ${CLI.rewindClean} <file> [--dry-run] [--keep-memories] | ${CLI.purgeLog} [preview|restore] <2턴|120|120-135> [--here id] [--session id] [--confirm] | ${CLI.situationBoardUpdate} [--detach] | ${CLI.situationBoardShow} | ${CLI.idleJobs} | ${CLI.memoryConsolidation} [--detach] | ${CLI.workspaceLinks} [--dry-run] | ${CLI.workspaceAuxFolders} [--dry-run] | ${CLI.thisSecretaryMerge} [--dry-run] | ${CLI.skillLinks} [--dry-run] | ${CLI.sessionHandoffWake} <id> | ${CLI.archiveWorkspace} <id> <folder> | ${CLI.mainAgendaFromProfile} <plan.json> [--apply]>`;

/** The commands below that open the database (main's switch); any other word is a usage error, not a new database. */
const DB_COMMANDS = new Set<string>([CLI.memoryStats, CLI.userTitle, CLI.dbBackup, CLI.ingestTranscript, CLI.rewindClean, CLI.purgeLog, CLI.catchUpTranscripts, CLI.situationBoardUpdate, CLI.idleJobs, CLI.memoryConsolidation, CLI.sessionHandoffWake, CLI.situationBoardShow, CLI.archiveWorkspace, CLI.mainAgendaFromProfile]);

/**
 * A command that only looks at the database (or backs it up): with no database there is nothing to see, so it is not
 * made. memory-stats, situation-board-show, db-backup, user-title with no argument, rewind-clean --dry-run, and purge-log without --confirm (its preview, its list, restore's list).
 */
function viewOnly(cmd: string | undefined, args: string[]): boolean {
  if (cmd === CLI.memoryStats || cmd === CLI.situationBoardShow || cmd === CLI.dbBackup) return true;
  if (cmd === CLI.userTitle) return args.length === 0;
  if (cmd === CLI.rewindClean) return args.includes('--dry-run');
  if (cmd === CLI.purgeLog) return !args.includes('--confirm');
  return false;
}

const noDbLine = (what: string) => `비서 DB가 없어요(${DB_PATH}). 보기만 하는 명령이라 새로 만들지 않고, ${what}.`;

await main();

