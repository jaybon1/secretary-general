/**
 * What the session-start hook injects: the core profile, the big-work board, a status line, and for a new
 * conversation the situation board (started here, injected on the first prompt by board/board-notice.ts).
 * The memories injected on every prompt are in prompt-memory.ts.
 */
import { startBoardUpdate } from '../board/situation-board.ts';
import { continuityContext } from '../board/board-notice.ts';
import { renderBigWork, type Store } from '../store/store.ts';
import { estimateTokens } from '../core/tokens.ts';
import { formatLocal } from '../core/kst-time.ts';
import { accountLabel, chatProvider } from '../usage/files.ts';

/** SessionStart sources after which earlier injections are no longer in context. */
const CONTEXT_RESETS = new Set(['clear', 'compact']);

export function sessionStartContext(store: Store, sessionId?: string, source?: string): string {
  if (sessionId && source && CONTEXT_RESETS.has(source)) store.logUsage('context_reset', 0, { session: sessionId, source });
  const profile = store.getProfile();
  const s = store.stats();
  const parts = [
    '<secretary-profile>',
    profile
      ? `핵심 프로필 v${profile.version} (${formatLocal(profile.created_at, true)} 갱신)\n${profile.content}`
      : '핵심 프로필이 아직 없습니다. 첫 대화라면 사용자 이름·부를 호칭·핵심 선호를 짧게 묻고 update_profile 도구로 만들어 주세요.',
    '</secretary-profile>',
    bigWorkBlock(store),
    `<secretary-status>${chatProvider() === 'subscription' ? '' : `이 세션: ${accountLabel(chatProvider())} · `}활성 기억 ${s.memoriesActive}개 · 정리 대기 대화 ${s.unconsolidated}건</secretary-status>`,
  ];
  // A brand-new conversation (not a resume or compaction) wakes up with the situation board, which the
  // first prompt brings up to date and injects; without a session id, the plain pointers.
  if (!source || source === 'startup' || source === 'clear') {
    if (sessionId) startBoardUpdate(store, sessionId);
    else {
      const continuity = continuityContext(store);
      if (continuity) parts.push(continuity);
    }
  }
  const text = parts.join('\n');
  store.logUsage('session_start', estimateTokens(text), { profileVersion: profile?.version ?? 0 });
  return text;
}

/** Read from the DB at every session start, so a /clear or compact right after a change already sees it. */
export function bigWorkBlock(store: Store): string {
  const rows = store.bigWork();
  return [
    '<secretary-big-work>',
    rows.length
      ? `큰 일 판 (상태가 바뀌면 그 자리에서 set_big_work로 한 줄씩 고친다. 판에 있는 줄은 seen_id에 줄 앞 [#번호]를 넣는다)\n${renderBigWork(rows, { ids: true })}`
      : '큰 일 판이 비어 있어요. 큰 일이 시작되면 set_big_work로 넣어 주세요.',
    '</secretary-big-work>',
  ].join('\n');
}
