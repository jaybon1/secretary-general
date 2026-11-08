/**
 * Memory consolidation as the chat sees it (prompt hook notice 'consolidate'): the reports a background
 * consolidation left in the DB, handed over when the user says "기억 정리 확인", and the fallback /consolidate
 * nudge when too much talk waits unconsolidated. The run itself is the idle jobs' (idle/idle-jobs.ts);
 * the steps are the consolidate skill's.
 */
import { personText } from '../hooks/prompt-sender.ts';
import type { Store } from '../store/store.ts';
import { formatLocal } from '../core/kst-time.ts';
import { staleReviewLines } from '../workspace/review-check.ts';

const REPORTS_KEY = 'consolidate_reports';
const NOTICED_PREFIX = 'consolidate_noticed:';
const NUDGED_PREFIX = 'consolidate_nudged:';
/** Per-session "told once" marks of this file, for the idle tick's housekeeping. */
export const CONSOLIDATE_MARK_PREFIXES = [NUDGED_PREFIX, NOTICED_PREFIX];
/**
 * "기억 정리 확인" as the whole message: with every space taken out (around and inside) it is exactly "기억정리확인"
 * (2026-11-06: was "정리 확인", made strict so it never fires by chance; the old phrase is ordinary talk now).
 * Inside a sentence ("기억 정리 확인해 줘") or quoted, it is ordinary talk.
 */
export function isConsolidateConfirm(text: string): boolean {
  return text.normalize('NFC').replace(/\s+/g, '') === '기억정리확인';
}

export interface ConsolidateReport {
  at: string;
  ok: boolean;
  /** The consolidation's final message (its report), or the failure reason. */
  text: string;
  fromLogId: number;
  throughLogId: number;
}

export function unseenReports(store: Store): ConsolidateReport[] {
  return store.getJson<ConsolidateReport[]>(REPORTS_KEY) ?? [];
}

/** Keeps a finished consolidation's report until "기억 정리 확인". */
export function saveConsolidateReport(store: Store, report: ConsolidateReport): void {
  store.setJson(REPORTS_KEY, [...unseenReports(store), report]);
}

/**
 * Prompt hook. With reports waiting: a "기억 정리 확인" prompt gets them (and clears them); any other
 * prompt gets, once per session per new report, the one line to put above the /clear nudge.
 */
export function consolidateNotice(store: Store, sessionId: string, prompt: string): string {
  const reports = unseenReports(store);
  if (reports.length === 0) return '';
  // The person's typed words only: a report or task notice may quote "기억 정리 확인".
  if (isConsolidateConfirm(personText(prompt))) {
    store.deleteMeta(REPORTS_KEY);
    return [
      '<secretary-consolidate-report>',
      '쉬는 시간 기억 정리의 보고다. 사용자가 "기억 정리 확인"을 청했다. 사용자는 이 보고를 아직 못 봤으니, 먼저 보고마다 처리 범위와 새 기억·대체 개수, 고친 큰 일을 짧게 요약해 보여 준다(실패한 보고는 이유를 그대로 전한다).',
      '이어서 AGENTS.md "/consolidate 결과가 오면"의 네 가지를 한다: get_profile 전체와 list_big_work 전체를 줄마다 번호 붙여 보여 주고(보고에서 "(바뀜)"인 줄 표시) 뺄 줄이 있는지 묻기, 개선 후보 번호 붙여 제안, 오래된 할 일 고르기, 아래에 "검수 대기 3일 넘은 업무"가 있으면 다시 묻기. 보고의 남은 질문도 이어 묻는다.',
      ...reports.map((r) => `\n[${formatLocal(r.at)} 정리 ${r.ok ? '끝남' : '실패'} · 대화 #${r.fromLogId + 1}~#${r.throughLogId}]\n${r.text}`),
      ...staleReviewLines(store).map((l, i) => (i === 0 ? `\n${l}` : l)),
      '</secretary-consolidate-report>',
    ].join('\n');
  }
  if (!store.markOnce(NOTICED_PREFIX + sessionId, reports[reports.length - 1].at)) return '';
  const failed = reports.filter((r) => !r.ok);
  const line = failed.length
    ? `기억 정리가 실패했어요(${failed[failed.length - 1].text.slice(0, 80)}). 확인하려면 '기억 정리 확인'만 보내 주세요.`
    : `기억 정리가 끝났어요${reports.length > 1 ? `(${reports.length}번)` : ''}. 확인하려면 '기억 정리 확인'만 보내 주세요.`;
  return `<secretary-consolidate>쉬는 시간 기억 정리 보고가 기다린다. 답 끝("다음 행동" 위, /clear 안내가 있으면 그 윗줄)에 "${line}" 한 줄을 붙인다.</secretary-consolidate>`;
}

/** Consolidations waiting, counted in steps of this many entries for the fallback nudge below. */
export const CONSOLIDATE_STEP = 60;
/**
 * The /consolidate nudge is only a fallback for the idle consolidation: once per session at every
 * CONSOLIDATE_STEP entries, starting at twice the step, when the idle job has evidently not run
 * (talk never paused 30 minutes, the scheduled task is missing, or it keeps failing).
 */
const FALLBACK_STEPS = 2;

export function consolidateNudge(store: Store, sessionId: string): string {
  const pending = store.stats().unconsolidated;
  const step = Math.floor(pending / CONSOLIDATE_STEP);
  if (step < FALLBACK_STEPS) return '';
  // The stored step belongs to one consolidation point; after a /consolidate the count starts over.
  const through = String(store.consolidatedThrough());
  const covered = (last: string) => {
    const [at, seen] = last.split(':');
    return at === through && Number(seen) >= step;
  };
  if (!store.markOnce(NUDGED_PREFIX + sessionId, `${through}:${step}`, covered)) return '';
  return `<secretary-consolidate>정리 안 된 대화가 ${pending}건인데 쉬는 시간 자동 정리가 아직 돌지 않았다(대화가 30분 넘게 멈춘 적이 없거나, 예약 작업 'Secretary Idle Jobs (비서 고유 번호)'가 없거나 실패). 답 끝("다음 행동" 위, /clear 안내가 있으면 그 윗줄)에 "정리 안 된 대화가 ${pending}건 쌓였는데 자동 정리가 아직 안 돌았어요. 적당할 때 /consolidate 하세요." 한 줄을 붙인다.</secretary-consolidate>`;
}
