/**
 * One-off move of the profile's '큰 일 상태' section onto the big-work board (cli big-work-from-profile), for an
 * update from v7: before v8 the big works were a section of the core profile. Kept only in this release
 * (the original secretary moved its own profile once and dropped this code); the update skill runs it.
 * Preview writes a plan file the secretary checks and fixes by hand (each line's state is a judgement);
 * --apply puts the plan on the board and saves the profile without the section as a new version.
 */
import { BIG_WORK_LIMITS, BIG_WORK_STATES, renderBigWork, type BigWorkState } from '../store/big-work.ts';
import type { Store } from '../store/store.ts';

export interface PlanRow {
  name: string;
  state: BigWorkState | '?';
  note: string;
  /** The profile line it came from, so the check can be done without opening the profile. */
  from: string;
}

export interface MovePlan {
  profileVersion: number;
  section: string[];
  rows: PlanRow[];
  /** The profile with the section taken out; applied as-is. */
  newProfile: string;
}

const ACTIVE_STATES = BIG_WORK_STATES.slice(0, 4) as readonly BigWorkState[];
const HEADING = /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$|[^-*\s][^:]{0,30}:\s*$)/;
const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Splits on commas and semicolons outside parentheses (not on '·', which names use). */
function splitItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if ('(（['.includes(ch)) depth++;
    if (')）]'.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || ch === '，' || ch === ';')) {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

/** "이름 (메모)" → name and note; the note is the last parenthesised part. */
function nameNote(item: string): { name: string; note: string } {
  const m = item.match(/^(.*?)\s*[(（](.*)[)）]\s*$/);
  const clean = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return m ? { name: clean(m[1]), note: clean(m[2]) } : { name: clean(item), note: '' };
}

function findState(text: string): BigWorkState | undefined {
  return ACTIVE_STATES.find((s) => text.includes(s));
}

/** The section's lines: a heading naming 큰 일, then its list lines (blank lines inside allowed). */
export function findSection(profile: string): { start: number; end: number } | null {
  const lines = profile.split('\n');
  const start = lines.findIndex((l) => /큰\s*일/.test(l) && HEADING.test(l));
  if (start < 0) return null;
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (LIST.test(l) || /^\s{2,}\S/.test(l)) end = i + 1;
    else if (l.trim() === '') continue;
    else break;
  }
  return { start, end };
}

/**
 * Two shapes are read: grouped by state ("- 진행 중: A (메모), B") and one work per line
 * ("- A — 진행 중 (메모)"). Anything else becomes state '?' for the secretary to fill in.
 */
export function planFromProfile(profile: string, version: number): MovePlan {
  const sec = findSection(profile);
  if (!sec) throw new Error("프로필에서 '큰 일' 칸을 찾지 못했어요(제목 줄에 '큰 일'이 든 칸). 계획 파일을 손으로 만들어 --apply로 넣으세요.");
  const lines = profile.split('\n');
  const section = lines.slice(sec.start, sec.end);
  const rows: PlanRow[] = [];
  for (const raw of section.slice(1)) {
    if (!LIST.test(raw) && !/^\s{2,}\S/.test(raw)) continue;
    const line = raw.replace(LIST, '').trim();
    const grouped = line.match(/^\**\s*([^:：]{1,12}?)\s*\**\s*[:：]\s*(.+)$/);
    const groupState = grouped && findState(grouped[1]);
    if (grouped && groupState) {
      for (const item of splitItems(grouped[2])) if (!/^\(?없음\)?$/.test(item)) rows.push({ ...nameNote(item), state: groupState, from: raw.trim() });
      continue;
    }
    const state = findState(line);
    const body = state ? line.replace(new RegExp(`\\s*[—–-]?\\s*${state}\\s*[—–-]?\\s*`), ' ').trim() : line;
    rows.push({ ...nameNote(body), state: state ?? '?', from: raw.trim() });
  }
  const rest = [...lines.slice(0, sec.start), ...lines.slice(sec.end)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { profileVersion: version, section, rows, newProfile: rest };
}

/** What would stop --apply, one line each; empty when the plan can go in. */
export function planProblems(plan: MovePlan): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  for (const r of plan.rows) {
    if (!ACTIVE_STATES.includes(r.state as BigWorkState)) out.push(`상태를 정해야 함(${ACTIVE_STATES.join('·')}): ${r.name || r.from}`);
    if (!r.name.trim()) out.push(`이름이 비어 있음: ${r.from}`);
    if (Array.from(r.name).length > BIG_WORK_LIMITS.nameChars) out.push(`이름 ${BIG_WORK_LIMITS.nameChars}자 넘음: ${r.name}`);
    if (Array.from(r.note).length > BIG_WORK_LIMITS.noteChars) out.push(`메모 ${BIG_WORK_LIMITS.noteChars}자 넘음(${Array.from(r.note).length}자): ${r.name}`);
    if (names.has(r.name)) out.push(`이름이 겹침: ${r.name}`);
    names.add(r.name);
  }
  const chars = renderBigWork(plan.rows.map((r, i) => ({ ...r, id: i, state: r.state as BigWorkState, source_log_id: null, created_at: new Date().toISOString() }))).length;
  if (chars > BIG_WORK_LIMITS.boardChars) out.push(`판이 ${chars}자(상한 ${BIG_WORK_LIMITS.boardChars}자): 메모를 줄인다`);
  if (plan.rows.length > BIG_WORK_LIMITS.active) out.push(`큰 일이 ${plan.rows.length}개(상한 ${BIG_WORK_LIMITS.active}개)`);
  if (!plan.newProfile.trim()) out.push('큰 일 칸을 빼면 프로필이 비어요');
  return out;
}

/** Puts the plan on the board and saves the trimmed profile. Refuses a stale plan or a board already in use. */
export function applyPlan(store: Store, plan: MovePlan): { board: number; profileVersion: number } {
  const problems = planProblems(plan);
  if (problems.length) throw new Error(`계획 파일을 먼저 고쳐 주세요:\n- ${problems.join('\n- ')}`);
  const current = store.getProfile();
  if (current?.version !== plan.profileVersion) {
    throw new Error(`계획은 프로필 v${plan.profileVersion}에서 만들었는데 지금은 v${current?.version}이에요. 미리 보기부터 다시 하세요.`);
  }
  if (store.bigWork().length) throw new Error('큰 일 판이 이미 비어 있지 않아요(한 번 옮겼나요?). list_big_work로 확인하세요.');
  for (const r of plan.rows) store.setBigWork({ name: r.name, state: r.state as BigWorkState, note: r.note });
  const p = store.updateProfile(plan.newProfile, "큰 일 상태 칸을 큰 일 판(set_big_work)으로 옮김");
  return { board: store.bigWork().length, profileVersion: p.version };
}
