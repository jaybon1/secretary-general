/**
 * 결과물 경로를 붙일 때 쓰는 이 PC의 값 세 가지를 한 곳에서 읽는다. SessionStart 훅이 `<secretary-paths>`로 알려 주고
 * (AGENTS.md "경로를 붙인다" 줄은 이 값을 쓰고 경로를 글로 적지 않는다), 실수 막기의 경로 짝·링크 검사
 * (mistake-guards/answer-checks.ts)도 같은 값을 쓴다.
 *
 * - aiRoot: 결과물 상위 폴더 = 비서 폴더의 상위 폴더(원본에서 ai-agent).
 * - otherPcRoot: 다른 PC에서 같은 폴더를 여는 경로. 이 비서 전용 설정 this-secretary.local.json의 paths 키 otherPcRoot(커밋하지 않음, core/this-secretary.ts).
 * - phoneRoot: 폰으로 여는 주소. 같은 파일 dashboard 키의 publicUrl + /share/<이름>(기능 'dashboard'가 켜졌을 때).
 * 값이 없으면 null: 그 블록(다른 PC 경로 줄, 링크 줄)는 붙이지 않고 그 검사도 건너뛴다.
 */
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { FEATURE } from './names.ts';
import { PATHS_SECTION, readThisSecretary } from './this-secretary.ts';

export interface ResultPaths {
  /** The folder results live under (the secretary's parent folder). */
  aiRoot: string;
  /** The same folder from the other PC, or null when not set here. */
  otherPcRoot: string | null;
  /** The address a phone opens the same folder at (…/share/<name>), or null. */
  phoneRoot: string | null;
}

/** The dashboard's phone address for aiRoot, read without loading the dashboard (null when it is off or has no publicUrl). */
function phoneRootFor(root: string, aiRoot: string): string | null {
  // The dashboard's section reads as missing while the feature is off (core/this-secretary.ts).
  const r = readThisSecretary<{ publicUrl?: unknown; share?: Record<string, unknown> }>(FEATURE.dashboard, { root });
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

export function readResultPaths(root = PROJECT_ROOT): ResultPaths {
  const aiRoot = path.dirname(root);
  const r = readThisSecretary<{ otherPcRoot?: unknown }>(PATHS_SECTION, { root });
  const v = r.ok && r.value && typeof r.value === 'object' ? r.value.otherPcRoot : undefined;
  const otherPcRoot = typeof v === 'string' && v.trim() ? v.trim().replace(/[\\/]+$/, '') : null;
  return { aiRoot, otherPcRoot, phoneRoot: phoneRootFor(root, aiRoot) };
}
