/** Token budgeting: how much text costs, estimated without a tokenizer. */

/**
 * Deliberately conservative token estimate (over-counts rather than under-counts,
 * so the hard budget really is a ceiling). ~4 chars/token for ASCII, ~1 token
 * per Hangul/CJK char.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other);
}
