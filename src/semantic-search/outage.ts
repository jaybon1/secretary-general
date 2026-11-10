/**
 * 의미 검색 서버의 장애 기록과 알림: 실패·회복을 장애 파일과 실패 기록에 남기고, 원인을 짐작하고, 세션마다 한 번 알릴 글(outageNotice)을 만든다.
 * 설계 전체 설명은 semantic-search/client.ts 맨 위에 있다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disabled, DOWN_FILE, FAILURE_LOG, FAILURE_LOG_LINES, SERVER_NEED_MB, MEMORY_FILE, MODEL_FILES, MODEL_PATH, readState } from './config.ts';
import { SCRIPTS } from '../core/paths.ts';
import { formatLocal } from '../core/kst-time.ts';
import { readJsonFile } from '../core/json-file.ts';
import { pidAlive } from '../core/windows-process.ts';
import { TAG } from '../core/names.ts';

/** Written on a real failure; deleted by the server once it answers. */
export interface DownState {
  /** When the first failure of this outage happened. */
  since: string;
  failedAt: string;
  /** First line of the last failure. */
  error: string;
  /** Failures in a row in this outage. */
  failures: number;
  /** Sessions already told about this outage. */
  told: string[];
  /** The model files were downloaded again in this outage (that is done once). */
  refetched?: boolean;
  /** Still failing after the download: not restarted while the model files look like this (modelFingerprint). */
  stoppedAt?: string;
  /** Failed for lack of memory: not restarted until the user asks. Free memory then, and what the server needs. */
  lowMemory?: { freeMb: number; needMb: number };
}

export const readDown = () => readJsonFile<DownState>(DOWN_FILE);

// Best effort: the prompt hook runs these, and a failed write must not cost the memory injection.
// The worst case is a session told twice or a failure left out of the log.
export function writeDown(d: DownState): void {
  try {
    fs.writeFileSync(DOWN_FILE, JSON.stringify(d));
  } catch {}
}

function clearDown(): void {
  try {
    fs.rmSync(DOWN_FILE, { force: true });
  } catch {}
}

/** Appends one line to the failure log, keeping the last FAILURE_LOG_LINES. */
export function logLine(now: number, text: string): void {
  try {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(FAILURE_LOG, 'utf8').split('\n').filter(Boolean);
    } catch {}
    lines.push(`${formatLocal(now, false, true)} ${text}`);
    fs.writeFileSync(FAILURE_LOG, lines.slice(-FAILURE_LOG_LINES).join('\n') + '\n');
  } catch {}
}

/** What the server needs: its own last recorded peak, else the measured constant. */
export function serverNeedMb(): number {
  const n = readJsonFile<{ needMb: number }>(MEMORY_FILE)?.needMb;
  return typeof n === 'number' && n > 0 ? n : SERVER_NEED_MB;
}

/** Free physical memory in MB; SECRETARY_TEST_FREE_MB stands in for it in tests. */
export function freeMemMb(): number {
  const v = Number(process.env.SECRETARY_TEST_FREE_MB);
  return v > 0 ? v : Math.round(os.freemem() / 2 ** 20);
}

const firstLine = (s: string) => s.split('\n')[0].slice(0, 300).replace(/\.$/, '');

/** A guess at the cause from the error text and free memory, so the log can be read without the stack. */
export function failureCause(error: string, freeMb: number): string {
  if (error.startsWith(REFETCH_FAILED)) return REFETCH_FAILED;
  if (/bad_alloc|out of memory|ENOMEM|failed to allocate|allocation failed/i.test(error)) return '메모리 부족';
  if (/onnxruntime_binding|ERR_DLOPEN_FAILED|\.dll|specified module could not be found/i.test(error)) return '실행 라이브러리 로드 실패(VC++ 재배포 패키지?)';
  if (/Could not locate file|ENOENT|no such file|not found/i.test(error)) return '모델 파일 없음';
  if (/protobuf|corrupt|invalid model|Load model .* failed|Unexpected end|JSON/i.test(error)) return '모델 파일 깨짐';
  const low = freeMb < serverNeedMb();
  if (/^비정상 종료/.test(error)) return low ? '비정상 종료(메모리 부족 의심)' : '비정상 종료';
  return low ? '원인 미상(메모리 부족 의심)' : '원인 미상';
}

export const REFETCH_FAILED = '모델 다시 받기 실패';
export const isModelCause = (error: string) => ['모델 파일 없음', '모델 파일 깨짐', REFETCH_FAILED].includes(failureCause(error, Infinity));
export const STOPPED_NOTE = '다시 받았는데도 실패, 사용자 확인 필요';
export const LOW_MEMORY_NOTE = '메모리 부족으로 멈춤, 사용자 확인 필요';

