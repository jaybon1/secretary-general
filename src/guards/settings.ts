/**
 * 실수 막기 장치(기능 'guards')의 설정: 기능이 켜졌는지, 검사마다 막을지·알릴지(수준), 결과물 상위 폴더와 그 다른 PC 경로·폰 주소.
 *
 * - 결과물 상위 폴더(aiRoot)는 비서 폴더의 상위 폴더다(원본에서 ai-agent).
 * - 다른 PC에서 같은 폴더를 여는 경로(otherPcRoot)는 이 PC 전용 파일 scripts/guards.local.json에만 둔다(커밋하지 않는다).
 *   없으면 경로 짝 검사와 다른 PC 미리보기 주소 검사를 건너뛴다.
 * - 폰으로 여는 주소는 대시보드 설정(scripts/dashboard.local.json의 publicUrl, 기능 'dashboard'가 켜졌을 때)에서 읽는다.
 *
 * scripts/guards.local.json (칸은 모두 선택):
 *   otherPcRoot  다른 PC에서 결과물 상위 폴더를 여는 경로, 예: "X:\\<상위 폴더 이름>"
 *   levels       { 검사 id: "block" | "warn" | "off" } 기본 수준을 이 PC에서만 바꾼다
 *   repeatLimit  한 턴에 같은 종류 조작이 몇 번 되풀이되면 되풀이 점검 알림을 띄울지(기본 10, 0이면 끔. repeat-hook.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { readLocalJson } from '../core/local-file.ts';
import { featureOn, readFeatures } from '../setup/features.ts';

export const FEATURE_ID = 'guards';
export const LOCAL_FILE = 'scripts/guards.local.json';

export type Level = 'block' | 'warn' | 'off';

/**
 * Each check's level. block: the Stop hook sends the turn back with the reason (the model writes again, once). warn: the
 * turn ends as it is, the next prompt carries the reason (fixed first at the top of the next answer), and the turn record
 * keeps it. Either way the slip goes into the mistakes record (stop-guard.ts recordGuardMistakes).
 * English and the answer's form block (decided 2026-11-07): a result path's other-PC line and its tap-to-open link line
 * to the phone address (no phone address code line since 2026-11-07), each path in a code block of its own, the closing "다음 행동 및 순서:" line, and "남은 질문:" under labelled questions. A path in a sentence and a
 * local "?" only warn: those checks can be wrong about a path (a rule quoted, a settings file).
 */
export const DEFAULT_LEVELS: Record<string, Level> = {
  english: 'block',
  'path-prose': 'warn',
  'path-preview': 'warn',
  'path-pair': 'block',
  'path-link': 'block',
  // This PC's and the other PC's path in one code block (decided 2026-11-07: each path in a block of its own). Sent back
  // like the other form checks: its paths are written again apart (stop-guard.ts FILL_HINTS), the same turn.
  'path-block': 'block',
  'next-action': 'block',
  'open-questions': 'block',
  // The "근거:" line right under an option marked "(추천)" (decided 2026-11-07, after a pick recommended unchecked).
  'recommend-basis': 'block',
};

export interface GuardSettings {
  on: boolean;
  levels: Record<string, Level>;
  /** The folder results live under (the secretary's parent folder). */
  aiRoot: string;
  /** The same folder from the other PC, or null when not set here. */
  otherPcRoot: string | null;
  /** The address a phone opens the same folder at (…/share/<name>), or null. */
  phoneRoot: string | null;
  /** The secretary's own folder (its paths are code and settings, never results to pair). */
  secretaryDir?: string;
}

/** Whether the feature is on in this copy's features.json (on without the file, like every feature). */
export function guardsOn(root = PROJECT_ROOT): boolean {
  const f = (readFeatures(root) ?? []).find((x) => x.id === FEATURE_ID);
  return !f || featureOn(f);
}

/** The dashboard's phone address for aiRoot, read without loading the dashboard (null when it is off or has no publicUrl). */
function phoneRootFor(root: string, aiRoot: string): string | null {
  const dash = (readFeatures(root) ?? []).find((x) => x.id === 'dashboard');
  if (dash && !featureOn(dash)) return null;
  const r = readLocalJson<{ publicUrl?: unknown; share?: Record<string, unknown> }>(path.join(root, 'scripts', 'dashboard.local.json'));
  const url = r.ok && typeof r.value?.publicUrl === 'string' && /^https?:\/\/[^\s/]+\/?$/.test(r.value.publicUrl) ? r.value.publicUrl.replace(/\/$/, '') : null;
  if (!url) return null;
  // The default share is the secretary's parent folder under its own name (src/dashboard/settings.ts defaultShare).
  let name = path.basename(aiRoot);
  const share = r.ok ? r.value?.share : undefined;
  if (share && typeof share === 'object') {
    for (const [n, dir] of Object.entries(share)) if (typeof dir === 'string' && path.resolve(root, dir).toLowerCase() === aiRoot.toLowerCase()) name = n;
  }
  return `${url}/share/${encodeURIComponent(name)}`;
}

export function readGuardSettings(root = PROJECT_ROOT): GuardSettings {
  const aiRoot = path.dirname(root);
  const r = readLocalJson<{ otherPcRoot?: unknown; levels?: Record<string, unknown> }>(path.join(root, ...LOCAL_FILE.split('/')));
  const local = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  const levels = { ...DEFAULT_LEVELS };
  for (const [k, v] of Object.entries(local.levels ?? {})) if (k in levels && (v === 'block' || v === 'warn' || v === 'off')) levels[k] = v;
  const other = typeof local.otherPcRoot === 'string' && local.otherPcRoot.trim() ? local.otherPcRoot.trim().replace(/[\\/]+$/, '') : null;
  return { on: guardsOn(root), levels, aiRoot, otherPcRoot: other, phoneRoot: phoneRootFor(root, aiRoot), secretaryDir: root };
}

/** How many calls of one kind in one turn bring the repeat reminder (repeat-hook.ts), unless guards.local.json says otherwise. */
export const DEFAULT_REPEAT_LIMIT = 10;

/**
 * The repeat reminder's count for this copy: scripts/guards.local.json `repeatLimit` (a whole number of at least 2; 0
 * turns it off), else DEFAULT_REPEAT_LIMIT. 0 as well when the feature is off.
 */
export function repeatLimit(root = PROJECT_ROOT): number {
  if (!guardsOn(root)) return 0;
  const r = readLocalJson<{ repeatLimit?: unknown }>(path.join(root, ...LOCAL_FILE.split('/')));
  const v = r.ok && r.value && typeof r.value === 'object' ? r.value.repeatLimit : undefined;
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
