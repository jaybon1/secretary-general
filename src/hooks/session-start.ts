/**
 * What the session-start hook injects: the core profile, the big-work board, a status line, this PC's result paths when
 * set (resultPathsBlock), and for a new
 * conversation the situation board (started here, injected on the first prompt by session-continuity/situation-board-notice.ts).
 * The memories injected on every prompt are in prompt-memory.ts.
 */
import { startBoardUpdate } from '../session-continuity/situation-board.ts';
import { continuityContext } from '../session-continuity/situation-board-notice.ts';
import { renderBigWork, type Store } from '../store/store.ts';
import { estimateTokens } from '../core/token-estimate.ts';
import { formatLocal } from '../core/kst-time.ts';
import { accountLabel, chatProvider } from '../usage/usage-files.ts';
import { TAG } from '../core/names.ts';
import { readResultPaths, type ResultPaths } from '../core/result-paths.ts';

/** SessionStart sources after which earlier injections are no longer in context. */
const CONTEXT_RESETS = new Set(['clear', 'compact']);

export function sessionStartContext(store: Store, sessionId?: string, source?: string): string {
  if (sessionId && source && CONTEXT_RESETS.has(source)) store.logUsage('context_reset', 0, { session: sessionId, source });
  const profile = store.getProfile();
  const s = store.stats();
  const parts = [
    `<${TAG.profile}>`,
    profile
      ? `핵심 프로필 v${profile.version} (${formatLocal(profile.created_at, true)} 갱신)\n${profile.content}`
      : '핵심 프로필이 아직 없습니다. 첫 대화라면 사용자 이름·부를 호칭·핵심 선호를 짧게 묻고 update_profile 도구로 만들어 주세요.',
    `</${TAG.profile}>`,
    bigWorkBlock(store),
    `<${TAG.status}>${chatProvider() === 'subscription' ? '' : `이 세션: ${accountLabel(chatProvider())} · `}활성 기억 ${s.memoriesActive}개 · 정리 대기 대화 ${s.unconsolidated}건</${TAG.status}>`,
  ];
  const paths = resultPathsBlock(readResultPaths());
  if (paths) parts.push(paths);
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

/**
 * This PC's result paths for the AGENTS.md line on attaching paths (core/result-paths.ts: this PC's results folder, the
 * other PC's path to it, the phone address), so the rules carry no PC's path. '' when neither the other PC's path nor the
 * phone address is set (a release as installed): the answer then gives this PC's path only, as before.
 */
export function resultPathsBlock(p: ResultPaths): string {
  if (!p.otherPcRoot && !p.phoneRoot) return '';
  const parts = [`이 PC: ${p.aiRoot}`, ...(p.otherPcRoot ? [`다른 PC: ${p.otherPcRoot}`] : []), ...(p.phoneRoot ? [`폰 주소: ${p.phoneRoot}`] : [])];
  return [
    `<${TAG.resultPaths}>`,
    `결과물 상위 폴더(이 PC 전용 설정에서 읽음, 그 안 경로는 이 셋을 앞에 붙여 바꿔 쓴다): ${parts.join(' · ')}`,
    `</${TAG.resultPaths}>`,
  ].join('\n');
}

/** Read from the DB at every session start, so a /clear or compact right after a change already sees it. */
export function bigWorkBlock(store: Store): string {
  const rows = store.bigWork();
  return [
    `<${TAG.bigWork}>`,
    rows.length
      ? `큰 일 판 (상태가 바뀌면 그 자리에서 set_big_work로 한 줄씩 고친다. 판에 있는 줄은 seen_id에 줄 앞 [#번호]를 넣는다)\n${renderBigWork(rows, { ids: true })}`
      : '큰 일 판이 비어 있어요. 큰 일이 시작되면 set_big_work로 넣어 주세요.',
    `</${TAG.bigWork}>`,
  ].join('\n');
}
