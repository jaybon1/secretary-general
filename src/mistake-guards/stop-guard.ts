/**
 * The Stop hook's part of the mistake guards (feature 'mistake-guards'): checks the answer the turn ends with
 * (answer-checks.ts), sends the turn back once with the reason when a blocking check finds something, and when the turn
 * really ends records its tool names and check results (turn_tools), keeps the warnings for the next prompt, and (once the
 * turn is logged, run-hook.ts) puts each block into the mistakes record, and a warning only once the answer after its
 * notice sets it right (recordGuardMistakes).
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
import { splitFences } from './fences.ts';
import { answerCheck } from './answer-check-table.ts';
import { LABELS_PREFIX, noteAnswerLabels } from '../store/open-questions.ts';
import { readGuardSettings, type GuardSettings } from './mistake-guard-settings.ts';
import { readLastTurn, type Turn } from './last-turn.ts';
import { readSeen, type Seen } from './seen-sources.ts';
import { inventedWords } from './invented-words.ts';
import { userWords } from '../store/user-title.ts';
import { takeToolHookHits } from './tool-hook-hits.ts';
import { TAG } from '../core/names.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';

export const WARN_PREFIX = 'guard_warn:';
export const TURN_PREFIX = 'guard_turn:';
/** The turns whose catches are already in the mistakes record (recordGuardMistakes). */
export const MISTAKE_MARK_PREFIX = 'guard_mistakes:';
/** The warnings of the last turn that wait for the next answer to say whether they were real (PendingWarns). */
export const PENDING_WARN_PREFIX = 'guard_pending:';
/** Per-session marks the idle jobs drop for sessions quiet a week (idle/idle-jobs.ts). */
export const GUARD_SESSION_PREFIXES = [WARN_PREFIX, TURN_PREFIX, LABELS_PREFIX, MISTAKE_MARK_PREFIX, PENDING_WARN_PREFIX];

/**
 * A warn-level catch kept until the answer after the one its notice reached (the user's call 2026-11-18): it goes into the
 * mistakes record only when that answer sets it right with a "> 바로잡음(<분류>): …" line (correctedWarns). A catch the
 * secretary checked and found right is no mistake; the turn record (turn_tools) keeps every catch either way.
 */
interface PendingWarn {
  check: string;
  reason: string;
  /** The log rows of the turn it caught (its prompt and answer). */
  logIds: number[];
}

interface PendingWarns {
  /** The prompt hook told them (guardWarnNotice): the next answer that ends a turn decides. */
  told: boolean;
  warns: PendingWarn[];
}

/** What a warn is called in its notice and in the "바로잡음(…)" line: its mistakes-record group, else its name. */
export const warnLabel = (check: string): string => answerCheck(check)?.group ?? answerCheck(check)?.name ?? check;

/** "> 바로잡음(분류): …" (quoted or not, in bold or not): a warning the answer sets right. Group 1: what is in the brackets. */
const CORRECTION_LINE = /^\s*(?:>\s*)?(?:[-*]\s*)?\**\s*바로잡음\s*(?:\(([^)\n]*)\))?\s*\**\s*[:：]/;

/**
 * The warns an answer sets right: each "바로잡음(…)" line (outside code) takes the warns whose label or check id its
 * brackets name; one naming none of them, or naming nothing, takes them all when they share one label.
 */
export function correctedWarns(answer: string, warns: readonly PendingWarn[]): PendingWarn[] {
  const named = new Set<PendingWarn>();
  const labels = new Set(warns.map((w) => warnLabel(w.check)));
  for (const l of splitFences(answer).prose) {
    const m = CORRECTION_LINE.exec(l);
    if (!m) continue;
    const said = (m[1] ?? '').trim();
    const hits = said ? warns.filter((w) => said.includes(warnLabel(w.check)) || said.includes(w.check) || warnLabel(w.check).includes(said)) : [];
    for (const w of hits.length ? hits : labels.size === 1 ? warns : []) named.add(w);
  }
  return warns.filter((w) => named.has(w));
}

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
  /** What started the turn (the end notice passes over a routine progress turn a background notification started). */
  startText?: string;
  /**
   * The turn ended with lines added after an answer sent back for missing lines: `answer` is the two together, and the
   * log row of answerUuid is to hold them together too (run-hook.ts → ingestTranscript).
   */
  filled?: boolean;
  /** The last turn's warnings this answer set right ("> 바로잡음(…): …"): they go into the mistakes record now. */
  corrected?: PendingWarn[];
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
  // What this conversation opened since its last compaction (tool calls, the hooks' injections), for the basis and report checks.
  const seen = deps.seen !== undefined ? deps.seen : deps.turn === undefined && input.transcript_path ? readSeen(input.transcript_path) : null;
  // A memory injected earlier in this session (since its last /clear or compaction) is still in the conversation: as seen as one opened this turn.
  const injected = seen ? [...store.injectedIds(sessionId)] : [];
  if (seen && injected.length) seen.results.push({ tool: 'injected-session', text: injected.map((id) => `#${id}`).join(' ') });
  const findings = turn.synthetic
    ? []
    : checkAnswer(answer, settings, { seen, inventedWords: inventedWords(store), userWords: userWords(store.db) }).filter((f) => (settings.levels[f.check] ?? 'off') !== 'off');
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
  // Each warning carries its label: the next answer names it in its "바로잡음(…)" line.
  if (findings.length) store.setJson(WARN_PREFIX + sessionId, findings.map((f) => `[${warnLabel(f.check)}] ${f.reason}${formatRule(f.check)}`));
  noteAnswerLabels(store, sessionId, turn.allText || answer);
  // The warnings told before this answer: those it sets right are mistakes; the rest were found right (or let be) and are dropped.
  let corrected: PendingWarn[] = [];
  const pendingKey = PENDING_WARN_PREFIX + sessionId;
  const pending = turn.synthetic || input.agent_id ? undefined : store.getJson<PendingWarns>(pendingKey);
  if (pending?.told) {
    corrected = correctedWarns(answer, pending.warns);
    store.deleteMeta(pendingKey);
  }
  const caught = new Map<string, GuardCatch>();
  blocksSoFar.forEach((check, i) => caught.set(check, { check, level: 'block', reason: prior?.reasons?.[i] ?? '' }));
  for (const f of findings) if (!caught.has(f.check)) caught.set(f.check, { check: f.check, level: 'warn', reason: f.reason });
  return { findings, answer, caught: [...caught.values()], turnUuid, answerUuid: turn.lastUuid, startText: turn.startText, ...(filled ? { filled } : {}), ...(corrected.length ? { corrected } : {}) };
}

