/**
 * 기억 DB 한 번 정리(2026-11-18 사용자 결정, v0.12.0 전): 코드를 고쳐도 이미 DB에 들어간 것은 남아서 비서가 백업 뒤 한 번 돌린다.
 *   node src/memory/memory-cleanup.ts [--summary <옛 요약 번호>[:<그 요약을 대신하는 요약 번호>]]... [--db <DB 파일>] [--apply <승인 코드>]
 * 고칠 것은 셋이다.
 *   1. 살아 있는 기억의 내용 끝에 태그를 대괄호로 다시 적은 것(" [텃밭 업무 3]"): 떼고, 태그에 없는 낱말은 태그로 남긴다
 *      (store/tag-names.ts trailingTagBracket). 태그가 아닌 대괄호 글("[개선 후보]")은 그대로 두고 목록에만 보인다.
 *   2. 같은 대상을 다루는 옛 주제 요약: --summary로 고른 것만 무효 처리한다(":새 번호"를 주면 그 요약이 대신한다고 이어 둔다).
 *      고르는 데 쓰라고, 뜻이 가까운 살아 있는 요약 짝을 미리보기에 보인다.
 *   3. 대화(source_log_id·source_session)에 이어진 주제 요약: 요약은 정리 담당만 쓰는데, 옛 연결 단계가 그 시각의 대화 세션에
 *      이었다. 그 연결만 지운다(요약은 그대로).
 * --apply 없이 돌리면 고칠 줄을 모두 보이고 승인 코드(고칠 목록에서 만든 6글자)를 끝에 쓴다. 같은 목록일 때만 --apply <코드>로 쓴다
 * (그 사이 DB가 바뀌어 목록이 달라지면 코드가 맞지 않아 쓰지 않는다).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../store/schema.ts';
import { Store } from '../store/store.ts';
import { shownTags, trailingTagBracket } from '../store/tag-names.ts';
import { VECTOR_KEY } from '../semantic-search/config.ts';
import { DB_PATH } from '../core/config.ts';
import { formatLocal } from '../core/kst-time.ts';

/** Live topic summaries this close in meaning (vector dot) are shown as maybe covering the same thing. */
export const SUMMARY_PAIR_MIN_SIM = 0.8;

