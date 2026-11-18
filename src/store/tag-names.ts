/**
 * 기억 태그 이름 다루기(옮기기 21의 태그 표 tags·memory_tags): 태그 다듬기, 주제 요약의 주제 이름(주제 열쇠), 내용 끝에 잘못 붙은
 * 대괄호 태그 찾기, 그리고 태그·주제를 읽는 SQL 조각. DB를 직접 읽지 않는다(옮기기·memories.ts·memory-actions.ts·DB 정리 명령·
 * 지시서 대조가 함께 쓴다).
 *
 * A memory's tags are kept whole in the tag tables, the first one its topic (a tag may hold a space: "모종 가게", "할 일").
 * Before migration 21 they were one string joined by spaces, so a tag of two words could not be told from two tags; the
 * migration split them by spaces and the memory consolidation sets the right boundaries a few memories a run.
 */

/**
 * Topics too broad for one summary (half of all memories are the secretary's own): summarised per their second tag, the
 * topic key "비서/상황판". Before, '비서' had no summary at all.
 */
export const SUMMARY_SPLIT_TOPICS: ReadonlySet<string> = new Set(['비서']);
/** Between a split topic and its second tag in a topic key. */
export const TOPIC_SPLIT = '/';
/** The tag a topic summary carries after its topic: never taken for a subtopic. */
export const SUMMARY_TAG = '요약';

/** One tag as kept: NFC, lower case, inner spaces made one. */
export function cleanTag(t: string): string {
  return t.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Tags as kept, in order (the first is the topic): cleaned, empties and repeats dropped. A topic key given first
 * ("비서/상황판", what list_topics shows) stands for its two tags.
 */
export function tagList(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  (tags ?? []).forEach((raw, i) => {
    const t = cleanTag(raw);
    const at = t.indexOf(TOPIC_SPLIT);
    const parts = i === 0 && at > 0 && SUMMARY_SPLIT_TOPICS.has(t.slice(0, at).trim()) ? [t.slice(0, at), t.slice(at + 1)].map(cleanTag) : [t];
    for (const p of parts) if (p && !out.includes(p)) out.push(p);
  });
  return out;
}

/** The topic key of tags in order: the topic, or "비서/<second tag>" for a split topic ('' without tags). */
export function topicKey(tags: readonly string[]): string {
  const [topic, second] = tags;
  if (!topic) return '';
  return SUMMARY_SPLIT_TOPICS.has(topic) && second && second !== SUMMARY_TAG ? `${topic}${TOPIC_SPLIT}${second}` : topic;
}

const sqlList = (xs: Iterable<string>) => [...xs].map((x) => `'${x.replaceAll("'", "''")}'`).join(', ');

/** SQL for the tags of memory row `a` (an alias in the query), in order and joined by spaces ('' without tags). */
export const TAGS_SQL = (a = 'm') =>
  `coalesce((SELECT group_concat(t.name, ' ' ORDER BY mt.position) FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = ${a}.id), '')`;
/**
 * SQL for the tags of memory row `a` as a line shows them: in order and joined by ", " ('' without tags), so a tag of two
 * words ("할 일") reads as one. Only for showing: the word index and the meaning vector read TAGS_SQL's space-joined text,
 * so changing this one never calls for indexing or embedding again.
 */
export const TAGS_SHOWN_SQL = (a = 'm') =>
  `coalesce((SELECT group_concat(t.name, ', ' ORDER BY mt.position) FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = ${a}.id), '')`;
/**
 * Whether new tags hold the same words as the old ones (case and order aside): setting the boundaries the old one-string
 * tags lost only joins split words again, and a word dropped or added would change what the memory is found by
 * (set_memory_tags, memory/tag-boundaries.ts).
 */
export function sameTagWords(before: readonly string[], after: readonly string[]): boolean {
  const words = (xs: readonly string[]) => [...new Set(xs.flatMap((t) => t.toLowerCase().split(/\s+/)).filter(Boolean))].sort().join(' ');
  return words(before) === words(after);
}
/** A memory's tags as a line shows them (TAGS_SHOWN_SQL), or the space-joined ones for a memory made in code. */
export const shownTags = (m: { tags: string; tags_shown?: string }): string => m.tags_shown ?? m.tags;
/** SQL for the topic tag of memory row `a` ('' without tags). */
export const TOPIC_TAG_SQL = (a = 'm') =>
  `coalesce((SELECT t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = ${a}.id AND mt.is_topic = 1), '')`;
/** SQL for the topic key of memory row `a`: topicKey below, in SQL. */
export const TOPIC_SQL = (a = 'm') =>
  `coalesce((SELECT CASE WHEN t0.name IN (${sqlList(SUMMARY_SPLIT_TOPICS)}) AND t1.name IS NOT NULL AND t1.name != '${SUMMARY_TAG}'
                         THEN t0.name || '${TOPIC_SPLIT}' || t1.name ELSE t0.name END
     FROM memory_tags m0 JOIN tags t0 ON t0.id = m0.tag_id
     LEFT JOIN memory_tags m1 ON m1.memory_id = m0.memory_id AND m1.position = 1
     LEFT JOIN tags t1 ON t1.id = m1.tag_id
     WHERE m0.memory_id = ${a}.id AND m0.is_topic = 1), '')`;

/** Words of a bracket or of tags, for comparing them (split on spaces and commas). */
const words = (s: string) => cleanTag(s).split(/[\s,，、·]+/).filter(Boolean);

/**
 * The tags written again at the end of the content, " [텃밭 모종 업무 3]", that the line shows already from the tag column
 * (so they showed twice and were counted twice in the word index). A bracket counts as tags when it opens with the
 * topic's first word and shares a word with the tags, or when two words or more and at least half of its words are tag
 * words; anything else in brackets ("[비서가 원문을 직접 확인하지는 않음]", "[개선 후보]") is the content's own. Returns the
 * content without it and the bracket's words the tags lack (kept as tags, so nothing searchable is lost), or null. Two
 * such brackets one after the other ("… [비서 이름] [비서 이름 정리]") go together (up to three).
 */
export function trailingTagBracket(content: string, tags: readonly string[]): { content: string; extra: string[]; brackets: string[] } | null {
  if (!tags.length) return null;
  const tagWords = new Set(tags.flatMap(words));
  const topicFirst = words(tags[0])[0];
  let rest = content;
  const extra: string[] = [];
  const brackets: string[] = [];
  for (let i = 0; i < 3; i++) {
    const m = /\s*\[([^[\]\n]{1,120})\]\s*$/.exec(rest);
    if (!m) break;
    const before = rest.slice(0, m.index).trimEnd();
    const bracket = words(m[1]);
    const shared = bracket.filter((w) => tagWords.has(w)).length;
    const isTags = (bracket[0] === topicFirst && shared >= 1) || (shared >= 2 && shared * 2 >= bracket.length);
    if (!before || !isTags) break;
    rest = before;
    brackets.unshift(`[${m[1]}]`);
    for (const w of bracket) if (!tagWords.has(w) && !extra.includes(w)) extra.push(w);
  }
  return brackets.length ? { content: rest, extra, brackets } : null;
}
