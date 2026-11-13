/**
 * 되감기(rewind)로 버려진 대화 갈래를 비서 DB에서 지운다. 되감으면 Claude Code는 대화 JSONL의 옛 줄을
 * 지우지 않고, 새 메시지를 parentUuid로 예전 메시지에 이어 붙인다. 그대로 두면 버려진 갈래의 대화와
 * 그 턴에 저장된 기억이 계속 읽혀, 오류를 부른 대화라면 읽을 때마다 비서가 멈춘다.
 *
 * 버려진 갈래로 보는 것은 둘뿐이다(애매하면 지우지 않는다).
 * - 갈래: 한 메시지 아래 사용자 질문이 둘 이상 이어졌고, 그중 하나가 지금 대화(파일 마지막 메시지에서
 *   부모를 따라 올라간 줄, 요약 경계는 logicalParentUuid로 넘는다)에 있을 때, 그보다 먼저 쓰인 다른 질문과 그 아래 전부.
 * - 되감기 표시: 되감는 순간 쓰이는 `last-prompt` 줄(rewound: true, cutUuid, leafUuid). 새 질문이 아직
 *   파일에 없는 질문 훅 시점에는 이것만 근거가 된다. 잘린 질문(cutUuid)의 조상에 되돌아간 메시지(leafUuid)가
 *   있고, 표시 뒤로 잘린 갈래에 이어 쓴 줄이 없을 때만 믿는다.
 *
 * 지우기는 "비서 대화 삭제"와 같은 길(log/purge.ts deleteLogRows)로 한다: 지운 줄은 `backups/error/`의 격리 DB에 쌓이고
 * (DB 전체 백업은 하지 않는다), 다시 들어오지 않게 막고, 파일에 남은 흔적을 지우고, 그 줄을 읽은 상황판은 비워
 * 다시 쓰게 하고, 그 줄에서 나온 남은 질문은 뺀다. 다른 점은 대상을 고르는 법뿐이다.
 * 그 턴에 저장된 기억(턴에 이어진 것, 그리고 갈래 안 remember 결과에 적힌 번호)은 무효 처리하고, 번호는 다음
 * 질문의 <secretary-rewind> 알림으로 한 번 알린다. Stop 훅(ingestTranscript)과 질문 훅(기억 주입보다 먼저)에서 돈다.
 */
import fs from 'node:fs';
import { boardReflects } from '../session-continuity/situation-board.ts';
import { dropQuestionsFrom } from '../session-continuity/open-questions.ts';
import { parseTranscriptLine } from './ingest-transcript.ts';
import { deleteLogRows } from './purge.ts';
import type { LogRowInfo, Store } from '../store/store.ts';
import { nowIso } from '../core/kst-time.ts';
import { TAG } from '../core/names.ts';

export const REWIND_REASON = '되감기로 버려진 대화에서 저장됨';
const DONE_PREFIX = 'rewind_cut:';
const NOTICE_KEY = 'rewind_notice';
/** A memory counts as saved in the branch only inside its time span (guards against another session's or another DB's numbers). */
const WINDOW_BEFORE_MS = 60 * 1000;
const WINDOW_AFTER_MS = 5 * 60 * 1000;

interface Line {
  n: number;
  uuid: string;
  parent: string | null;
  type?: string;
  sidechain: boolean;
  prompt: boolean;
  timestamp?: string;
  content?: unknown;
}

interface Marker {
  n: number;
  cut: string;
  leaf: string;
}

/** One abandoned branch: its first prompt (root), every line under it, and the memory numbers its remember calls returned. */
export interface Branch {
  root: string;
  uuids: string[];
  /** Earliest and latest timestamp in the branch. */
  from: string;
  to: string;
  memoryIds: number[];
  /** How it was found: sibling prompts (branch) or the rewind marker alone (marker). */
  via: 'branch' | 'marker';
}

/**
 * Cheap check before parsing the whole file: a rewind marker, or two user lines with the same parent
 * (tool results left out). Missing a branch here only means nothing is deleted.
 */
export function mayHaveRewind(text: string): boolean {
  if (text.includes('"rewound":true')) return true;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"') || line.includes('"tool_use_id"')) continue;
    const m = /"parentUuid":"([^"]+)"/.exec(line);
    if (!m) continue;
    if (seen.has(m[1])) return true;
    seen.add(m[1]);
  }
  return false;
}