/** Size and time of each model file: a change means someone replaced them, worth another try. */
export function modelFingerprint(): string {
  return MODEL_FILES.map((f) => {
    try {
      const st = fs.statSync(path.join(MODEL_PATH, f));
      return `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return '-';
    }
  }).join('|');
}

/**
 * Records a real failure: the down file (so sessions are told) and a line in the failure log.
 * A model failure after the files were downloaded again, or a lack of memory, stops the restarts,
 * and every session is told anew.
 */
export function noteFailure(err: unknown, now = Date.now(), freeMb = freeMemMb()): DownState {
  const down = readDown();
  const at = new Date(now).toISOString();
  const error = firstLine(err instanceof Error ? err.message : String(err));
  const next: DownState = { ...down, since: down?.since ?? at, failedAt: at, error, failures: (down?.failures ?? 0) + 1, told: down?.told ?? [] };
  const cause = failureCause(error, freeMb);
  const stop = !!next.refetched && isModelCause(error);
  if (stop) Object.assign(next, { stoppedAt: modelFingerprint(), told: [] });
  const lowMemory = cause.includes('메모리 부족');
  next.lowMemory = lowMemory ? { freeMb, needMb: serverNeedMb() } : undefined;
  if (lowMemory) next.told = [];
  writeDown(next);
  const note = stop ? ` · ${STOPPED_NOTE}` : lowMemory ? ` · ${LOW_MEMORY_NOTE}` : '';
  logLine(now, `실패 · 연속 ${next.failures}번째 · ${cause} · 남은 메모리 ${freeMb}MB · ${error}${note}`);
  return next;
}

/** The user asked to try again: allows one more start, and one more download if the model fails. */
export function retryServer(now = Date.now()): void {
  const down = readDown();
  if (!down?.stoppedAt && !down?.lowMemory) return;
  writeDown({ ...down, refetched: false, stoppedAt: undefined, lowMemory: undefined, told: [] });
  logLine(now, '사용자 요청으로 다시 시도');
}

/** Ends an outage: drops the down file and logs the recovery. No-op without an outage. */
export function noteRecovery(now = Date.now()): void {
  const down = readDown();
  if (!down) return;
  clearDown();
  logLine(now, `회복 · 연속 실패 ${down.failures}번 뒤`);
}

// ---- the notice ---------------------------------------------------------------

export const NOTICE = '의미 검색 서버가 꺼져 있어 다시 띄우는 중이에요. 살아날 때까지 기다려 주세요(그래도 진행하면 단어 검색만 씁니다)';
export const STOPPED_NOTICE = `의미 검색 서버가 모델 파일을 ${STOPPED_NOTE}. 다시 띄우지 않고 단어 검색만 씁니다`;

/** The ask after a lack of memory: what the server needs (rounded up) and what is free now. */
export function lowMemoryNotice(needMb: number, freeMb: number): string {
  const need = (Math.ceil(needMb / 102.4) / 10).toFixed(1);
  const free = (freeMb / 1024).toFixed(1);
  return `메모리가 부족해 의미 검색 서버가 꺼졌어요(의미 검색 서버에 약 ${need}GB 필요, 지금 남은 메모리 약 ${free}GB). 그동안 단어 검색만 씁니다. 다시 켤까요?`;
}

// What the secretary does with the notice. It rides along with the notice so the rule
// costs nothing in AGENTS.md while the server is healthy.
export const RESTART_GUIDE = `비서 할 일: 이 문구를 답 맨 위 한 줄로 알리고, \`node ${SCRIPTS.watchSemanticSearchServer}\`를 백그라운드 명령으로 띄워 두었다가 끝나면 그 출력 한 줄로 보고한다.`;
export const ASK_GUIDE = `비서 할 일: 이 문구를 답 맨 위 한 줄로 알리고, 감시는 띄우지 않고 다시 켤지 묻는다. 켜라고 하면 \`node ${SCRIPTS.watchSemanticSearchServer} --retry\`를 백그라운드로 띄운다.`;
const CAUSE_GUIDE = ' 원인을 물으면 `secretary.db.semantic-search-server-failures.log`를 읽어 정리해 답한다(모델 파일 문제면 의미 검색 서버가 모델을 한 번 다시 받고(약 1분) 그래도 실패하면 멈춘다. 메모리가 부족하면 바로 멈춘다).';

export function noticeTag(text: string, guide: string): string {
  return `<${TAG.semanticSearchServer}>${text} — ${guide}${CAUSE_GUIDE}</${TAG.semanticSearchServer}>`;
}

/**
 * One line for the prompt hook during a real outage, once per session; '' otherwise
 * (no outage, or a server that only idled out). Call it after the search.
 */
export function outageNotice(sessionId: string, now = Date.now()): string {
  if (disabled()) return '';
  const down = readDown();
  if (!down) return '';
  try {
    const state = readState();
    if (state?.port != null && pidAlive(state.pid)) {
      // Up already, but the server's own recovery note was missed: the outage is over.
      noteRecovery(now);
      return '';
    }
    if (down.told.includes(sessionId)) return '';
    writeDown({ ...down, told: [...down.told, sessionId] });
    if (down.lowMemory) return noticeTag(lowMemoryNotice(down.lowMemory.needMb, freeMemMb()), ASK_GUIDE);
    return down.stoppedAt ? noticeTag(STOPPED_NOTICE, ASK_GUIDE) : noticeTag(NOTICE, RESTART_GUIDE);
  } catch {
    // A hand-edited or half-written down file: say nothing rather than break the hook.
    return '';
  }
}
