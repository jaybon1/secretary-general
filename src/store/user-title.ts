/**
 * 사용자를 부르는 이름(호칭)의 DB 칸(meta 'user_title'). 규칙·스킬·코드 글은 사용자를 '사용자'로 쓰고, 부르는 법은 핵심
 * 프로필에, 이름 하나는 이 칸에 둔다. 사람에 관한 사실은 DB에 두기 때문이다(git에 올라가는 파일에는 개인 값을 쓰지 않는다).
 * 이 칸을 읽는 곳: 그 이름으로 쓰인 기억 글("<호칭>님은 …")을 읽는 글 검사(hooks/prompt-memory.ts droppedLabel,
 * memory/injection-screen.ts의 숨기기 지시). 칸이 비면 '사용자'만 본다.
 * 넣고 보고 빼기: node src/cli.ts user-title [<호칭> | --clear] (끝의 '님'은 떼고 둔다. 검사가 '님'을 따로 본다).
 */
import type { DatabaseSync } from 'node:sqlite';
import { deleteMeta, getMeta, setMeta } from './meta-usage.ts';

export const USER_TITLE_KEY = 'user_title';
/** The word the rules and code use for the user; always read. */
export const USER_WORD = '사용자';
const MAX_CHARS = 20;

/** "홍길동님 " → "홍길동": spaces folded, the 님 of an address taken off (the checks read 님 apart). */
export function normalizeTitle(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim().replace(/\s*님$/, '').trim();
}

/** The title set in this DB, or null. */
export function getUserTitle(db: DatabaseSync): string | null {
  const v = getMeta(db, USER_TITLE_KEY);
  const t = v ? normalizeTitle(v) : '';
  return t && t !== USER_WORD ? t : null;
}

/** Sets the title (normalized); returns it. A title of 사용자 itself is the same as none, so it clears the field. */
export function setUserTitle(db: DatabaseSync, raw: string): string | null {
  const t = normalizeTitle(raw);
  if (!t) throw new Error('호칭이 비어 있어요.');
  if (Array.from(t).length > MAX_CHARS) throw new Error(`호칭은 ${MAX_CHARS}자 안으로 써 주세요: ${t}`);
  if (/[\r\n<>`]/.test(t)) throw new Error(`호칭에 줄바꿈이나 <, >, \` 를 넣지 않아요: ${t}`);
  if (t === USER_WORD) {
    deleteMeta(db, USER_TITLE_KEY);
    return null;
  }
  setMeta(db, USER_TITLE_KEY, t);
  return t;
}

export function clearUserTitle(db: DatabaseSync): void {
  deleteMeta(db, USER_TITLE_KEY);
}

/** The words the text checks read as the user: 사용자, then the title when one is set. No DB, only 사용자. */
export function userWords(db?: DatabaseSync | null): string[] {
  const t = db ? getUserTitle(db) : null;
  return t ? [USER_WORD, t] : [USER_WORD];
}

/** A regex group matching any of the words (each written literally). */
export function wordsGroup(words: readonly string[]): string {
  return `(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`;
}
