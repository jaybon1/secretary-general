/**
 * Search terms for Korean (and any) text: what goes into the FTS index and what a query is split into.
 * Token estimates, time display and secret masking used to live here too; they are in core/ (tokens,
 * kst-time, secrets).
 *
 * FTS5's default tokenizer splits on whitespace, which fails for Korean:
 * "서울에서" and "서울로" share no token. We index CJK runs as character
 * bigrams instead (서울 울에 에서 / 서울 울로), so "서울" matches both.
 * Latin/number words are kept whole.
 */
const CJK_RUN = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u;
const SPLIT_RUNS =
  /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

/** Bigrams that are mostly grammatical endings/particles; dropped from queries only. */
const QUERY_STOP = new Set([
  '니다', '습니', '합니', '입니', '하는', '있는', '에서', '으로', '하고', '해서', '해줘', '어요',
  '아요', '해요', '는데', '지만', '이다', '했다', '있다', '없다', '것을', '것이', '거야', '했어',
  '그리', '리고', '그래', '래서', '하지', '지금', '나는', '내가', '너는', '이야', '이에', '에요',
  '알려', '려줘', '뭐야', '어떻', '떻게', '할까', '을까', '은데', '는지', '었지', '였지', '했지',
]);

export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const [word] of text.normalize('NFC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    for (const run of word.match(SPLIT_RUNS) ?? []) {
      if (!CJK_RUN.test(run)) {
        terms.push(run);
        continue;
      }
      const chars = Array.from(run);
      if (chars.length === 1) terms.push(run);
      for (let i = 0; i + 1 < chars.length; i++) terms.push(chars[i] + chars[i + 1]);
    }
  }
  return terms;
}

/** What gets written into the FTS column. */
export function indexText(...parts: Array<string | null | undefined>): string {
  return searchTerms(parts.filter(Boolean).join(' ')).join(' ');
}

/**
 * Distinct query terms, minus particle-like bigrams and lone CJK characters
 * ("간", "게"), unless that would leave nothing.
 */
export function queryTerms(query: string): string[] {
  const all = [...new Set(searchTerms(query))];
  const kept = all.filter((t) => !QUERY_STOP.has(t) && !(t.length === 1 && CJK_RUN.test(t)));
  return kept.length > 0 ? kept : all;
}

/** FTS5 MATCH expression: any term, each quoted so user text can't inject FTS syntax. */
export function ftsQuery(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}