export interface CleanupPlan {
  brackets: Array<{ id: number; bracket: string; extra: string[] }>;
  /** Live memories ending in brackets that are not their tags: left as they are. */
  keptBrackets: Array<{ id: number; bracket: string }>;
  retire: Array<{ id: number; by: number | null; topic: string }>;
  /** Pairs of live summaries close in meaning, older first: candidates for --summary. */
  summaryPairs: Array<{ older: number; newer: number; sim: number; topics: [string, string] }>;
  links: Array<{ id: number; logId: number | null; session: string | null; live: boolean }>;
  code: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What the cleanup would change now; `retire` are the --summary choices ("1234" or "1234:1240"). Throws on a choice that is not a live summary. */
export function planCleanup(store: Store, retire: string[] = []): CleanupPlan {
  const db = store.db;
  const ending = db.prepare("SELECT id, content FROM memories WHERE valid_to IS NULL AND rtrim(content) LIKE '%]' ORDER BY id").all() as Array<{ id: number; content: string }>;
  const brackets: CleanupPlan['brackets'] = [];
  const keptBrackets: CleanupPlan['keptBrackets'] = [];
  for (const m of ending) {
    const cut = trailingTagBracket(m.content, store.tagsOf(m.id));
    if (cut) brackets.push({ id: m.id, bracket: cut.brackets.join(' '), extra: cut.extra });
    else {
      const bracket = /\[[^[\]\n]*\]\s*$/.exec(m.content)?.[0].trim();
      if (bracket) keptBrackets.push({ id: m.id, bracket });
    }
  }
  const chosen = retire.map((r) => {
    const [id, by] = r.split(':').map((x) => Number(x.replace(/^#/, '')));
    const m = store.getMemory(id);
    if (!m || m.kind !== 'summary' || m.valid_to) throw new Error(`#${id}은 살아 있는 주제 요약이 아님`);
    if (by !== undefined && !Number.isNaN(by)) {
      const b = store.getMemory(by);
      if (!b || b.kind !== 'summary' || b.valid_to || by === id) throw new Error(`#${by}은 #${id}을 대신할 살아 있는 주제 요약이 아님`);
      return { id, by, topic: m.topic };
    }
    return { id, by: null, topic: m.topic };
  });
  const summaries = new Map(store.listMemories({ kind: 'summary', limit: 1000 }).map((m) => [m.id, m]));
  const vecs = store.vectors(VECTOR_KEY).filter((v) => summaries.has(v.id));
  const summaryPairs: CleanupPlan['summaryPairs'] = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      let sim = 0;
      for (let k = 0; k < vecs[i].vector.length; k++) sim += vecs[i].vector[k] * vecs[j].vector[k];
      if (sim < SUMMARY_PAIR_MIN_SIM) continue;
      const [a, b] = [summaries.get(vecs[i].id)!, summaries.get(vecs[j].id)!].sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id - y.id);
      summaryPairs.push({ older: a.id, newer: b.id, sim, topics: [a.topic, b.topic] });
    }
  }
  summaryPairs.sort((a, b) => b.sim - a.sim);
  const links = (
    db.prepare("SELECT id, source_log_id, source_session, valid_to IS NULL AS live FROM memories WHERE kind = 'summary' AND source_session IS NOT NULL ORDER BY id").all() as Array<{
      id: number;
      source_log_id: number | null;
      source_session: string | null;
      live: number;
    }>
  ).map((r) => ({ id: r.id, logId: r.source_log_id, session: r.source_session, live: r.live === 1 }));
  const code = createHash('sha256')
    .update(JSON.stringify([brackets.map((b) => [b.id, b.bracket]), chosen, links.map((l) => l.id)]))
    .digest('hex')
    .slice(0, 6);
  return { brackets, keptBrackets, retire: chosen, summaryPairs, links, code };
}

/** The preview: every line it would change, then the approval code. */
export function renderPlan(store: Store, plan: CleanupPlan): string {
  const line = (id: number) => {
    const m = store.getMemory(id);
    return m ? `${m.kind} ${formatLocal(m.created_at, true)} [${shownTags(m)}] ${clip(m.content.replace(/\s+/g, ' '), 70)}` : '(없음)';
  };
  const out: string[] = [];
  out.push(`1. 내용 끝 대괄호 태그를 뗄 살아 있는 기억 ${plan.brackets.length}개(태그에 없는 낱말은 태그로 남김):`);
  for (const b of plan.brackets) out.push(`- #${b.id} 뗌 ${b.bracket}${b.extra.length ? ` → 태그에 더함: ${b.extra.join(', ')}` : ''}`);
  out.push(`   태그가 아니라 그대로 둘 대괄호 ${plan.keptBrackets.length}개: ${plan.keptBrackets.map((k) => `#${k.id} ${clip(k.bracket, 30)}`).join(' · ') || '없음'}`);
  out.push(`2. 무효 처리할 옛 주제 요약 ${plan.retire.length}개(--summary로 고른 것):`);
  for (const r of plan.retire) out.push(`- #${r.id} (${r.topic})${r.by ? ` → #${r.by}가 대신함` : ''}: ${line(r.id)}`);
  out.push(`   뜻이 가까운 살아 있는 요약 짝(점수 ${SUMMARY_PAIR_MIN_SIM} 이상, 옛것 먼저) ${plan.summaryPairs.length}개:`);
  for (const p of plan.summaryPairs) out.push(`   - #${p.older}(${p.topics[0]}) · #${p.newer}(${p.topics[1]}) 점수 ${p.sim.toFixed(3)}`);
  const live = plan.links.filter((l) => l.live).length;
  out.push(`3. 대화 연결을 지울 주제 요약 ${plan.links.length}개(살아 있는 것 ${live}개): ${plan.links.map((l) => `#${l.id}`).join(' ') || '없음'}`);
  out.push(`승인 코드: ${plan.code} (이 목록대로 쓰려면 같은 인자에 --apply ${plan.code})`);
  return out.join('\n');
}

export interface CleanupDone {
  brackets: number[];
  retired: number[];
  unlinked: number;
}

/** Writes a plan whose code is `code` (made again now: a DB changed since the preview gives another code and nothing is written). */
export function applyCleanup(store: Store, retire: string[], code: string): CleanupDone {
  const plan = planCleanup(store, retire);
  if (plan.code !== code) throw new Error(`승인 코드가 지금 목록(${plan.code})과 달라 쓰지 않았어요. 미리보기를 다시 보고 그 코드로 돌린다.`);
  const brackets = plan.brackets.filter((b) => store.stripTrailingTags(b.id)).map((b) => b.id);
  const retired = plan.retire
    .filter((r) => (r.by ? store.supersedeWith(r.id, r.by) : store.forget(r.id, '같은 대상을 다루는 겹친 옛 주제 요약(기억 DB 정리)')))
    .map((r) => r.id);
  const unlinked = store.unlinkSummaries(plan.links.map((l) => l.id));
  return { brackets, retired, unlinked };
}

export function main(argv: string[], out: (s: string) => void = console.log): number {
  const retire: string[] = [];
  let db = DB_PATH;
  let code: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--summary' && value) retire.push(value);
    else if (flag === '--db' && value) db = path.resolve(value);
    else if (flag === '--apply' && value) code = value;
    else {
      out('usage: node src/memory/memory-cleanup.ts [--summary <옛 요약 번호>[:<대신하는 요약 번호>]]... [--db <DB 파일>] [--apply <승인 코드>]');
      return 2;
    }
    i++;
  }
  const store = new Store(openDb(db));
  try {
    if (!code) {
      out(renderPlan(store, planCleanup(store, retire)));
      return 0;
    }
    const done = applyCleanup(store, retire, code);
    out(`정리함: 대괄호 태그 뗀 기억 ${done.brackets.length}개 · 무효 처리한 옛 요약 ${done.retired.map((i) => `#${i}`).join(' ') || '없음'} · 대화 연결 지운 요약 ${done.unlinked}개`);
    return 0;
  } finally {
    store.db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