/** The abandoned branches of one transcript (its whole text). */
export function findAbandoned(text: string): Branch[] {
  const lines: Line[] = [];
  const markers: Marker[] = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw) return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw);
    } catch {
      return;
    }
    if (o.type === 'last-prompt' && o.rewound === true && typeof o.cutUuid === 'string' && typeof o.leafUuid === 'string') {
      markers.push({ n: i, cut: o.cutUuid, leaf: o.leafUuid });
    }
    if (typeof o.uuid !== 'string') return;
    const parent = (o.parentUuid ?? o.logicalParentUuid ?? null) as string | null;
    lines.push({
      n: i,
      uuid: o.uuid,
      parent,
      type: o.type as string,
      sidechain: o.isSidechain === true,
      prompt: parseTranscriptLine(raw)[0]?.kind === 'prompt',
      timestamp: o.timestamp as string | undefined,
      content: (o.message as { content?: unknown } | undefined)?.content,
    });
  });

  const byUuid = new Map(lines.map((l) => [l.uuid, l]));
  const kids = new Map<string, Line[]>();
  for (const l of lines) {
    if (!l.parent) continue;
    if (!kids.has(l.parent)) kids.set(l.parent, []);
    kids.get(l.parent)!.push(l);
  }
  const ancestors = (from: Line | undefined): Set<string> => {
    const out = new Set<string>();
    for (let x = from; x && !out.has(x.uuid); x = x.parent ? byUuid.get(x.parent) : undefined) out.add(x.uuid);
    return out;
  };
  const subtree = (root: Line): Line[] => {
    const out: Line[] = [];
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x.uuid)) continue;
      seen.add(x.uuid);
      out.push(x);
      stack.push(...(kids.get(x.uuid) ?? []));
    }
    return out.sort((a, b) => a.n - b.n);
  };

  // The live conversation: up from the last message written.
  const leaf = lines.filter((l) => !l.sidechain && (l.type === 'user' || l.type === 'assistant')).at(-1);
  const active = ancestors(leaf);

  const roots = new Map<string, Branch['via']>();
  for (const [, children] of kids) {
    const prompts = children.filter((c) => c.prompt && !c.sidechain);
    if (prompts.length < 2) continue;
    const live = prompts.filter((c) => active.has(c.uuid));
    if (live.length !== 1) continue;
    for (const c of prompts) if (!active.has(c.uuid) && c.n < live[0].n) roots.set(c.uuid, 'branch');
  }
  for (const m of markers) {
    const cut = byUuid.get(m.cut);
    if (!cut || !cut.prompt || cut.sidechain || roots.has(cut.uuid) || !byUuid.has(m.leaf)) continue;
    const parentChain = ancestors(cut.parent ? byUuid.get(cut.parent) : undefined);
    if (!parentChain.has(m.leaf)) continue;
    // Anything written to the cut branch after the marker means it is still in use.
    if (subtree(cut).some((x) => x.n > m.n)) continue;
    roots.set(cut.uuid, 'marker');
  }

  return [...roots].map(([uuid, via]) => {
    const branch = subtree(byUuid.get(uuid)!);
    const times = branch.map((x) => x.timestamp).filter((t): t is string => !!t && !Number.isNaN(Date.parse(t))).sort();
    return { root: uuid, uuids: branch.map((x) => x.uuid), from: times[0] ?? '', to: times.at(-1) ?? '', memoryIds: rememberedIds(branch), via };
  });
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
}

/** Memory numbers from the branch's own remember calls ("기억 #1234 저장"). */
function rememberedIds(branch: Line[]): number[] {
  const calls = new Set<string>();
  for (const l of branch) {
    if (l.type !== 'assistant' || !Array.isArray(l.content)) continue;
    for (const b of l.content as Block[]) if (b?.type === 'tool_use' && b.id && b.name?.endsWith('__remember')) calls.add(b.id);
  }
  const ids = new Set<number>();
  for (const l of branch) {
    if (l.type !== 'user' || !Array.isArray(l.content)) continue;
    for (const b of l.content as Block[]) {
      if (b?.type !== 'tool_result' || !b.tool_use_id || !calls.has(b.tool_use_id) || b.is_error) continue;
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c?.text ?? '').join('\n') : '';
      const m = /^기억 #(\d+) 저장/.exec(text.trim());
      if (m) ids.add(Number(m[1]));
    }
  }
  return [...ids];
}

