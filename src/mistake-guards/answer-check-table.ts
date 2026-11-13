/**
 * Every answer check the Stop hook runs (feature 'mistake-guards'), one row each: the one place to add, change or take out
 * a check. The checks themselves are in answer-checks.ts (checkAnswer runs them); everything else about a check is read
 * from here:
 *   level   its default level (block | warn; this PC may change it: mistake-guard-settings.ts levels)
 *   name    what it is about, for the mistakes record (stop-guard.ts recordGuardMistakes)
 *   rule    the rule it stands for, for the mistakes record
 *   group   the mistakes-record group when it is not the check's id (where people already recorded the same slip)
 *   fill    when its catch is fixed by lines added after the answer (stop-guard.ts 'fill'): how, said after its reason.
 *           Without it a blocking catch has the answer written again whole.
 *   format  .agents/hook-notices/answer-format.md has a `## <check id>` piece for it, said after its reason (the text
 *           stays in that file, which every CLI reads: core/hook-notice-text.ts)
 *
 * Levels (decided 2026-11-07): English and the answer's form block; a path in a sentence only warns (that check can be
 * wrong about a path: a rule quoted, a settings file). The checks for two PCs' paths in one code block, a missing closing
 * "다음 행동 및 순서:" line and a missing "남은 질문" were taken out (2026-11-12, the user's call); the rules stay in AGENTS.md.
 */
export type Level = 'block' | 'warn' | 'off';

/**
 * One group for a recommendation made without checking its source (2026-11-13 user's call): the records had
 * it under four names ("근거 없는 추천", "확인 없이 추천", "추천 근거 안 봄", "basis-unopened"), so a repeat went uncounted.
 * Migration 18 (store/schema.ts) moved the old records.
 */
export const RECOMMEND_UNCHECKED = '확인 없이 추천';

export interface AnswerCheck {
  level: Exclude<Level, 'off'>;
  name: string;
  rule: string;
  group?: string;
  fill?: string;
  format?: true;
}

