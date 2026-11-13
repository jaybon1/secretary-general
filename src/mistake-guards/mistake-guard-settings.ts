/**
 * 실수 막기 장치(기능 'mistake-guards')의 설정: 기능이 켜졌는지, 검사마다 막을지·알릴지(수준), 결과물 상위 폴더와 그 다른 PC 경로·폰 주소.
 *
 * - 결과물 상위 폴더(aiRoot), 다른 PC 경로(otherPcRoot, 이 비서 전용 설정 this-secretary.local.json의 paths 키, 커밋하지 않는다),
 *   폰 주소(대시보드 키의 publicUrl)는 core/result-paths.ts가 읽는다. SessionStart 훅이 비서에게 알려 주는 값과 같다.
 *   다른 PC 경로가 없으면 경로 짝 검사와 다른 PC 미리보기 주소 검사를 건너뛴다.
 *
 * this-secretary.local.json의 mistake-guards 키 (키는 모두 선택, core/this-secretary.ts):
 *   levels       { 검사 id: "block" | "warn" | "off" } 기본 수준을 이 PC에서만 바꾼다
 *   repeatLimit  한 턴에 같은 종류 조작이 몇 번 되풀이되면 반복 작업 알림을 띄울지(기본 10, 0이면 끔. repeat-hook.ts)
 */
import fs from 'node:fs';
import { PROJECT_ROOT } from '../core/config.ts';
import { readResultPaths, type ResultPaths } from '../core/result-paths.ts';
import { readThisSecretary } from '../core/this-secretary.ts';
import { featureOn, readFeatures } from '../core/features.ts';
import { FEATURE } from '../core/names.ts';
import { ANSWER_CHECKS, type CheckId, type Level } from './answer-check-table.ts';

export const FEATURE_ID = FEATURE.mistakeGuards;

/** This copy's mistake-guards section of this-secretary.local.json ({} when there is none, or the feature is off). */
function localSection(root: string): { levels?: Record<string, unknown>; repeatLimit?: unknown } {
  const r = readThisSecretary<{ levels?: Record<string, unknown>; repeatLimit?: unknown }>(FEATURE_ID, { root });
  return r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {};
}

export type { Level };

/**
 * Each check's level, as answer-check-table.ts sets it. block: the Stop hook sends the turn back with the reason (the
 * model writes again, once). warn: the turn ends as it is, the next prompt carries the reason (fixed first at the top of
 * the next answer), and the turn record keeps it. Either way the slip goes into the mistakes record (stop-guard.ts
 * recordGuardMistakes).
 */
export const DEFAULT_LEVELS = Object.fromEntries(Object.entries(ANSWER_CHECKS).map(([id, c]) => [id, c.level])) as Record<CheckId, Level>;

/** aiRoot, otherPcRoot, phoneRoot: core/result-paths.ts. */
export interface GuardSettings extends ResultPaths {
  on: boolean;
  levels: Record<string, Level>;
  /** The secretary's own folder (its paths are code and settings, never results to pair). */
  secretaryDir?: string;
}

/** Whether the feature is on in this copy's features.json (on without the file, like every feature). */
export function guardsOn(root = PROJECT_ROOT): boolean {
  const f = (readFeatures(root) ?? []).find((x) => x.id === FEATURE_ID);
  return !f || featureOn(f);
}

export function readGuardSettings(root = PROJECT_ROOT): GuardSettings {
  const local = localSection(root);
  const levels: Record<string, Level> = { ...DEFAULT_LEVELS };
  for (const [k, v] of Object.entries(local.levels ?? {})) if (k in levels && (v === 'block' || v === 'warn' || v === 'off')) levels[k] = v;
  // The paths are the ones the session-start hook tells (core/result-paths.ts): one reader for both.
  return { on: guardsOn(root), levels, ...readResultPaths(root), secretaryDir: root };
}

/** How many calls of one kind in one turn bring the repeat reminder (repeat-hook.ts), unless this PC's settings say otherwise. */
export const DEFAULT_REPEAT_LIMIT = 10;

/**
 * The repeat reminder's count for this copy: this-secretary.local.json mistake-guards `repeatLimit` (a whole number of at least 2;
 * 0 turns it off), else DEFAULT_REPEAT_LIMIT. 0 as well when the feature is off.
 */
export function repeatLimit(root = PROJECT_ROOT): number {
  if (!guardsOn(root)) return 0;
  const v = localSection(root).repeatLimit;
  if (v === 0) return 0;
  return typeof v === 'number' && Number.isInteger(v) && v >= 2 ? v : DEFAULT_REPEAT_LIMIT;
}

/** The top-level entries of aiRoot now (lower case), for telling a new folder from one that is there. */
export function topEntries(aiRoot: string): Set<string> {
  try {
    return new Set(fs.readdirSync(aiRoot).map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}
