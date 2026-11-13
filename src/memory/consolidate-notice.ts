/**
 * Memory consolidation as the chat sees it (prompt hook notice 'consolidate'): the reports a background
 * consolidation left in the DB, handed over when the user says "기억 정리 확인", and the fallback /consolidate
 * nudge when too much talk waits unconsolidated. The run itself is memory/consolidate-run.ts (started by the idle jobs or by\r
 * /consolidate); the steps are the consolidate skill's references/procedure.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { hookNoticeText } from '../core/hook-notice-text.ts';
import { personText } from '../hooks/prompt-sender.ts';
import type { Store } from '../store/store.ts';
import { formatLocal } from '../core/kst-time.ts';
import { TAG } from '../core/names.ts';

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
  /** Who started it: the idle jobs, or the user's /consolidate (absent in reports from before 2026-11-09). */
  by?: 'idle' | 'manual';
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

const RULES_SIZE_KEY = 'consolidate_rules_chars';

/**
 * AGENTS.md's size now and at the last report handed over (decided 2026-11-12: no limit on the rules file, the growth is
 * only told at each report so a line that belongs in a hook notice or a skill is noticed). '' when the file cannot be read.
 */
export function rulesSizeLine(store: Store, root = PROJECT_ROOT): string {
  let chars: number;
  try {
    chars = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').length;
  } catch {
    return '';
  }
  const last = store.getJson<number>(RULES_SIZE_KEY);
  store.setJson(RULES_SIZE_KEY, chars);
  const diff = typeof last === 'number' ? chars - last : null;
  const since = diff === null ? '지난 보고 때 기록 없음' : diff === 0 ? '지난 보고 때와 같음' : `지난 보고 때 ${last}자, ${diff > 0 ? '+' : ''}${diff}자`;
  return `규칙 파일 크기: AGENTS.md ${chars}자 (${since})`;
}

/**
 * Prompt hook. With reports waiting: a "기억 정리 확인" prompt gets them (and clears them); any other
 * prompt gets, once per session per new report, the one line to put above the /compact·/clear nudge.
 */
export function consolidateNotice(store: Store, sessionId: string, prompt: string): string {
  const reports = unseenReports(store);
  if (reports.length === 0) return '';
  // The person's typed words only: a report or task notice may quote "기억 정리 확인".
  if (isConsolidateConfirm(personText(prompt))) {
    store.deleteMeta(REPORTS_KEY);
    return [
      `<${TAG.consolidateReport}>`,
      '기억 정리(쉬는 시간 정리나 /consolidate)의 보고다. 사용자가 "기억 정리 확인"을 청했다. 사용자는 이 보고를 아직 못 봤으니, 먼저 보고마다 처리 범위와 새 기억·대체 개수(보고 끝 "[프로그램이 센 이번 정리 결과]" 줄의 숫자)를 쓰고, 보고에 적힌 새 기억·대체·고친 안건을 줄마다 내용이 드러나게 빠짐없이 보여 준다(실패한 보고는 이유를 그대로 전한다). 그 아래 "새 기억 번호:" 줄에 있는데 보고 목록에 없는 기억은 recall(ids)로 찾아 함께 보여 준다.',
      // What to do with a report: .agents/hook-notices/memory-consolidation-report.md (core/hook-notice-text.ts).
      hookNoticeText('memory-consolidation-report', 'todo'),
      rulesSizeLine(store),
      ...reports.map((r) => `\n[${formatLocal(r.at)} ${r.by === 'manual' ? '/consolidate ' : r.by === 'idle' ? '쉬는 시간 ' : ''}정리 ${r.ok ? '끝남' : '실패'} · 대화 #${r.fromLogId + 1}~#${r.throughLogId}]\n${r.text}`),
      `</${TAG.consolidateReport}>`,
    ].join('\n');
  }
  if (!store.markOnce(NOTICED_PREFIX + sessionId, reports[reports.length - 1].at)) return '';
  const failed = reports.filter((r) => !r.ok);
  const line = failed.length
    ? `기억 정리가 실패했어요(${failed[failed.length - 1].text.slice(0, 80)}). 확인하려면 '기억 정리 확인'만 보내 주세요.`
    : `기억 정리가 끝났어요${reports.length > 1 ? `(${reports.length}번)` : ''}. 확인하려면 '기억 정리 확인'만 보내 주세요.`;
  return `<${TAG.consolidate}>기억 정리 보고가 기다린다. 답 끝("다음 행동" 위, /compact·/clear 안내가 있으면 그 윗줄)에 "${line}" 한 줄을 붙인다.</${TAG.consolidate}>`;
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
  return `<${TAG.consolidate}>정리 안 된 대화가 ${pending}건인데 쉬는 시간 자동 정리가 아직 돌지 않았다(대화가 30분 넘게 멈춘 적이 없거나, 예약 작업 'Secretary Idle Jobs (비서 고유 번호)'가 없거나 실패). 답 끝("다음 행동" 위, /compact·/clear 안내가 있으면 그 윗줄)에 "정리 안 된 대화가 ${pending}건 쌓였는데 자동 정리가 아직 안 돌았어요. 적당할 때 /consolidate 하세요." 한 줄을 붙인다.</${TAG.consolidate}>`;
}
