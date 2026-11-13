/**
 * The two forms of a recommendation's basis line ("> 근거: …") when it is not what was seen: written once here for the
 * answer check (mistake-guards/answer-checks.ts) and the workspace charter (workspace/secretary-link.ts), and checked to
 * stand as written in AGENTS.md (test/basis-forms.test.ts), so a change of form reaches every place at once.
 */

/**
 * Something there that could not be opened this turn. Not looking needs no reason, not being able to does (decided
 * 2026-11-12), so the form carries the reason.
 */
export const BASIS_UNABLE = '자료 있음, 못 봄(<무엇>, 이유: <못 연 이유>)';

/** A guess no record can settle (things one has to try, taste, intuition). */
export const BASIS_GUESS = '확인할 자료 없음(짐작)';
