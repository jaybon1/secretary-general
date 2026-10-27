/**
 * The "keep going past 90%" phrase: when the user says it, the prompt hook lifts the usage guard
 * (scripts/usage-guard.mjs) until the subscription's 5-hour reset. Usage files are written by
 * scripts/usage.ps1 (see scripts/usage-file.mjs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_DIR = path.join(os.homedir(), '.claude', 'usage');
export const OVERRIDE_FILE = path.join(USAGE_DIR, 'guard-override.json');
/** "90%를 초과하더라도 진행", "90퍼 넘어도 계속" and the like: 90, then 초과/넘…도, then 진행/계속. */
const OVERRIDE_PHRASE = /90\s*(퍼센트|퍼|프로|%)?\s*(를|을|가|이)?\s*(초과|넘)[가-힣]*도\s*(진행|계속)/;

export function isOverridePhrase(prompt: string): boolean {
  return OVERRIDE_PHRASE.test(prompt);
}

function resetsAt(): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(USAGE_DIR, 'subscription.json'), 'utf8')) as { resets_at?: string }).resets_at;
  } catch {
    return undefined;
  }
}

/** If the prompt carries the override phrase, lift the guard until the 5-hour reset (or 5 hours). */
export function applyGuardOverride(prompt: string, now = Date.now()): string {
  if (!isOverridePhrase(prompt)) return '';
  const resets = resetsAt();
  const until = resets && Date.parse(resets) > now ? resets : new Date(now + 5 * 3600_000).toISOString();
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify({ until, set_at: new Date(now).toISOString() }));
  return `<secretary-usage>사용량 정지 장치를 5시간 사용량 초기화(${until})까지 풀었어요. 사용자가 지금 일에 한해 90%를 넘어도 진행하라고 했어요.</secretary-usage>`;
}
