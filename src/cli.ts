/**
 * Command-line entry point.
 *
 *   node src/cli.ts hook session-start|prompt|stop   (called by Claude Code hooks; JSON on stdin)
 *   node src/cli.ts stats
 *   node src/cli.ts backup
 *   node src/cli.ts ingest <transcript.jsonl>
 *   node src/cli.ts embed-server [--parent <pid>]   (semantic-search helper; lives as long as <pid>, else idles out)
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { promptContext, sessionStartContext } from './context.ts';
import { openDb } from './db.ts';
import { ingestTranscript } from './ingest.ts';
import { runHelper } from './semantic.ts';
import { Store } from './store.ts';
import { formatLocal, nowIso } from './text.ts';
import { applyGuardOverride } from './usage.ts';

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
  const input = JSON.parse((await readStdin()) || '{}') as HookInput;
  const store = new Store(openDb());
  try {
    switch (name) {
      case 'session-start':
        // Catch up on anything a previous session's Stop hook missed (crash, kill).
        if (input.transcript_path && fs.existsSync(input.transcript_path)) ingestTranscript(store, input.transcript_path);
        emitContext('SessionStart', sessionStartContext(store, input.session_id, input.source));
        break;
      case 'prompt':
        if (input.prompt) {
          const parts = [applyGuardOverride(input.prompt), await promptContext(store, input.prompt, input.session_id)];
          emitContext('UserPromptSubmit', parts.filter(Boolean).join('\n'));
        }
        break;
      case 'stop':
        if (input.transcript_path && fs.existsSync(input.transcript_path)) ingestTranscript(store, input.transcript_path);
        if (input.session_id) store.linkTurnMemories(input.session_id);
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
  if (cmd === 'embed-server') {
    // Semantic-search helper: started by the secretary server (--parent), or on demand by the first recall.
    const parent = arg === '--parent' ? Number(process.argv[4]) || undefined : undefined;
    await runHelper(parent);
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
      case 'archive-workspace': {
        // The caller moves the folder first; this records where it went and hides it from list_workspaces.
        const [id, folder] = [Number(arg), process.argv[4]];
        if (!id || !folder || !fs.existsSync(folder)) throw new Error('usage: archive-workspace <id> <moved folder>');
        const w = store.archiveWorkspace(id, path.resolve(folder));
        console.log(`공간 #${w.id} ${w.title} 보관 → ${w.folder}`);
        break;
      }
      default:
        console.error('usage: node src/cli.ts <hook session-start|prompt|stop | stats | backup | ingest <file> | archive-workspace <id> <folder>>');
        process.exitCode = 1;
    }
  } finally {
    store.db.close();
  }
}

await main();
