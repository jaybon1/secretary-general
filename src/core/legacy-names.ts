/**
 * The old names the secretary still reads beside the new ones, in one table: what is read, when it can go, and the date
 * to look again. Each place in the code that reads one carries the mark `legacy-name: <id>` in a comment (so the table and
 * the code find each other: npm test, test/legacy-names.test.ts, fails on a mark without a row or a row without a mark,
 * and from a row's date on it says the row is due, without failing). Removing one: take out the reading at each mark,
 * then the row. Moving the date: change `checkBy` (and say why in `alsoWhen` if the condition changed).
 *
 * `feature` is the features.json feature whose files hold the marks: a copy without that feature (a release leaves some
 * out) is not asked for them.
 */
import { formatLocal } from './kst-time.ts';

export interface LegacyName {
  id: string;
  /** The old name still read, and the new one. */
  old: string;
  now: string;
  /** Which of the two kinds the old name is (LEGACY_KINDS): that says when its reading can go. */
  kind: LegacyKind;
  /** What must also be true first, when something must. */
  alsoWhen?: string;
  /** From this day (YYYY-MM-DD, KST) npm test says to look at the row again. */
  checkBy: string;
  feature: string;
}

/**
 * When a reading can go. Updates start from v0.11.0 (the release's scripts/update.mjs MIN_BASE), so what only users of
 * older versions had is gone already. A row is one of the two kinds:
 * - pc-only: only this PC ever had the old name (a release never did): it goes once this PC has moved over.
 * - release-move: release users have it too: the version that moves it keeps the reading, and it goes in a later version,
 *   after they updated to that one.
 */
export type LegacyKind = 'pc-only' | 'release-move';
export const LEGACY_KINDS: Record<LegacyKind, { label: string; when: string }> = {
  'pc-only': { label: '이 PC 전용', when: '이 PC가 새 이름으로 옮긴 뒤(배포판 사용자에게는 옛 이름이 없다)' },
  'release-move': { label: '배포판 옮기기', when: '옮기는 버전에 두고, 배포판 사용자들이 그 버전으로 올린 뒤 다음 버전에서(그 버전이 사용자의 옛 이름을 읽어 옮긴다)' },
};

/** When a row's reading can go, in a line: its kind, when that kind goes, and what must also be true first. */
export const removeWhen = (r: Pick<LegacyName, 'kind' | 'alsoWhen'>): string =>
  `[${LEGACY_KINDS[r.kind].label}] ${LEGACY_KINDS[r.kind].when}${r.alsoWhen ? ` — ${r.alsoWhen}` : ''}`;

export const LEGACY_NAMES: LegacyName[] = [
  {
    id: 'session-reuse-words',
    old: 'run-job·업무 세션 재사용 기록(run-job-calls.jsonl·worker-reuse.jsonl)의 새로 시작한 이유 옛 글자(2026-11-11 전) "문맥 초과"·"문맥 모름"·"이어 부르기 실패"',
    now: '"컨텍스트 초과"·"컨텍스트 모름"·"재사용 실패"(scripts/run-job/run-job.ps1, scripts/worker/worker-lib.ps1). 옛 이유는 run-job-stats.ps1이 새 이유와 같이 센다',
    kind: 'release-move',
    alsoWhen: 'run-job-stats.ps1이 보는 최근 기록에 옛 이유가 더 없을 때(기록 파일은 고치지 않는다. 모델을 고른 보기 -Model opus의 최근 50개에도 없을 때)',
    checkBy: '2027-02-10',
    feature: 'delegate',
  },
];

/** Today in KST, YYYY-MM-DD. */
export const todayKst = (now = Date.now()) => formatLocal(now, true);

/** The rows whose date has come (checkBy on or before today). */
export function dueLegacyNames(today = todayKst(), list: LegacyName[] = LEGACY_NAMES): LegacyName[] {
  return list.filter((r) => r.checkBy <= today);
}
