/**
 * Question labels per session (feature 'mistake-guards'): the next free label is counted here so the secretary never has to.
 * A new session (or /clear, which starts one) begins after the open questions it carried over, relabelled A, B, …
 * (session-continuity/open-questions.ts carryOverQuestions); a compaction keeps the session, so labels go on where they were. The
 * Stop hook reads the "X. …?" question lines (also "X(note). …?") of each turn's text; the prompt hook says the next
 * label, after every label the session asked with.
 */
import { labelAt, labelIndex, parseQuestions } from '../session-continuity/open-questions.ts';
import type { Store } from '../store/store.ts';
import { TAG } from '../core/names.ts';

export const LABELS_PREFIX = 'question_labels:';

interface LabelState {
  /** Index of the next free label (A=0). */
  next: number;
}

const read = (store: Store, sessionId: string): LabelState => store.getJson<LabelState>(LABELS_PREFIX + sessionId) ?? { next: 0 };

/** The next free label of a session ('A' for one with none used). */
export function nextLabel(store: Store, sessionId: string): string {
  return labelAt(read(store, sessionId).next);
}

/** A new session's carried questions took A … up to `count` - 1: its own start after them. */
export function startLabelsAfter(store: Store, sessionId: string, count: number): void {
  const s = read(store, sessionId);
  store.setJson(LABELS_PREFIX + sessionId, { next: Math.max(s.next, count) } satisfies LabelState);
}

/**
 * Every label a turn's text asked a question with: the question lines ("X. …?", "X(note). …?", a carried one shown again as
 * "A(옛 G, #1234). …?"). The remaining-questions list (the closing step "N. 남은 질문에 답해 주세요: …", before
 * 2026-11-12 a "남은 질문:" line) is not read here: its labels were asked on question lines before (or carried
 * over, startLabelsAfter), and words on it ("F(새PC 단계)") once moved the next label far past them.
 */
export function usedLabels(text: string): string[] {
  return Object.keys(parseQuestions(text));
}

/** Stop hook: the labels a turn used move the next one past them (never back). */
export function noteAnswerLabels(store: Store, sessionId: string, answer: string): void {
  const used = usedLabels(answer).map(labelIndex);
  if (!used.length) return;
  const s = read(store, sessionId);
  const next = Math.max(s.next, Math.max(...used) + 1);
  if (next !== s.next) store.setJson(LABELS_PREFIX + sessionId, { next } satisfies LabelState);
}

/** Prompt hook: one line with the next label. */
export function labelNotice(store: Store, sessionId: string): string {
  return `<${TAG.questionLabel}>이 세션의 다음 질문 알파벳: ${nextLabel(store, sessionId)} (훅이 센다. 새로 묻는 질문은 이 알파벳부터 붙인다)</${TAG.questionLabel}>`;
}
