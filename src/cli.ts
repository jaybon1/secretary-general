/**
 * Command-line entry point.
 *
 *   node src/cli.ts hook session-start|prompt|stop   (called by Claude Code hooks; JSON on stdin)
 *   node src/cli.ts board-update | board   (rewrite the situation board / print it)
 *   node src/cli.ts secretary-idle-jobs [--consolidate-now]   (idle jobs: board rewrite and memory consolidation when talk has paused; Task Scheduler runs it every 5 min)
 *   node src/cli.ts handoff-wake <old session id>   (new session after a handoff: log the old one, rewrite and print the board)
 *   node src/cli.ts setup-check [--skip <id,…> | --unskip <id,…|all>]   (install check; what the session-start notice is built from)
 *   node src/cli.ts workspace-links [--dry-run]   (write each workspace's secretary.json, where its tools find this secretary; --dry-run only lists)
 *   node src/cli.ts skill-links [--dry-run]   (skills in .agents/skills, .claude/skills a link to it, common skills from common-skills.json; moves the old skills/ layout; --dry-run only lists)
 *   node src/cli.ts stats
 *   node src/cli.ts backup
 *   node src/cli.ts ingest <transcript.jsonl>
 *   node src/cli.ts rewind-clean <transcript.jsonl> [--dry-run] [--keep-memories]   (drop branches a rewind abandoned, the way purge-log deletes; rows kept in backups/error/)
 *   node src/cli.ts purge-log preview <2턴 | 120 | 120-135> [--here <session id> | --session <id>]   ("비서 대화 삭제" preview: rows, first letters of their words, approval code)
 *   node src/cli.ts purge-log <2턴 | 120 | 120-135> [--session <id>] [--confirm]   (delete conversation rows; lists unless --confirm; rows kept in backups/error/)
 *   node src/cli.ts purge-log restore <120 | 120-135> [--confirm]   (put deleted rows back from that file)
 *   node src/cli.ts context-tokens <transcript.jsonl>   (last model call's context size from the last 4 MB; nothing printed if none)
 *   node src/cli.ts big-work-from-profile <plan.json> [--apply]   (once, updating from v7: profile's 큰 일 칸 → big-work board; first run writes the plan to check, --apply puts it in)
 *   node src/cli.ts embed-server [--parent <pid>] [--refetch]   (semantic-search helper; lives as long as <pid>, else idles out; --refetch downloads the model first)
 *   node src/cli.ts usage-poll [--parent <pid>]   (usage reader, feature usage-poll: the checked providers every 5 minutes; one per PC; ends with <pid>, or at once when the feature is off)
 *   node src/cli.ts handoff-account [--root <secretary folder>]   (the provider "auto" means now: the subscription with the most room, feature account-handoff; Use-Provider in providers.ps1 runs it)
 */