export interface RewindPlan {
  branches: Branch[];
  /** Their log rows, without the text. */
  rows: LogRowInfo[];
  /** Still-valid memories that would be invalidated. */
  memoryIds: number[];
  /** Whether the board has read these rows (it is emptied for a rewrite). */
  boardReset: boolean;
  /** Open questions asked in these rows (they leave the list). */
  questions: string[];
}

export interface RewindResult extends RewindPlan {
  /** Where the rows were kept (the quarantine file of log/purge.ts), when any were deleted. */
  quarantine?: string;
  forgotten: number[];
}

/**
 * Finds abandoned branches in a transcript and removes them from the DB the way "비서 대화 삭제" does (log/purge.ts
 * deleteLogRows): rows copied to the quarantine, deleted and blocked, file traces cleared, the board and open
 * questions that came from them dropped, and the memories saved in them invalidated (once per branch: a branch
 * already handled is not forgotten again, so a memory the secretary brought back directly stays).
 * dryRun only reports; keepMemories deletes the rows but leaves the memories as they are.
 */
export function cleanRewound(store: Store, transcriptPath: string, opts: { dryRun?: boolean; keepMemories?: boolean } = {}): RewindResult {
  const empty: RewindResult = { branches: [], rows: [], memoryIds: [], boardReset: false, questions: [], forgotten: [] };
  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return empty;
  }
  if (!mayHaveRewind(text)) return empty;
  const branches = findAbandoned(text);
  if (!branches.length) return empty;

  const rows = store.logInfoByUuids(branches.flatMap((b) => b.uuids));
  const memoryIds = new Set<number>();
  for (const b of branches) {
    if (opts.keepMemories || store.getMeta(DONE_PREFIX + b.root)) continue;
    const ids = new Set(rows.filter((r) => b.uuids.includes(r.message_uuid.replace(/:recap$/, ''))).map((r) => r.id));
    const from = Date.parse(b.from) - WINDOW_BEFORE_MS;
    const to = Date.parse(b.to) + WINDOW_AFTER_MS;
    for (const m of store.memoriesForRewind([...ids], b.memoryIds)) {
      const at = Date.parse(m.created_at);
      if (at >= from && at <= to) memoryIds.add(m.id);
    }
  }
  const ids = rows.map((r) => r.id);
  const plan: RewindPlan = {
    branches,
    rows,
    memoryIds: [...memoryIds].sort((a, b) => a - b),
    boardReset: ids.length > 0 && boardReflects(store, ids[0]),
    questions: dropQuestionsFrom(store, ids, true),
  };
  const fresh = branches.filter((b) => !store.getMeta(DONE_PREFIX + b.root));
  if (opts.dryRun || (!rows.length && !plan.memoryIds.length && !fresh.length)) return { ...plan, forgotten: [] };

  const done = rows.length || plan.memoryIds.length ? deleteLogRows(store, ids, plan.memoryIds, REWIND_REASON) : undefined;
  for (const b of fresh) store.setMeta(DONE_PREFIX + b.root, nowIso());
  const forgotten = done?.forgotten ?? [];
  if (forgotten.length) {
    const pending = store.getJson<number[]>(NOTICE_KEY) ?? [];
    store.setJson(NOTICE_KEY, [...new Set([...pending, ...forgotten])]);
  }
  return { ...plan, boardReset: done?.boardReset ?? false, questions: done?.questions ?? [], quarantine: done?.quarantine || undefined, forgotten };
}

/** Prompt hook, before memories are injected: clean this session's transcript, then report forgotten memories once. */
export function rewindNotice(store: Store, transcriptPath?: string): string {
  if (transcriptPath) cleanRewound(store, transcriptPath);
  const pending = store.getJson<number[]>(NOTICE_KEY);
  if (!pending?.length) return '';
  store.setJson(NOTICE_KEY, []);
  const ids = pending.map((i) => `#${i}`).join(', ');
  return `<${TAG.rewind}>되감기로 버려진 대화에서 저장된 기억 ${ids}를 무효 처리했다(그 대화 기록은 지웠다). 답 끝("다음 행동" 위)에 "되감기로 버려진 대화의 기억 ${ids}를 무효 처리했어요." 한 줄만 붙인다(버린 대화라 내용은 다시 꺼내지 않는다).</${TAG.rewind}>`;
}
