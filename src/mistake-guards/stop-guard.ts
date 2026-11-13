/**
 * The Stop hook's part of the mistake guards (feature 'mistake-guards'): checks the answer the turn ends with
 * (answer-checks.ts), sends the turn back once with the reason when a blocking check finds something, and when the turn
 * really ends records its tool names and check results (turn_tools), keeps the warnings for the next prompt, and (once the
 * turn is logged, run-hook.ts) puts each catch into the mistakes record (recordGuardMistakes).
 *
 * Two ways of sending back: an English answer (or any other blocking check) is written again whole; when only closing or
 * path lines are missing (answer-check-table.ts `fill`) the answer already on the screen stays and only the missing lines are written
 * after it, and the retry checks, logs and notifies the first answer and the added lines together.
 *
 * Sent back only once per stop: with stop_hook_active (the model is already writing again because of this hook) it never
 * blocks again, so a check that keeps failing cannot loop. What still fails then is told on the next prompt instead.
 * Never sent back inside a subagent (agent_id): its findings are only told.
 */
import type { GuardHit, Store } from '../store/store.ts';
import { checkAnswer, type Finding } from './answer-checks.ts';
import { answerCheck } from './answer-check-table.ts';
import { LABELS_PREFIX, noteAnswerLabels } from './question-labels.ts';
import { readGuardSettings, type GuardSettings } from './mistake-guard-settings.ts';
import { readLastTurn, type Turn } from './last-turn.ts';
import { readSeen, type Seen } from './seen-sources.ts';
import { inventedWords } from './invented-words.ts';
import { takeToolHookHits } from './tool-hook-hits.ts';
import { TAG } from '../core/names.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';

export const WARN_PREFIX = 'guard_warn:';
export const TURN_PREFIX = 'guard_turn:';
/** The turns whose catches are already in the mistakes record (recordGuardMistakes). */
export const MISTAKE_MARK_PREFIX = 'guard_mistakes:';
/** Per-session marks the idle jobs drop for sessions quiet a week (idle/idle-jobs.ts). */
export const GUARD_SESSION_PREFIXES = [WARN_PREFIX, TURN_PREFIX, LABELS_PREFIX, MISTAKE_MARK_PREFIX];

export interface StopInput {
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  /** Set when the hook fires inside a subagent: nothing is sent back there. */
  agent_id?: string;
}

/**
 * The form rule a check stands for, said after its reason: .agents/hook-notices/answer-format.md under the check's name
 * (AGENTS.md keeps only the principle; the details are told when a check catches something). '' for a check with none
 * (answer-check-table.ts `format`).
 */
function formatRule(check: string): string {
  if (!answerCheck(check)?.format) return '';
  const rule = hookNoticeText('answer-format', check);
  return rule ? ` 형식: ${rule.replace(/\s*\n\s*/g, ' ')}` : '';
}

/** The head of a send-back that asks only for the missing lines (the tests know it by this). */
export const FILL_HEAD = '[답변 검사·Stop 훅] 앞 답은 이미 사용자 화면에 보이니 다시 쓰지 않는다. 아래에서 빠진 줄만 이어서 쓰고(남은 질문은 다음 행동 및 순서의 번호 단계 하나에만 모아) 답을 끝낸다. 앞 답과 이어 쓴 줄을 합쳐 다시 검사한다.';
const REWRITE_HEAD = '[답변 검사·Stop 훅] 답을 끝내기 전에 바로잡는다.';

/** The block issued in the turn still running (kept from the stop that sent it back to the next one). */
interface TurnState {
  turnUuid: string;
  blocks: string[];
  /** Their reasons, in the same order (for the mistakes record). */
  reasons?: string[];
  /** The last transcript line of the answer sent back. */
  afterUuid: string;
  /**
   * How it was sent back: 'rewrite' (the answer written again whole: only what comes after afterUuid is the answer) or
   * 'fill' (only the missing lines added: the answer is `answer` plus what comes after). Missing in a state written
   * before this field: 'rewrite'.
   */
  mode?: 'rewrite' | 'fill';
  /** With 'fill': the answer sent back, which stays on the screen. */
  answer?: string;
}

