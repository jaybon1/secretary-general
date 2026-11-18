/**
 * The three Claude Code hooks (`node src/cli.ts hook session-start|prompt|stop`, JSON on stdin):
 *   - session-start: log what a previous session's Stop hook missed, move this PC's renamed files once
 *     (core/local-settings.ts), inject the profile and status (session-start.ts) and the install check's notice
 *     (setup/setup-check.ts).
 *   - prompt: "비서 대화 삭제" and its approval code (log/purge.ts) first; otherwise every notice (prompt-notices.ts).
 *   - stop: check the answer (mistake-guards/stop-guard.ts: sent back once with the reason, to be written again whole or, when only
 *     lines are missing, to have them added after it; or let end), then log the turn (an answer with added lines as one row), link
 *     the memories it saved, read the open questions from the answer, note a memory-consolidation line the answer showed,
 *     start a calendar fetch after a turn that changed the calendar (todo-summary/calendar.ts), record what the checks caught
 *     (mistakes), send the answer's first line to the phone (phone-push/ntfy.ts, only when the turn really ends).
 */
import fs from 'node:fs';
import { updateOpenQuestions } from '../store/open-questions.ts';
import { DB_PATH, PROMPT_HOOK_TIMEOUT_S } from '../core/config.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { addGuardWarnings, recordGuardMistakes, stopGuard, type StopVerdict } from '../mistake-guards/stop-guard.ts';
import { checkPendingQuotes, missingQuoteWarning } from '../memory/source-quote.ts';
import { catchUpTranscripts } from '../log/catch-up.ts';
import { ingestTranscript } from '../log/ingest-transcript.ts';
import { readRememberedIds } from '../log/turn-memories.ts';
import { purgeHook } from '../log/purge.ts';
import { notifyAfterStop } from '../phone-push/ntfy.ts';
import { sessionSetup } from '../setup/setup-check.ts';
import { openDb } from '../store/schema.ts';
import { Store } from '../store/store.ts';
import { promptNotices } from './prompt-notices.ts';
import { allowServerStart } from '../semantic-search/client.ts';
import { sessionStartContext } from './session-start.ts';
import { consolidateLineShown } from '../memory/consolidate-notice.ts';
import { readLastTurn } from '../mistake-guards/last-turn.ts';
import { calendarSettings, spawnCalendarFetch, usedCalendarTools } from '../todo-summary/calendar.ts';
import { hookErrorNotice, noteHookError } from '../core/hook-errors.ts';

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