export const ANSWER_CHECKS = {
  // The answer is written in English (Korean is the rule; code, commands and names aside).
  english: {
    level: 'block',
    name: '영어로 쓴 답',
    rule: 'AGENTS.md 답 쓰는 법 > 기본(한국어로 답)',
    format: true,
  },
  // A results-folder path inside a sentence (paths go on their own line in a code block; web addresses, like the phone
  // address's tap-to-open link under the path's code block, are not paths).
  'path-prose': {
    level: 'warn',
    name: '문장 속 경로',
    rule: 'AGENTS.md 답 쓰는 법 > 경로(경로는 코드 블록에 한 줄씩)',
    format: true,
  },
  // A code line with a result path on this PC (under an output folder, a report, a note; not the secretary's own folder,
  // code or settings files) lacks its other-PC code line.
  'path-pair': {
    level: 'block',
    name: '경로 짝 빠짐',
    rule: 'AGENTS.md 답 쓰는 법 > 경로(결과물 경로 줄)',
    fill: ' 빠진 다른 PC 경로 줄만 자기 코드 블록으로 이어 쓴다(경로 하나에 코드 블록 하나, 링크 줄도 빠졌으면 그 블록 바로 아래 블록 밖에 붙인다).',
    format: true,
  },
  // Such a result path lacks its tap-to-open link to the phone address ([주소](주소), outside the code blocks; only when
  // the dashboard gives a phone address), or its link is named other than the address (no phone address code line since
  // 2026-11-07).
  'path-link': {
    level: 'block',
    name: '경로 링크 줄 빠짐·이름이 주소 아님',
    rule: 'AGENTS.md 답 쓰는 법 > 경로(경로 아래 누르면 열리는 링크 줄)',
    fill: ' 빠진 링크 줄만 이어 쓴다(이름이 주소가 아닌 링크였으면 이름을 주소 그대로 쓴 링크 줄을, 코드 블록 밖에. 폰 주소는 이 링크 줄로만 쓴다).',
    format: true,
  },
  // An option marked "(추천)" has no "근거:" line right under it or its indented details (short answers aside; decided
  // 2026-11-07, after a pick recommended unchecked). Fixed by writing the question's block again (its basis line has to
  // sit right under the pick, which lines added at the end cannot do); the check reads a label asked twice by its last
  // block.
  'recommend-basis': {
    level: 'block',
    name: '근거 없는 추천',
    rule: 'AGENTS.md 답 쓰는 법 > 추천 근거(추천 선택지 아래 추천 근거)',
    group: RECOMMEND_UNCHECKED,
    fill: ' 추천 근거(`> 근거:` 줄)는 추천 선택지 바로 아래에 있어야 하므로, 이것은 예외로 그 질문 블록(질문 줄과 선택지 전체)을 같은 질문 알파벳으로 다시 적고 추천 선택지 줄 바로 아래에 추천 근거를 넣는다(다시 적은 블록으로 검사한다).',
  },
  // A "근거:" line names something one could open (a file, a line number, a report, a command) and says it was not looked
  // at ("확인 안 함", "안 봄"; decided 2026-11-10), or writes "자료 있음, 못 봄(<무엇>)" without the reason it could not be
  // opened ("이유: <못 연 이유>", decided 2026-11-12). Only told, since what can be opened is read off the words and may be
  // wrong.
  'basis-unopened': {
    level: 'warn',
    name: '근거 자료 안 봄·못 연 이유 없음',
    rule: 'AGENTS.md 답 쓰는 법 > 추천 근거(근거 자료가 있으면 열어 보고 쓴다)',
    group: RECOMMEND_UNCHECKED,
  },
  // A "근거:" line says it was not looked at ("확인 안 함(짐작)", "자료 있음, 안 봄(…)" and the like) and names nothing to
  // open: written now as "자료 있음, 못 봄(<무엇>, 이유: <못 연 이유>)" or "확인할 자료 없음(짐작)" (with something to open
  // it is basis-unopened's, never both; quoted words are not the basis's own). Only told, so the two forms take its place
  // without sending a turn back.
  'basis-old-form': {
    level: 'warn',
    name: '옛 형식 근거',
    rule: 'AGENTS.md 답 쓰는 법 > 추천 근거(추천 근거 두 형식)',
  },
  // A "근거:" line cites a file, a #number, a commit or a command that no tool call of this turn or the two before it
  // shows (its input or result, or the memory injection), or cites nothing at all and is neither form for "not seen"
  // (seen-sources.ts, P1 of the 2026-11-13 askback review: the cited source was often never opened). Only told: "opened" is
  // read off the words of a tool call.
  'basis-source': {
    level: 'warn',
    name: '근거 자료 안 열어 봄·출처 없는 근거',
    rule: 'AGENTS.md 답 쓰는 법 > 추천 근거(이 턴이나 이 대화에서 실제로 확인한 것)',
    group: RECOMMEND_UNCHECKED,
  },
  // An answer passing on a report (subagent, run-job, work session) names paths the report gave that the secretary's own
  // tools never opened (seen-sources.ts, P5). Only told.
  'report-relay': {
    level: 'warn',
    name: '보고의 경로를 안 열고 전함',
    rule: 'AGENTS.md 일하는 순서와 확인 > 정확성(업무 세션·run-job의 보고)',
    group: '보고 검수 없이 전함',
  },
  // A word from the list of words the secretary made up (invented-words.json, and those record_mistake added) stands in a
  // question, an option or a basis line without an explanation in parentheses right after it (P3). Only told.
  'invented-word': {
    level: 'warn',
    name: '풀이 없는 지어낸 말',
    rule: 'AGENTS.md 답 쓰는 법 > 말투(지어낸 말은 보통 쓰는 말로)',
    group: '지어낸 말',
  },
  // A question or its options lean on the answer to another question asked in the same answer ("SF1이면"): asked
  // together, the second is read before the first is settled (P6, the user's call 2026-11-13). Only told.
  'dependent-question': {
    level: 'warn',
    name: '다른 질문의 답에 딸린 질문을 같이 물음',
    rule: 'AGENTS.md 답 쓰는 법 > 질문(다른 질문의 답에 따라 달라지는 질문은 다음 턴에)',
    group: '딸린 질문',
  },
} as const satisfies Record<string, AnswerCheck>;

/** A check's id: a finding (answer-checks.ts Finding.check) can name no other, so the type checker keeps the table whole. */
export type CheckId = keyof typeof ANSWER_CHECKS;

/** The row of a check id read back from a record (a check taken out since: undefined). */
export function answerCheck(id: string): AnswerCheck | undefined {
  return Object.hasOwn(ANSWER_CHECKS, id) ? (ANSWER_CHECKS as Record<string, AnswerCheck>)[id] : undefined;
}

/** The checks with a piece in .agents/hook-notices/answer-format.md, one `## <check id>` heading each (test/prompt-notices.test.ts looks each up). */
export const FORMAT_NOTICE_KEYS: string[] = Object.entries(ANSWER_CHECKS as Record<string, AnswerCheck>)
  .filter(([, c]) => c.format)
  .map(([id]) => id);
