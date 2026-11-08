/**
 * Handing the conversation to a new secretary session (the handoff skill): the new session opens with
 * HANDOFF_MARK, archives the old one, then runs `cli handoff-wake`, which logs the old session's last turn,
 * rewrites the board and hands it back to read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatLocal, nowIso } from '../core/kst-time.ts';
import { transcriptDirs } from '../log/catch-up.ts';
import { ingestTranscript } from '../log/ingest-transcript.ts';
import type { Store } from '../store/store.ts';
import { boardBlock } from './board-notice.ts';
import { BOARD_WAIT_MS, readBoard, runBoardUpdate, waitForJob } from './situation-board.ts';

export { HANDOFF_MARK } from './board-notice.ts';

/**
 * cli handoff-wake: the new session, after archiving the old one, logs the old session's
 * last turn, rewrites the board and gets it back to read.
 */
export async function handoffWake(store: Store, oldSessionId: string): Promise<string> {
  const files = transcriptDirs().map((d) => path.join(d, `${oldSessionId}.jsonl`)).filter((f) => fs.existsSync(f));
  if (files.length === 0) return `옛 세션 ${oldSessionId}의 대화 기록 파일을 찾지 못했다.`;
  const added = files.reduce((n, f) => n + ingestTranscript(store, f).added, 0);
  await waitForJob(store, BOARD_WAIT_MS);
  // Archiving happens before this call and is not in any transcript, so tell the rewrite.
  const job = await runBoardUpdate(store, [`${formatLocal(nowIso())} 새 세션이 옛 세션(대화 기록 ${oldSessionId.slice(0, 8)})이 멈춘 것을 확인하고 보관했다. 넘기기는 끝났다.`]);
  const board = readBoard(store);
  if (!board || !job.ok) return `상황판 갱신 실패: ${job.error ?? '상황판 없음'}`;
  return `(옛 세션 대화 ${added}개를 새로 저장함)\n${boardBlock(store, board)}`;
}
