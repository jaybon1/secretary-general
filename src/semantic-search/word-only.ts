/**
 * "단어 검색으로 답해": the user's way, when the semantic-search server would not come up, to have the secretary go on with
 * word search alone in that conversation (2026-11-13 the user's call). The prompt hook notes the session,
 * and its memory injection then neither waits for the server nor asks again; asking for the server back ("의미 검색 다시
 * 켜") ends it. Only the prompt hook reads it: the memory MCP server does not know which conversation calls it.
 */
import type { Store } from '../store/store.ts';

/** meta key: the sessions on word search only, newest last. */
export const WORD_ONLY_KEY = 'semantic_word_only_sessions';
const KEEP = 20;
export const WORD_ONLY_ASK = /단어\s*검색\s*(?:만\s*)?(?:으로|로)\s*(?:만\s*)?(?:답|해|하|진행|이어)/;
export const WORD_ONLY_END = /의미\s*검색\s*(?:서버)?\s*(?:를|을)?\s*(?:다시\s*)?(?:켜|살려|띄워|되살려)/;

/** Whether this session answers with word search only, after taking the prompt's own say into account. */
export function wordOnly(store: Store, sessionId: string | undefined, prompt: string): boolean {
  if (!sessionId) return false;
  const list = store.getJson<string[]>(WORD_ONLY_KEY) ?? [];
  const has = list.includes(sessionId);
  if (WORD_ONLY_END.test(prompt)) {
    if (has) store.setJson(WORD_ONLY_KEY, list.filter((s) => s !== sessionId));
    return false;
  }
  if (WORD_ONLY_ASK.test(prompt)) {
    if (!has) store.setJson(WORD_ONLY_KEY, [...list, sessionId].slice(-KEEP));
    return true;
  }
  return has;
}