/**
 * /clear starts a new session: what the last session's checks still had to tell (and the warnings waiting for its next
 * answer) go to the new one, so the warning about the last answer before /clear is not lost. Called by the session-start
 * hook on a /clear. Returns how many warnings moved.
 */
export function carryGuardWarnings(store: Store, toSession: string): number {
  const prev = store.lastOtherSession(toSession)?.session_id;
  if (!prev) return 0;
  const reasons = store.getJson<string[]>(WARN_PREFIX + prev) ?? [];
  if (!reasons.length) return 0;
  store.deleteMeta(WARN_PREFIX + prev);
  addGuardWarnings(store, toSession, reasons.map((r) => `(/clear 전 마지막 답) ${r}`));
  const pending = store.getJson<PendingWarns>(PENDING_WARN_PREFIX + prev);
  if (pending) {
    store.deleteMeta(PENDING_WARN_PREFIX + prev);
    store.setJson(PENDING_WARN_PREFIX + toSession, pending);
  }
  return reasons.length;
}

/** One catch as the mistakes record takes it. */
function recordOne(store: Store, sessionId: string, c: { check: string; level: 'block' | 'warn'; reason: string }, logIds: number[]): void {
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
}

/**
 * After the turn is logged (run-hook.ts), what goes into the mistakes record, found by '장치', named, grouped and tied to
 * its rule as answer-check-table.ts says (the group is the check id unless the row says):
 * - each check that sent this turn back (block), with the turn's log rows (its prompt and answer) as evidence;
 * - each warning of the last turn this answer set right (v.corrected), with that turn's rows and this answer's.
 * This turn's warnings wait (PendingWarns) until the answer after their notice says whether they were real (the user's call
 * 2026-11-18: a warning the secretary checked and found right is no mistake). Once per turn and check: a hook run again on
 * the same turn adds nothing. Returns how many were added.
 */
export function recordGuardMistakes(store: Store, sessionId: string, v: StopVerdict): number {
  if (!v.caught?.length && !v.corrected?.length) return 0;
  const logIds = store.logInfoByUuids([v.turnUuid, v.answerUuid].filter((u): u is string => !!u)).map((r) => r.id);
  const turnMark = v.turnUuid || v.answerUuid || '';
  const key = MISTAKE_MARK_PREFIX + sessionId;
  const done = store.getJson<string[]>(key) ?? [];
  let added = 0;
  const once = (mark: string, record: () => void) => {
    if (turnMark && done.includes(mark)) return;
    record();
    if (turnMark) done.push(mark);
    added++;
  };
  for (const c of v.caught ?? []) if (c.level === 'block') once(`${turnMark}:${c.check}`, () => recordOne(store, sessionId, c, logIds));
  for (const w of v.corrected ?? []) once(`${turnMark}:fixed:${w.check}`, () => recordOne(store, sessionId, { ...w, level: 'warn' }, [...new Set([...w.logIds, ...logIds])]));
  const warns = (v.caught ?? []).filter((c) => c.level === 'warn');
  if (warns.length && !(turnMark && done.includes(`${turnMark}:pending`))) {
    store.setJson(PENDING_WARN_PREFIX + sessionId, { told: false, warns: warns.map((c) => ({ check: c.check, reason: c.reason, logIds })) } satisfies PendingWarns);
    if (turnMark) done.push(`${turnMark}:pending`);
  }
  // The marks of the last turns are enough to stop a repeat.
  store.setJson(key, done.slice(-40));
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
  // The answer to this prompt decides whether the waiting warnings were real (stopGuard).
  const pendingKey = PENDING_WARN_PREFIX + sessionId;
  const pending = store.getJson<PendingWarns>(pendingKey);
  if (pending && !pending.told) store.setJson(pendingKey, { ...pending, told: true } satisfies PendingWarns);
  return [
    `<${TAG.answerCheck}>`,
    '지난 답변 검사에서 걸린 것. 걸린 자리를 다시 확인해 실제로 틀렸을 때만 이번 답 맨 위에서 바로잡고(걸린 것마다 `> 바로잡음(<[ ] 안의 분류>): 무엇이 틀렸고 바른 것이 무엇인지` 한 줄. 이 줄로 바로잡은 것만 실수 기록에 남는다), 다시 확인해 맞았으면 따로 말하지 않는다. 이번 답도 아래를 고친 형식으로 쓴다:',
    ...reasons.map((r) => `- ${r}`),
    `</${TAG.answerCheck}>`,
  ].join('\n');
}
