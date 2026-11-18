/** An answer's text split at its fenced code blocks: the answer checks read the prose and the code apart. */
/** Lines inside fenced code blocks and outside them. */
export function splitFences(text: string): { code: string[]; prose: string[] } {
  const code: string[] = [];
  const prose: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m) {
      if (fence === null) fence = m[1];
      else if (fence === m[1]) fence = null;
      continue;
    }
    (fence === null ? prose : code).push(line);
  }
  return { code, prose };
}
