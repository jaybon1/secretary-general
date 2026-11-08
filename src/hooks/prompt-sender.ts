/**
 * Who a prompt hook's prompt comes from. Claude Code runs the prompt hook for every turn, not only the
 * ones a person types: a message from another session or a subagent's report arrives as
 * "Another Claude session sent a message:" with the text in an <agent-message from=…> frame, and a
 * background task's end as a <task-notification> (on its own or inside a <system-reminder>).
 * Their text can quote anything (a report describing the guard override, say), so notices that act on
 * the user's words must not read it as theirs.
 *
 *   - 'user': typed by the person.
 *   - 'machine': anything else made by a session or the harness.
 */
export type PromptSource = 'user' | 'machine';

const PEER_HEADER = /^Another Claude session sent a message:/;
/** A frame the harness puts around machine-made text: the whole prompt starts with one. */
const MACHINE_FRAME = /^<(agent-message|task-notification|system-reminder)[\s>]/;
/** Frames that can ride inside a typed prompt: what is in them is not the person's. */
const EMBEDDED = /<(agent-message|task-notification|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g;

export function promptSource(prompt: string): PromptSource {
  const head = prompt.trimStart();
  if (PEER_HEADER.test(head) || MACHINE_FRAME.test(head)) return 'machine';
  return 'user';
}

/** The words the person typed: '' unless the source is 'user', framed machine text taken out. */
export function typedText(prompt: string): string {
  return promptSource(prompt) === 'user' ? prompt.replace(EMBEDDED, '') : '';
}

/** The person's words: what they typed (kept as its own name for the notices that read it). */
export function personText(prompt: string): string {
  return typedText(prompt);
}