/** One check that caught the turn, as the mistakes record takes it. */
export interface GuardCatch {
  check: string;
  level: 'block' | 'warn';
  reason: string;
}

export interface StopVerdict {
  /** Send the turn back with this reason; undefined lets it end. */
  block?: string;
  findings: Finding[];
  /** The answer the turn ended with, when the checks read it (the end notice uses it: phone-push/ntfy.ts). */
  answer?: string;
  /** When the turn really ended: each check that caught it, once (blocked earlier in the turn, or warned now). */
  caught?: GuardCatch[];
  /** Transcript uuids of the turn's start and of its last answer line (their log rows are the evidence). */
  turnUuid?: string;
  answerUuid?: string;
  /**
   * The turn ended with lines added after an answer sent back for missing lines: `answer` is the two together, and the
   * log row of answerUuid is to hold them together too (run-hook.ts → ingestTranscript).
   */
  filled?: boolean;
}

/**
 * Decides on the turn that just stopped. With `block` set the caller writes {decision: block} and logs nothing yet (the
 * answer is about to be replaced; the next stop logs the turn whole).
 */
export function stopGuard(store: Store, input: StopInput, deps: { settings?: GuardSettings; turn?: Turn | null; seen?: Seen | null } = {}): StopVerdict {
  const settings = deps.settings ?? readGuardSettings();
  const sessionId = input.session_id;
  if (!settings.on || !sessionId) return { findings: [] };
  const turnKey = TURN_PREFIX + sessionId;
  // Going on after this hook sent the turn back: the same turn, and only what was written since counts as the answer.
  const prior = input.stop_hook_active ? store.getJson<TurnState>(turnKey) : undefined;
  const turn = deps.turn !== undefined ? deps.turn : input.transcript_path ? readLastTurn(input.transcript_path, prior?.afterUuid ?? '') : null;
  if (!turn) return { findings: [] };
  // Only the missing lines were added: the answer is the first one and those lines together.
  const filled = prior?.mode === 'fill' && !!prior.answer;
  const answer = filled ? [prior.answer, turn.answer].filter((t) => t?.trim()).join('\n\n') : turn.answer;
  // What this turn and the two before it opened (tool calls, the memory injection), for the basis and report checks.
  const seen = deps.seen !== undefined ? deps.seen : deps.turn === undefined && input.transcript_path ? readSeen(input.transcript_path) : null;
  const findings = turn.synthetic
    ? []
    : checkAnswer(answer, settings, { seen, inventedWords: inventedWords(store) }).filter((f) => (settings.levels[f.check] ?? 'off') !== 'off');
  const blocksSoFar = prior?.blocks ?? [];
  const turnUuid = prior?.turnUuid || turn.startUuid;

  const blocking = findings.filter((f) => settings.levels[f.check] === 'block');
  if (blocking.length && !input.stop_hook_active && !input.agent_id) {
    // Fixed by lines added after the answer (answer-check-table.ts `fill`) only when every blocking catch is.
    const fill = blocking.every((f) => answerCheck(f.check)?.fill && !f.rewrite);
    store.setJson(turnKey, {
      turnUuid,
      blocks: blocking.map((f) => f.check),
      reasons: blocking.map((f) => f.reason),
      afterUuid: turn.lastUuid,
      mode: fill ? 'fill' : 'rewrite',
      ...(fill ? { answer: turn.answer } : {}),
    } satisfies TurnState);
    const reason = fill
      ? [FILL_HEAD, ...blocking.map((f, i) => `${i + 1}. ${f.reason}${answerCheck(f.check)?.fill ?? ''}${formatRule(f.check)}`)].join('\n')
      : [REWRITE_HEAD, ...blocking.map((f, i) => `${i + 1}. ${f.reason}${formatRule(f.check)}`)].join('\n');
    return { block: reason, findings };
  }

  // The turn ends: record it, keep what is still wrong for the next prompt, note the labels it asked with.
  store.deleteMeta(turnKey);
  const guard: GuardHit[] = [...blocksSoFar.map((check) => ({ check, level: 'block' as const })), ...findings.map((f) => ({ check: f.check, level: 'warn' as const }))];
  // What the PreToolUse and PostToolUse hooks caught since the last turn ended (tool-hook-hits.ts) is kept with it.
  if (turnUuid) store.saveTurnTools({ sessionId, turnUuid, tools: turn.tools, guard: [...guard, ...takeToolHookHits(sessionId)] });
  if (findings.length) store.setJson(WARN_PREFIX + sessionId, findings.map((f) => f.reason + formatRule(f.check)));
  noteAnswerLabels(store, sessionId, turn.allText || answer);
  const caught = new Map<string, GuardCatch>();
  blocksSoFar.forEach((check, i) => caught.set(check, { check, level: 'block', reason: prior?.reasons?.[i] ?? '' }));
  for (const f of findings) if (!caught.has(f.check)) caught.set(f.check, { check: f.check, level: 'warn', reason: f.reason });
  return { findings, answer, caught: [...caught.values()], turnUuid, answerUuid: turn.lastUuid, ...(filled ? { filled } : {}) };
}

