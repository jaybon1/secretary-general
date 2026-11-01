/**
 * Command-line entry point.
 *
 *   node src/cli.ts hook session-start|prompt|stop   (called by Claude Code hooks; JSON on stdin)
 *   node src/cli.ts board-update | board   (rewrite the situation board / print it)
 *   node src/cli.ts handoff-wake <old session id>   (new session after a handoff: log the old one, rewrite and print the board)
 *   node src/cli.ts setup-check [--skip <id,…> | --unskip <id,…|all>]   (install check; what the session-start notice is built from)
 *   node src/cli.ts stats
 *   node src/cli.ts backup
 *   node src/cli.ts ingest <transcript.jsonl>
 *   node src/cli.ts embed-server [--parent <pid>] [--refetch]   (semantic-search helper; lives as long as <pid>, else idles out; --refetch downloads the model first)
 */
import fs from 'node:fs';
import path from 'node:path';
import { boardContext, catchUpTranscripts, handoffWake, readBoard, runBoardUpdate } from './board.ts';
import { DB_PATH, PROJECT_ROOT } from './config.ts';
import { promptContext, sessionStartContext } from './context.ts';
import { updateOpenQuestions } from './continuity.ts';
import { openDb } from './db.ts';
import { ingestTranscript } from './ingest.ts';
import { runHelper } from './semantic.ts';
import { checkSetup, formatReport, saveReport, sessionSetup, setSkip, setupOptions, setupReminder } from './setup.ts';
import { Store } from './store.ts';
import { estimateTokens, formatLocal, nowIso } from './text.ts';
import { applyGuardOverride } from './usage.ts';
import { contextNudge, lastContextTokens } from './context-size.ts';

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  prompt?: string;
  hook_event_name?: string;
  /** SessionStart: startup | resume | clear | compact */
  source?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function emitContext(event: string, text: string): void {
  if (!text) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

async function runHook(name: string): Promise<void> {
  // Started first so its PowerShell query (~1.3 s) overlaps the catch-up below. Never rejects.
  // Whether the database was there is read before openDb, which creates a missing one.
  const setup = name === 'session-start' ? sessionSetup({ dbExisted: fs.existsSync(DB_PATH) }) : null;
  const input = JSON.parse((await readStdin()) || '{}') as HookInput;
  const store = new Store(openDb());
  try {
    switch (name) {
      case 'session-start': {
        // Catch up on anything a previous session's Stop hook missed (crash, kill).
        if (input.transcript_path && fs.existsSync(input.transcript_path)) ingestTranscript(store, input.transcript_path);
        catchUpTranscripts(store, input.transcript_path);
        const context = sessionStartContext(store, input.session_id, input.source);
        const { notice, report } = await setup!;
        if (report) {
          store.logUsage('setup_check', estimateTokens(notice), {
            ms: report.ms,
            missing: report.results.filter((r) => r.status === 'missing').map((r) => r.id),
            unknown: report.results.filter((r) => r.status === 'unknown').map((r) => r.id),
          });
        }
        emitContext('SessionStart', [context, notice].filter(Boolean).join('\n'));
        break;
      }
      case 'prompt':
        if (input.prompt) {
          const board = input.session_id ? await boardContext(store, input.session_id, undefined, input.prompt, { transcriptPath: input.transcript_path }) : '';
          const tokens = input.transcript_path && fs.existsSync(input.transcript_path) ? lastContextTokens(input.transcript_path) : 0;
          const nudge = input.session_id ? contextNudge(store, input.session_id, tokens) : '';
          const parts = [applyGuardOverride(input.prompt), setupReminder(), nudge, board, await promptContext(store, input.prompt, input.session_id, input.transcript_path)];
          emitContext('UserPromptSubmit', parts.filter(Boolean).join('\n'));
        }
        break;
      case 'stop':
        if (input.transcript_path && fs.existsSync(input.transcript_path)) ingestTranscript(store, input.transcript_path);
        if (input.session_id) {
          store.linkTurnMemories(input.session_id);
          updateOpenQuestions(store, input.session_id);
        }
        break;
      default:
        throw new Error(`unknown hook: ${name}`);
    }
  } finally {
    store.db.close();
  }
}

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
    console.log(formatReport(cache, cache.skip));
    return;
  }
  if (cmd === 'embed-server') {
    // Semantic-search helper: started by the secretary server (--parent), or on demand by the first recall.
    const parent = arg === '--parent' ? Number(process.argv[4]) || undefined : undefined;
    await runHelper(parent, process.argv.includes('--refetch'));
    return;
  }

  const store = new Store(openDb());
  try {
    switch (cmd) {
      case 'stats':
        console.log(JSON.stringify(store.stats(), null, 2));
        break;
      case 'backup': {
        const dir = path.join(PROJECT_ROOT, 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = formatLocal(nowIso()).replace(/[-:]/g, '').replace(' ', '-');
        const file = path.join(dir, `secretary-${stamp}.db`);
        store.db.prepare('VACUUM INTO ?').run(file);
        console.log(file);
        break;
      }
      case 'ingest':
        if (!arg) throw new Error('usage: ingest <transcript.jsonl>');
        console.log(ingestTranscript(store, arg));
        break;
      case 'board-update': {
        // Started detached by the first prompt of a new session; also runnable by hand to test the rewrite.
        const job = await runBoardUpdate(store);
        console.log(JSON.stringify(job));
        break;
      }
      case 'handoff-wake':
        if (!arg) throw new Error('usage: handoff-wake <old session id>');
        console.log(await handoffWake(store, arg));
        break;
      case 'board':
        console.log(readBoard(store)?.text ?? '(상황판 없음)');
        break;
      case 'archive-workspace': {
        // The caller moves the folder first; this records where it went and hides it from list_workspaces.
        const [id, folder] = [Number(arg), process.argv[4]];
        if (!id || !folder || !fs.existsSync(folder)) throw new Error('usage: archive-workspace <id> <moved folder>');
        const w = store.archiveWorkspace(id, path.resolve(folder));
        console.log(`공간 #${w.id} ${w.title} 보관 → ${w.folder}`);
        break;
      }
      default:
        console.error('usage: node src/cli.ts <hook session-start|prompt|stop | setup-check [--skip ids|--unskip ids] | stats | backup | ingest <file> | board-update | board | handoff-wake <id> | archive-workspace <id> <folder>>');
        process.exitCode = 1;
    }
  } finally {
    store.db.close();
  }
}

await main();
