/** The "상태" text (bin/dashboard.mjs status --text): the dashboard's data as short lines the secretary summarizes. */
import type { Collected, Meter } from './collect.ts';

type Section<T> = { data?: T; error?: string };

export function statusText(d: Collected): string {
  const L: string[] = [];
  const section = <T>(title: string, r: Section<T>, fn: (data: T) => void) => {
    L.push(`[${title}]`);
    if (r.error !== undefined || r.data === undefined) L.push(`  ${r.error ?? '없음'}`);
    else fn(r.data);
  };
  const none = <T>(arr: T[], fn: (x: T) => void) => (arr.length ? arr.forEach(fn) : L.push('  없음'));
  const win = (w: Meter) => `${w.label} ${w.pct}%` + (w.passed ? ' (초기화 시각이 지나 옛 값)' : w.resetsAt ? ` (초기화 ${w.resetsAt}, ${w.left})` : '');

  L.push(`비서 상태 (한국시간 ${d.generatedAt})`);
  section('한도', d.limits, (a) =>
    none(a, (x) => {
      if ('none' in x) return void L.push(`  ${x.name}: 조회 안 됨`);
      if ('error' in x) return void L.push(`  ${x.name}: ${x.error}`);
      L.push(`  ${x.name}: ${x.meters.map(win).join(' / ') || '값 없음'} — 기록 ${x.updatedAt}(${x.updatedAgo})${x.stale ? ' ※오래된 값' : ''}`);
    }),
  );
  section('돌고 있는 업무 세션', d.workers, (w) => {
    none(w.running, (x) => L.push(`  ${x.name} (${x.account}, ${x.model}/${x.effort}) ${x.startedAt} 시작, ${x.startedAgo}`));
    if (w.orphan.length) L.push(`  기록만 남음(프로세스 없음): ${w.orphan.map((x) => x.name).join(', ')}`);
  });
  section('돌고 있는 run-job', d.runJobsActive, (r) =>
    none(r.running, (x) => L.push(`  ${x.account} ${x.model} ${x.folder} — ${x.label} (${x.startedAgo} 시작)`)),
  );
  section('최근 run-job', d.runJobsRecent, (r) =>
    none(r.slice(0, 5), (x) => L.push(`  ${x.at} ${x.account} ${x.model} ${x.folder} ${x.sec}초 $${(x.cost ?? 0).toFixed(2)}${x.error ? ' 오류' : ''}`)),
  );
  section('업무 칸반', d.kanban, (cols) => {
    L.push('  ' + cols.map((c) => `${c.label} ${c.total}`).join(' · '));
    for (const c of cols) if (c.status === 'ready' || c.status === 'running' || c.status === 'review' || c.status === 'failed') c.items.forEach((x) => L.push(`  - ${c.label}: #${x.id} ${x.title} (${x.ws})`));
    cols
      .filter((c) => c.status === 'done')
      .flatMap((c) => c.items.slice(0, 3))
      .forEach((x) => L.push(`  - 최근 끝남: #${x.id} ${x.title} (${x.updatedAt})`));
  });
  section('예약 작업', d.schedules, (s) =>
    none(s, (x) => L.push(`  ${x.name}: 다음 ${x.next ? `${x.next}(${x.nextLeft ?? '곧'})` : '없음'}, 마지막 ${x.last ?? '기록 없음'} ${x.result}`)),
  );
  return L.join('\n');
}