/**
 * After the turn is logged (run-hook.ts): each check that caught it goes into the mistakes record, found by '장치',
 * named, grouped and tied to its rule as answer-check-table.ts says (the group is the check id unless the row says), with the turn's log rows (its prompt and answer) as evidence. Once per turn and check: a hook
 * run again on the same turn adds nothing. Returns how many were added.
 */
export function recordGuardMistakes(store: Store, sessionId: string, v: StopVerdict): number {
  if (!v.caught?.length) return 0;
  const logIds = store.logInfoByUuids([v.turnUuid, v.answerUuid].filter((u): u is string => !!u)).map((r) => r.id);
  const turnMark = v.turnUuid || v.answerUuid || '';
  const key = MISTAKE_MARK_PREFIX + sessionId;
  const done = store.getJson<string[]>(key) ?? [];
  let added = 0;
  for (const c of v.caught) {
    const mark = `${turnMark}:${c.check}`;
    if (turnMark && done.includes(mark)) continue;
    // The reason's first sentence says what was wrong (the rest is how to fix it).
    const first = (c.reason.split(/(?<=[.다])\s/)[0] ?? '').trim();
    const row = answerCheck(c.check);
    store.recordMistake({
      sessionId,
      what: `${row?.name ?? c.check}(${c.level === 'block' ? '막음: 되돌려 고쳐 씀' : '알림: 다음 답에서 바로잡음'})${first ? `: ${first.slice(0, 200)}` : ''}`,
      madeBy: '비서',
      foundBy: '장치',
      group: row?.group ?? c.check,
      cause: '안 지킴',
      logIds,
      ruleRef: row?.rule ?? '',
      guard: `Stop 훅 답변 검사 ${c.check}(${c.level})`,
    });
    if (turnMark) done.push(mark);
    added++;
  }
  // The marks of the last turns are enough to stop a repeat.
  if (added) store.setJson(key, done.slice(-40));
  return added;
}

/** Adds reasons to the warnings told on the next prompt (with those the answer checks kept, if any). */
export function addGuardWarnings(store: Store, sessionId: string, reasons: string[]): void {
  if (!reasons.length) return;
  const key = WARN_PREFIX + sessionId;
  store.setJson(key, [...(store.getJson<string[]>(key) ?? []), ...reasons]);
}

/** Prompt hook: what the last answer still had wrong (told once). */
export function guardWarnNotice(store: Store, sessionId: string): string {
  const key = WARN_PREFIX + sessionId;
  const reasons = store.getJson<string[]>(key);
  if (!reasons?.length) return '';
  store.deleteMeta(key);
  return [
    `<${TAG.answerCheck}>`,
    '지난 답변 검사에서 걸린 것. 이번 답 맨 위에서 먼저 바로잡고(무엇이 틀렸고 바른 것이 무엇인지 한두 줄), 이번 답도 아래를 고친 형식으로 쓴다:',
    ...reasons.map((r) => `- ${r}`),
    `</${TAG.answerCheck}>`,
  ].join('\n');
}