/** The answer checks (mistake-guards/stop-guard.ts); a failure in them never keeps the turn from being logged. */
function guardedStop(store: Store, input: HookInput): StopVerdict {
  try {
    return stopGuard(store, input);
  } catch (err) {
    process.stderr.write(`[secretary] answer check failed: ${(err as Error).message}\n`);
    noteHookError('stop', err, 'answer-check', { session: input.session_id });
    return { findings: [] };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Whether this run already wrote its context (a hook writes one JSON object, once). */
let emitted = false;
/** The session this run is for, once its input is read (a failure's record names it: core/hook-errors.ts). */
let hookSession: string | undefined;

export const currentHookSession = (): string | undefined => hookSession;

function contextJson(event: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

function emitContext(event: string, text: string): void {
  if (!text) return;
  process.stdout.write(contextJson(event, text));
  emitted = true;
}

/** The hook events whose context the secretary reads (the Stop hook has none). */
const CONTEXT_EVENTS: Record<string, { event: string; what: string }> = {
  'session-start': { event: 'SessionStart', what: '세션 시작 훅이 실패해 핵심 프로필·주요 현안·상태 안내가 붙지 않았어요' },
  prompt: { event: 'UserPromptSubmit', what: '질문 훅이 실패해 이번 질문에 기억 주입을 포함한 안내가 하나도 붙지 않았어요' },
};

/**
 * What src/cli.ts writes when the hook threw before it wrote anything: the session-start and prompt hooks still tell the
 * secretary, in one tag line, that their context is missing ('' when there is nothing to say or it was already written).
 * The Stop hook has no context: its failure is told on the session's next prompt (core/hook-errors.ts stopFailureNotice).
 */
export function hookFailureOutput(name: string): string {
  const c = CONTEXT_EVENTS[name];
  return c && !emitted ? contextJson(c.event, hookErrorNotice(c.what)) : '';
}

/** How long before that limit a prompt hook still running records that it is about to be cut (the app's cut leaves no trace). */
export const TIMEOUT_NOTE_LEAD_MS = 10_000;

/**
 * A timer that, if the prompt hook is still running shortly before Claude Code cuts it, records the coming timeout in
 * hook-errors.jsonl (core/hook-errors.ts): a cut hook writes nothing, so its missing notices would leave no trace. It never
 * keeps the process alive.
 */
export function noteTimeoutSoon(session: string | undefined, afterMs = PROMPT_HOOK_TIMEOUT_S * 1000 - TIMEOUT_NOTE_LEAD_MS): NodeJS.Timeout {
  const t = setTimeout(() => noteHookError('prompt', new Error(`질문 훅이 시간 제한(${PROMPT_HOOK_TIMEOUT_S}초) 직전까지 끝나지 않아 끊길 참이에요`), 'timeout', { session }), afterMs);
  t.unref();
  return t;
}

export async function runHook(name: string): Promise<void> {
  // Started first so its PowerShell query (~1.3 s) overlaps the catch-up below. Never rejects.
  // Whether the database was there is read before openDb, which creates a missing one.
  const setup = name === 'session-start' ? sessionSetup({ dbExisted: fs.existsSync(DB_PATH) }) : null;
  const input = JSON.parse((await readStdin()) || '{}') as HookInput;
  hookSession = input.session_id;
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
      case 'prompt': {
        if (!input.prompt) break;
        // Counted from the process start, as the app counts its limit.
        noteTimeoutSoon(input.session_id, Math.max(0, PROMPT_HOOK_TIMEOUT_S * 1000 - TIMEOUT_NOTE_LEAD_MS - process.uptime() * 1000));
        // "비서 대화 삭제 …" and its approval code: the phrase goes to the secretary with only the order to run the
        // preview; the code deletes here without the model, then goes on with only the result to pass on. Neither
        // gets the notices below.
        const purge = purgeHook(store, input.prompt, input.session_id, input.transcript_path);
        if (purge) {
          emitContext('UserPromptSubmit', purge.context);
          break;
        }
        // The secretary's prompt hook is one of the callers that start the semantic-search server again (client.ts).
        allowServerStart();
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
        // The answer's first line to the phone (feature 'phone-push'), first: a detached sender posts it, nothing waits here.
        notifyAfterStop(input, verdict);
        // Lines added after an answer sent back for missing lines: the answer's row holds both (the open questions and the
        // mistakes record read it).
        const whole = verdict.filled && verdict.answer && verdict.answerUuid ? { uuid: verdict.answerUuid, content: verdict.answer } : undefined;
        if (input.transcript_path && fs.existsSync(input.transcript_path)) ingestTranscript(store, input.transcript_path, whole);
        if (input.session_id) {
          // Only what this session's own remember calls saved (another session's, or the consolidation's, is not this turn's).
          if (input.transcript_path) store.linkTurnMemories(input.session_id, readRememberedIds(input.transcript_path));
          // Decisions saved this turn now have their row: their quotes of the user's words are looked up, and one found in
          // no user message is told on the next prompt (memory/source-quote.ts).
          try {
            const missing = checkPendingQuotes(store);
            if (missing.length) addGuardWarnings(store, input.session_id, [missingQuoteWarning(missing)]);
          } catch (err) {
            process.stderr.write(`[secretary] quote check failed: ${(err as Error).message}\n`);
            noteHookError('stop', err, 'quote-check', { session: input.session_id });
          }
          updateOpenQuestions(store, input.session_id);
          // The memory-consolidation line, once an answer carries it, stops being asked for (it goes only in an answer
          // whose closing list is "없음", so it is asked for until one does).
          const answer = verdict.answer ?? store.sessionTail(input.session_id, 1, 'assistant')[0]?.content ?? '';
          consolidateLineShown(store, input.session_id, answer);
          // A turn that changed the calendar: the to-do summary's events are fetched again, apart (feature todo-summary).
          try {
            const calendar = calendarSettings();
            if (calendar.keyFile) {
              // The turn's tools as the answer checks recorded them (turn_tools), else read from the transcript.
              const [turn] = verdict.turnUuid ? store.turnTools({ sessionId: input.session_id, limit: 1 }) : [];
              const tools = turn && turn.turn_uuid === verdict.turnUuid ? turn.tools : input.transcript_path && fs.existsSync(input.transcript_path) ? (readLastTurn(input.transcript_path, '')?.tools ?? []) : [];
              if (usedCalendarTools(tools)) spawnCalendarFetch(calendar);
            }
          } catch (err) {
            process.stderr.write(`[secretary] calendar fetch not started: ${(err as Error).message}\n`);
            noteHookError('stop', err, 'calendar', { session: input.session_id });
          }
          // What the checks caught goes into the mistakes record now that the turn's rows are logged (their ids are the evidence).
          try {
            recordGuardMistakes(store, input.session_id, verdict);
          } catch (err) {
            process.stderr.write(`[secretary] mistakes record failed: ${(err as Error).message}\n`);
            noteHookError('stop', err, 'mistakes-record', { session: input.session_id });
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
