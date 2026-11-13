/**
 * The words the secretary made up and the user had to ask about (answer check invented-word, P3 of the 2026-11-13 askback
 * review, the user's call): the list in git (invented-words.json, with where each came from) and the words
 * record_mistake added since (its invented_words argument), kept in the database's meta so they stay this user's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../store/store.ts';

export const INVENTED_WORDS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'invented-words.json');
/** meta key of the words record_mistake added. */
export const ADDED_KEY = 'invented_words';

export function baseInventedWords(file = INVENTED_WORDS_FILE): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { words?: Array<{ word?: unknown }> };
    return (j.words ?? []).map((w) => (typeof w.word === 'string' ? w.word.trim() : '')).filter(Boolean);
  } catch {
    return [];
  }
}

export function addedInventedWords(store: Store): string[] {
  const v = store.getJson<unknown>(ADDED_KEY);
  return Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && !!w.trim()) : [];
}

/** Every word the check looks for: the git list and those added, each once. */
export function inventedWords(store: Store): string[] {
  return [...new Set([...baseInventedWords(), ...addedInventedWords(store)])];
}

/** Adds words (trimmed, 1 to 20 characters, not already listed); returns those added. */
export function addInventedWords(store: Store, words: readonly string[]): string[] {
  const have = new Set(inventedWords(store));
  const fresh = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 1 && w.length <= 20 && !have.has(w)))];
  if (fresh.length) store.setJson(ADDED_KEY, [...addedInventedWords(store), ...fresh]);
  return fresh;
}