import fs from 'node:fs';
import path from 'node:path';
import { handoffWake } from './board/handoff.ts';
import { applyPlan, planFromProfile, planProblems, type MovePlan } from './upgrade/big-work-move.ts';
import { readBoard, runBoardUpdate } from './board/situation-board.ts';
import { catchUpTranscripts } from './log/catch-up.ts';
import { runHook } from './hooks/run-hook.ts';
import { DB_PATH, PROJECT_ROOT } from './core/config.ts';
import { commonSkillsDirOf, LINK_FILE, linkedFolders, linkFor, linkProblem, writeLink } from './workspace/secretary-link.ts';
import { commonSkillProblem, fixCommonSkills } from './workspace/common-skills.ts';
import { lastContextTokens } from './hooks/context-size-nudge.ts';
import { backupDb, openDb } from './store/schema.ts';
import { offFeatureChecks } from './setup/features.ts';
import { ingestTranscript } from './log/ingest-transcript.ts';
import { executePurge, formatPlan, formatResult, parseSpec, planPurge, restorePurged, rowLine } from './log/purge.ts';
import { runPreview } from './log/purge-initials.ts';
import { cleanRewound } from './log/rewind.ts';
import { runHelper } from './semantic/client.ts';
import { checkSetup, formatReport, saveReport, setSkip, setupOptions } from './setup/install-check.ts';
import { fixSkillLinks, formatSkillLinkFix } from './setup/skill-links.ts';
import { Store } from './store/store.ts';
import { formatLocal, nowIso } from './core/kst-time.ts';
import { runConsolidate, runIdleJobs } from './idle/idle-jobs.ts';
import { runUsagePoll } from './usage/usage-poller.ts';
import { handoffAccount } from './usage/handoff-level.ts';

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'hook') {
    try {
      await runHook(arg);
    } catch (err) {
      // A memory hiccup must never block the conversation: report and exit 0.
      process.stderr.write(`[secretary] ${arg} hook failed: ${(err as Error).stack ?? err}\n`);
    }
    return;
  }
  if (cmd === 'setup-check') {
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
  if (cmd === 'skill-links') {
    // This folder's skills (install check item 'skills'): .agents/skills, the .claude/skills link, the common skills; no database needed.
    const dry = process.argv.includes('--dry-run');
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
  if (cmd === 'context-tokens') {
    // For the work-session scripts (worker-lib.ps1); no database needed.
    if (!arg) throw new Error('usage: context-tokens <transcript.jsonl>');
    const tokens = lastContextTokens(arg, 4 * 1024 * 1024);
    if (tokens) console.log(tokens);
    return;
  }
  if (cmd === 'embed-server') {
    // Semantic-search helper: started by the secretary server (--parent), or on demand by the first recall.
    const parent = arg === '--parent' ? Number(process.argv[4]) || undefined : undefined;
    await runHelper(parent, process.argv.includes('--refetch'));
    return;
  }
  if (cmd === 'usage-poll') {
    // The usage reader (feature usage-poll): started by the secretary server (--parent); no database needed.
    const parent = arg === '--parent' ? Number(process.argv[4]) || undefined : undefined;
    if (arg !== undefined && !parent) throw new Error('usage: usage-poll [--parent <pid>]');
    runUsagePoll(parent);
    return;
  }
  if (cmd === 'handoff-account') {
    // What providers.json's default "auto" (or -Provider auto) runs on now; no database needed. --root: the secretary folder
    // whose providers.json to read (Use-Provider passes its own, the same as this one outside the tests).
    const i = process.argv.indexOf('--root');
    const root = i >= 0 ? process.argv[i + 1] : undefined;
    if (i >= 0 && !root) throw new Error('usage: handoff-account [--root <secretary folder>]');
    console.log(handoffAccount(Date.now(), undefined, { account: root ? { root } : undefined }));
    return;
  }

  const store = new Store(openDb());
  try {
    switch (cmd) {
      case 'stats':
        console.log(JSON.stringify(store.stats(), null, 2));
        break;
      case 'backup':
        console.log(backupDb(store.db, path.join(PROJECT_ROOT, 'backups')));
        break;
      case 'ingest':
        if (!arg) throw new Error('usage: ingest <transcript.jsonl>');
        console.log(ingestTranscript(store, arg));
        break;
      case 'rewind-clean': {
        // By hand: what a rewind left behind in one transcript (the hooks do the same on their own).
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
      case 'purge-log': {
        // By hand, what the "비서 대화 삭제" phrase does: lists unless --confirm. No row text is printed.
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
      case 'catch-up':
        // server-control.ps1 restart: log every secretary transcript right after the server stops,
        // so the turn that asked for the restart (cut off before its Stop hook) is not lost.
        console.log(JSON.stringify({ added: catchUpTranscripts(store, undefined, 0) }));
        break;
      case 'board-update': {
        // Started detached by the first prompt of a new session; also runnable by hand to test the rewrite.
        const job = await runBoardUpdate(store);
        console.log(JSON.stringify(job));
        break;
      }
      case 'secretary-idle-jobs': {
        // Every 5 minutes from Task Scheduler ('Secretary Idle Jobs (<install id>)'). --consolidate-now runs a consolidation by hand.
        const did = arg === '--consolidate-now' ? [(await runConsolidate(store)).ok ? 'consolidate' : 'consolidate-failed'] : await runIdleJobs(store);
        console.log(`${formatLocal(nowIso())} ${did.join(', ')}`);
        break;
      }
      case 'handoff-wake':
        if (!arg) throw new Error('usage: handoff-wake <old session id>');
        console.log(await handoffWake(store, arg));
        break;
      case 'board':
        console.log(readBoard(store)?.text || '(상황판 없음)');
        break;
      case 'workspace-links': {
        // Each workspace's secretary.json (and its .gitignore line): what its tools read to find this secretary.
        const dry = process.argv.includes('--dry-run');
        const folders = linkedFolders(DB_PATH, PROJECT_ROOT);
        let fixed = 0;
        for (const f of folders) {
          const problem = linkProblem(f, PROJECT_ROOT);
          if (!problem) continue;
          if (!dry) writeLink(f, PROJECT_ROOT);
          fixed++;
          console.log(`${dry ? '고칠 것' : '고침'}: ${f} (${problem})`);
        }
        const { bin, id } = linkFor(PROJECT_ROOT);
        console.log(`공간 ${folders.length}개 중 ${dry ? '고칠 것' : '고친 것'} ${fixed}개 (${LINK_FILE}: ${JSON.stringify({ bin, id })})`);
        break;
      }
      case 'archive-workspace': {
        // The caller moves the folder first; this records where it went and hides it from list_workspaces.
        const [id, folder] = [Number(arg), process.argv[4]];
        if (!id || !folder || !fs.existsSync(folder)) throw new Error('usage: archive-workspace <id> <moved folder>');
        const w = store.archiveWorkspace(id, path.resolve(folder));
        console.log(`공간 #${w.id} ${w.title} 보관 → ${w.folder}`);
        break;
      }
      case 'big-work-from-profile': {
        if (!arg) throw new Error('usage: big-work-from-profile <plan.json> [--apply]');
        if (process.argv.includes('--apply')) {
          const plan = JSON.parse(fs.readFileSync(arg, 'utf8')) as MovePlan;
          const r = applyPlan(store, plan);
          console.log(`큰 일 판 ${r.board}줄 넣음, 프로필 v${r.profileVersion} 저장(큰 일 칸 뺌)`);
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
            `프로필 v${profile.version}의 큰 일 칸 ${plan.section.length}줄 → 판 ${plan.rows.length}줄 (계획: ${arg})`,
            ...plan.rows.map((r) => `- ${r.name} — ${r.state}${r.note ? ` (${r.note})` : ''}`),
            problems.length ? `고칠 것:\n- ${problems.join('\n- ')}` : '고칠 것 없음. 줄마다 상태가 맞는지 보고 --apply로 넣는다.',
          ].join('\n'),
        );
        break;
      }
      default:
        console.error('usage: node src/cli.ts <hook session-start|prompt|stop | setup-check [--skip ids|--unskip ids] | stats | backup | ingest <file> | rewind-clean <file> [--dry-run] [--keep-memories] | purge-log [preview|restore] <2턴|120|120-135> [--here id] [--session id] [--confirm] | board-update | board | secretary-idle-jobs [--consolidate-now] | workspace-links [--dry-run] | skill-links [--dry-run] | handoff-wake <id> | archive-workspace <id> <folder> | big-work-from-profile <plan.json> [--apply]>');
        process.exitCode = 1;
    }
  } finally {
    store.db.close();
  }
}

await main();
