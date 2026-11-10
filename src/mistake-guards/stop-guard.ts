/**
 * The Stop hook's part of the mistake guards (feature 'mistake-guards'): checks the answer the turn ends with
 * (answer-checks.ts), sends the turn back once with the reason when a blocking check finds something, and when the turn
 * really ends records its tool names and check results (turn_tools), keeps the warnings for the next prompt, and (once the
 * turn is logged, run-hook.ts) puts each catch into the mistakes record (recordGuardMistakes).
 *
 * Two ways of sending back: an English answer (or any other blocking check) is written again whole; when only closing or
 * path lines are missing (FILL_CHECKS) the answer already on the screen stays and only the missing lines are written
 * after it, and the retry checks, logs and notifies the first answer and the added lines together.
 *
 * Sent back only once per stop: with stop_hook_active (the model is already writing again because of this hook) it never
 * blocks again, so a check that keeps failing cannot loop. What still fails then is told on the next prompt instead.
 * Never sent back inside a subagent (agent_id): its findings are only told.
 */
import type { GuardHit, Store } from '../store/store.ts';
import { checkAnswer, type Finding } from './answer-checks.ts';
import { LABELS_PREFIX, noteAnswerLabels } from './question-labels.ts';
import { readGuardSettings, type GuardSettings } from './mistake-guard-settings.ts';
import { readLastTurn, type Turn } from './last-turn.ts';
import { TAG } from '../core/names.ts';

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
 * The checks whose catch is fixed by adding lines after the answer (the answer itself was fine and is already on the
 * screen). Any other blocking check (English first), or a catch marked `rewrite`, has the answer written again whole.
 * recommend-basis is fixed by writing the question's block again (its basis line has to sit right under the pick, which
 * lines added at the end cannot do); the check reads a label asked twice by its last block. path-block likewise: the
 * block that mixed the two PCs' paths stays on the screen, and its paths are written again each in a block of its own.
 */
export const FILL_CHECKS = ['path-pair', 'path-link', 'path-block', 'next-action', 'open-questions', 'recommend-basis'];

/** How each of FILL_CHECKS is fixed by lines added after the answer (said after the check's own reason). */
const FILL_HINTS: Record<string, string> = {
  'path-pair': ' 앞 답에 이미 있는 이 PC 경로 줄은 되풀이하지 않고, 빠진 다른 PC 경로 줄만 자기 코드 블록으로 이어 쓴다(경로 하나에 코드 블록 하나, 링크 줄도 빠졌으면 그 블록 바로 아래 블록 밖에 붙인다).',
  'path-link': ' 앞 답에 이미 있는 이 PC·다른 PC 경로 줄은 되풀이하지 않고, 빠진 링크 줄만 이어 쓴다(코드 블록 밖, 폰 주소를 코드 줄로 따로 쓰지 않는다).',
  'path-block': ' 화면에 이미 나간 블록은 고칠 수 없으니, 그 블록의 경로를 이 PC 경로 블록 하나, 다른 PC 경로 블록 하나로 따로 다시 적고, 폰 주소 링크 줄을 쓰는 경로면 그 아래 블록 밖에 링크 줄을 붙인다(다시 적은 블록으로 검사한다).',
  'recommend-basis': ' 근거 줄은 추천 선택지 바로 아래에 있어야 하므로, 이것은 예외로 그 질문 블록(질문 줄과 선택지 전체)을 같은 질문 기호로 다시 적고 추천 선택지 줄 바로 아래에 근거 줄을 넣는다(다시 적은 블록으로 검사한다).',
};

/** The head of a send-back that asks only for the missing lines (the eval run and the tests know it by this). */
export const FILL_HEAD = '[답 검사] 앞 답은 이미 사용자 화면에 보이니 다시 쓰지 않는다. 아래에서 빠진 줄만 이어서 쓰고(앞 답의 문장을 되풀이하지 않는다, 남은 질문 줄이 있으면 다음 행동 줄 위에) 답을 끝낸다. 앞 답과 이어 쓴 줄을 합쳐 다시 검사한다.';
const REWRITE_HEAD = '[답 검사] 답을 끝내기 전에 바로잡는다.';

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
export function stopGuard(store: Store, input: StopInput, deps: { settings?: GuardSettings; turn?: Turn | null } = {}): StopVerdict {
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
  const findings = turn.synthetic ? [] : checkAnswer(answer, settings).filter((f) => (settings.levels[f.check] ?? 'off') !== 'off');
  const blocksSoFar = prior?.blocks ?? [];
  const turnUuid = prior?.turnUuid || turn.startUuid;

  const blocking = findings.filter((f) => settings.levels[f.check] === 'block');
  if (blocking.length && !input.stop_hook_active && !input.agent_id) {
    const fill = blocking.every((f) => FILL_CHECKS.includes(f.check) && !f.rewrite);
    store.setJson(turnKey, {
      turnUuid,
      blocks: blocking.map((f) => f.check),
      reasons: blocking.map((f) => f.reason),
      afterUuid: turn.lastUuid,
      mode: fill ? 'fill' : 'rewrite',
      ...(fill ? { answer: turn.answer } : {}),
    } satisfies TurnState);
    const reason = fill
      ? [FILL_HEAD, ...blocking.map((f, i) => `${i + 1}. ${f.reason}${FILL_HINTS[f.check] ?? ''}`)].join('\n')
      : [REWRITE_HEAD, ...blocking.map((f, i) => `${i + 1}. ${f.reason}`)].join('\n');
    return { block: reason, findings };
  }

  // The turn ends: record it, keep what is still wrong for the next prompt, note the labels it asked with.
  store.deleteMeta(turnKey);
  const guard: GuardHit[] = [...blocksSoFar.map((check) => ({ check, level: 'block' as const })), ...findings.map((f) => ({ check: f.check, level: 'warn' as const }))];
  if (turnUuid) store.saveTurnTools({ sessionId, turnUuid, tools: turn.tools, guard });
  if (findings.length) store.setJson(WARN_PREFIX + sessionId, findings.map((f) => f.reason));
  noteAnswerLabels(store, sessionId, turn.allText || answer);
  const caught = new Map<string, GuardCatch>();
  blocksSoFar.forEach((check, i) => caught.set(check, { check, level: 'block', reason: prior?.reasons?.[i] ?? '' }));
  for (const f of findings) if (!caught.has(f.check)) caught.set(f.check, { check: f.check, level: 'warn', reason: f.reason });
  return { findings, answer, caught: [...caught.values()], turnUuid, answerUuid: turn.lastUuid, ...(filled ? { filled } : {}) };
}

