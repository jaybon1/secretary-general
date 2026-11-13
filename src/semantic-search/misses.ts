/**
 * 의미 검색이 답을 주지 못한 때의 기록과 알림(2026-11-13 사용자 결정, 출처 재검토 C9를 넓힘).
 *
 * Every feature that leans on the semantic-search server (the per-prompt injection, the recall tool, remember's duplicate
 * check, the consolidation's close memories: semanticClient's `feature`) used to fall back to word search without a
 * word when the server did not answer. Now each such miss (not running, loading, stopped, timed out, an error) is one
 * line in this secretary's records folder (~/.secretary/<id>/logs/semantic-search-misses.jsonl, core/paths.ts
 * secretaryLogDir): when, which feature, why, and which database. A setting that turns semantic search off is not a miss.
 *
 * A miss streak (next to the database, like the server's down file) runs from the first miss to the next answer. When
 * it has lasted MISS_NOTICE_AFTER_MS, the prompt hook tells each session once, inside the semantic-search server notice,
 * where the record is and what to do (.agents/hook-notices/semantic-search-misses.md), so the secretary can find and fix
 * the cause. A cold start after the server idled out is one short miss and tells nobody.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../core/config.ts';
import { formatLocal } from '../core/kst-time.ts';
import { readJsonFile } from '../core/json-file.ts';
import { secretaryLogDir } from '../core/paths.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';
import { TAG } from '../core/names.ts';
import { MISS_STREAK_FILE } from './config.ts';

export const MISS_LOG_NAME = 'semantic-search-misses.jsonl';
/** Overrides where the misses are written (tests and the evaluation set write into their own folder). */
export const MISS_LOG_ENV = 'SECRETARY_SEMANTIC_SEARCH_MISS_LOG';
/** The record keeps about this many last lines (trimmed once it passes MISS_LOG_MAX_BYTES). */
export const MISS_LOG_KEEP_LINES = 2000;
const MISS_LOG_MAX_BYTES = 1024 * 1024;
/**
 * A streak this long is told: a cold start after the server idled out answers again within seconds (the server's own
 * failure log shows recoveries 3 and 7 s after a crash), while two minutes without an answer means something is wrong.
 */
export const MISS_NOTICE_AFTER_MS = 2 * 60_000;
export const NOTICE_NAME = 'semantic-search-misses';

export function missLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return env[MISS_LOG_ENV] || path.join(secretaryLogDir(), MISS_LOG_NAME);
}

export interface MissStreak {
  since: string;
  last: string;
  count: number;
  /** Misses in this streak by reason and by feature. */
  reasons: Record<string, number>;
  features: Record<string, number>;
  /** Sessions already told about this streak. */
  told: string[];
}

export const readStreak = () => readJsonFile<MissStreak>(MISS_STREAK_FILE);

function append(line: object): void {
  const file = missLogFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MISS_LOG_MAX_BYTES) {
        const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MISS_LOG_KEEP_LINES);
        fs.writeFileSync(file, kept.join('\n') + '\n');
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {}
}

/**
 * One miss: a line in the record and the streak. Best effort: the prompt hook runs it, and a failed write must not cost
 * the memory injection.
 */
export function noteMiss(feature: string, reason: string, now = Date.now()): void {
  const at = new Date(now).toISOString();
  append({ at, local: formatLocal(now, false, true), feature, reason, db: DB_PATH });
  try {
    const s = readStreak();
    const next: MissStreak = s
      ? { ...s, last: at, count: s.count + 1, reasons: { ...s.reasons, [reason]: (s.reasons[reason] ?? 0) + 1 }, features: { ...s.features, [feature]: (s.features[feature] ?? 0) + 1 } }
      : { since: at, last: at, count: 1, reasons: { [reason]: 1 }, features: { [feature]: 1 }, told: [] };
    fs.writeFileSync(MISS_STREAK_FILE, JSON.stringify(next));
  } catch {}
}

/** The server answered: a streak ends, with a line saying how long it lasted. One stat when there is none. */
export function noteAnswered(feature: string, now = Date.now()): void {
  if (!fs.existsSync(MISS_STREAK_FILE)) return;
  const s = readStreak();
  try {
    fs.rmSync(MISS_STREAK_FILE, { force: true });
  } catch {}
  if (!s) return;
  const minutes = Math.round((now - Date.parse(s.since)) / 60_000);
  append({ at: new Date(now).toISOString(), local: formatLocal(now, false, true), feature, reason: `회복: 응답함(실패 ${s.count}번, 약 ${minutes}분 뒤)`, db: DB_PATH });
}

/** "시간 초과 3번, 불러오는 중 1번". */
const counts = (r: Record<string, number>) =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}번`)
    .join(', ');

/**
 * The line for the prompt hook: once per session per streak, once it has lasted MISS_NOTICE_AFTER_MS; '' otherwise.
 * Left out while the server's own outage notice speaks (a down file: outage.ts outageNotice), so a session is not told twice.
 */
export function missNotice(sessionId: string, downFile: boolean, now = Date.now()): string {
  const s = readStreak();
  if (!s || downFile || s.told.includes(sessionId)) return '';
  if (now - Date.parse(s.since) < MISS_NOTICE_AFTER_MS) return '';
  try {
    fs.writeFileSync(MISS_STREAK_FILE, JSON.stringify({ ...s, told: [...s.told, sessionId] }));
  } catch {}
  const minutes = Math.max(1, Math.round((now - Date.parse(s.since)) / 60_000));
  const todo = hookNoticeText(NOTICE_NAME, 'todo').replaceAll('{log}', missLogFile());
  const head = `의미 검색이 ${formatLocal(s.since)}부터 약 ${minutes}분째 답하지 않아 단어 검색만 쓰고 있어요(이유: ${counts(s.reasons)} · 기능: ${counts(s.features)})`;
  return `<${TAG.semanticSearchServer}>${head} — ${todo}</${TAG.semanticSearchServer}>`;
}
