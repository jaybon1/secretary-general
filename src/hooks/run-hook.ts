/**
 * The three Claude Code hooks (`node src/cli.ts hook session-start|prompt|stop`, JSON on stdin):
 *   - session-start: log what a previous session's Stop hook missed, bring this secretary's old records into its own
 *     folder once (core/state-dir.ts), inject the profile and status (session-start.ts) and the install check's notice
 *     (setup/install-check.ts).
 *   - prompt: "비서 대화 삭제" and its approval code (log/purge.ts) first; otherwise every notice (prompt-notices.ts).
 *   - stop: check the answer (guards/stop-guard.ts: sent back once with the reason, to be written again whole or, when only
 *     lines are missing, to have them added after it; or let end), then log the turn (an answer with added lines as one row), link
 *     the memories it saved, read the open questions from the answer, record what the checks caught (mistakes), send the answer's first line to the phone
 *     (notify/ntfy.ts, only when the turn really ends).
 */
import fs from 'node:fs';
import { updateOpenQuestions } from '../board/open-questions.ts';
import { DB_PATH } from '../core/config.ts';
import { ensureStateDir } from '../core/state-dir.ts';
import { estimateTokens } from '../core/tokens.ts';
import { recordGuardMistakes, stopGuard, type StopVerdict } from '../guards/stop-guard.ts';
import { catchUpTranscripts } from '../log/catch-up.ts';
import { ingestTranscript } from '../log/ingest-transcript.ts';
import { purgeHook } from '../log/purge.ts';
import { notifyAfterStop } from '../notify/ntfy.ts';
import { sessionSetup } from '../setup/install-check.ts';
import { openDb } from '../store/schema.ts';
import { Store } from '../store/store.ts';
import { promptNotices } from './prompt-notices.ts';
import { sessionStartContext } from './session-start.ts';

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  prompt?: string;
  hook_event_name?: string;
  /** SessionStart: startup | resume | clear | compact */
  source?: string;
  /** Stop: the model is already going on because a Stop hook sent the turn back. */
  stop_hook_active?: boolean;
  /** Set when the hook fires inside a subagent. */
  agent_id?: string;
}

/** The answer checks (guards/stop-guard.ts); a failure in them never keeps the turn from being logged. */
function guardedStop(store: Store, input: HookInput): StopVerdict {
  try {
    return stopGuard(store, input);
  } catch (err) {
    process.stderr.write(`[secretary] answer check failed: ${(err as Error).message}\n`);
    return { findings: [] };
  }
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

export async function runHook(name: string): Promise<void> {
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
        // The first session after the records moved to ~/.secretary/state/<id>: this secretary's share of the old ones comes along.
        ensureStateDir();
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
      case 'prompt': {
        if (!input.prompt) break;
        // "비서 대화 삭제 …" and its approval code: the phrase goes to the secretary with only the order to run the
        // preview; the code deletes here without the model, then goes on with only the result to pass on. Neither
        // gets the notices below.
        const purge = purgeHook(store, input.prompt, input.session_id, input.transcript_path);
        if (purge) {
          emitContext('UserPromptSubmit', purge.context);
          break;
        }
        emitContext('UserPromptSubmit', await promptNotices({ store, prompt: input.prompt, sessionId: input.session_id, transcriptPath: input.transcript_path }));
        break;
      }
      case 'stop': {
        // The answer checks first: a turn sent back is logged when it really ends (its answer is about to be replaced).
        const verdict = guardedStop(store, input);
        if (verdict.block) {
          process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.block }));
          break;
        }
        // The answer's first line to the phone (feature 'notify'), first: a detached sender posts it, nothing waits here.
        notifyAfterStop(input, verdict);
        // Lines added after an answer sent back for missing lines: the answer's row holds both (the open questions and the
        // mistakes record read it).
        const whole = verdict.filled && verdict.answer && verdict.answerUuid ? { uuid: verdict.answerUuid, content: verdict.answer } : undefined;
        if (input.transcript_path && fs.existsSync(input.transcript_path)) ingestTranscript(store, input.transcript_path, whole);
        if (input.session_id) {
          store.linkTurnMemories(input.session_id);
          updateOpenQuestions(store, input.session_id);
          // What the checks caught goes into the mistakes record now that the turn's rows are logged (their ids are the evidence).
          try {
            recordGuardMistakes(store, input.session_id, verdict);
          } catch (err) {
            process.stderr.write(`[secretary] mistakes record failed: ${(err as Error).message}\n`);
          }
        }
        break;
      }
      default:
        throw new Error(`unknown hook: ${name}`);
    }
  } finally {
    store.db.close();
  }
}