/** What each check is about, for the mistakes record (its group is the check id). */
const CHECK_NAMES: Record<string, string> = {
  english: '영어로 쓴 답',
  'path-prose': '문장 속 경로',
  'path-preview': '로컬 경로에 쿼리스트링',
  'path-pair': '경로 짝 빠짐',
  'path-link': '경로 링크 줄 빠짐',
  'path-block': '두 PC 경로를 한 블록에',
  'next-action': '다음 행동 줄 빠짐',
  'open-questions': '남은 질문 줄 빠짐',
  'recommend-basis': '근거 없는 추천',
};
/** Groups in the mistakes record other than the check id: where people already recorded the same slip under a name. */
const CHECK_GROUPS: Record<string, string> = {
  'recommend-basis': '근거 없는 추천',
};
const CHECK_RULES: Record<string, string> = {
  english: 'AGENTS.md 모든 것은 대화 글로(한국어로 답)',
  'path-prose': 'AGENTS.md 모든 것은 대화 글로(경로는 코드 블록에 한 줄씩)',
  'path-preview': 'AGENTS.md 모든 것은 대화 글로(로컬 미리보기는 쿼리스트링 없이)',
  'path-pair': 'AGENTS.md 모든 것은 대화 글로(결과물 경로 줄)',
  'path-link': 'AGENTS.md 모든 것은 대화 글로(경로 아래 누르면 열리는 링크 줄)',
  'path-block': 'AGENTS.md 모든 것은 대화 글로(경로 하나마다 코드 블록 하나)',
  'next-action': 'AGENTS.md 모든 것은 대화 글로(답 끝 다음 행동 및 순서)',
  'open-questions': 'AGENTS.md 모든 것은 대화 글로(남은 질문 줄)',
  'recommend-basis': 'AGENTS.md 모든 것은 대화 글로(추천 선택지 아래 근거 줄)',
};

/**
 * After the turn is logged (run-hook.ts): each check that caught it goes into the mistakes record, found by '장치',
 * grouped by the check id, with the turn's log rows (its prompt and answer) as evidence. Once per turn and check: a hook
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
    store.recordMistake({
      sessionId,
      what: `${CHECK_NAMES[c.check] ?? c.check}(${c.level === 'block' ? '막음: 되돌려 고쳐 씀' : '알림: 다음 답에서 바로잡음'})${first ? `: ${first.slice(0, 200)}` : ''}`,
      madeBy: '비서',
      foundBy: '장치',
      group: CHECK_GROUPS[c.check] ?? c.check,
      cause: '안 지킴',
      logIds,
      ruleRef: CHECK_RULES[c.check] ?? '',
      guard: `Stop 훅 답 검사 ${c.check}(${c.level})`,
    });
    if (turnMark) done.push(mark);
    added++;
  }
  // The marks of the last turns are enough to stop a repeat.
  if (added) store.setJson(key, done.slice(-40));
  return added;
}

/** Prompt hook: what the last answer still had wrong (told once). */
export function guardWarnNotice(store: Store, sessionId: string): string {
  const key = WARN_PREFIX + sessionId;
  const reasons = store.getJson<string[]>(key);
  if (!reasons?.length) return '';
  store.deleteMeta(key);
  return [
    `<${TAG.answerCheck}>`,
    '지난 답 검사에서 걸린 것. 이번 답 맨 위에서 먼저 바로잡는다(무엇이 틀렸고 바른 것이 무엇인지 한두 줄). 같은 실수를 되풀이하지 않는다:',
    ...reasons.map((r) => `- ${r}`),
    `</${TAG.answerCheck}>`,
  ].join('\n');
}
