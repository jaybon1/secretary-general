/**
 * 태그 경계 한꺼번에 정하기(2026-11-18 사용자 결정, v0.12.0 전): 옮기기 21이 띄어쓰기로 나눠 둔 태그("할", "일")를 기억 정리가
 * 한 번에 20개씩 고치면 백 번 가까이 걸려, 남은 기억(memory_tag_checks)을 100개씩 모델에 보내 경계를 정하게 하고 프로그램이 적용한다.
 *   node src/memory/tag-boundaries.ts [--db <DB 파일>] [--limit <기억 수>] [--batch <한 번에 보낼 수, 기본 100>] [--dry-run]
 * 모델은 상황판 담당과 같은 값(src/staff/situation-board.json: 구독, Haiku, 도구 없음, 새 세션)으로 run-job.ps1 -Staff를 거쳐
 * 부른다(정리 담당과 같은 길). 답은 기억마다 JSON 한 줄 {"id": 번호, "tags": [...]}이고, 프로그램이 낱말이 그대로인지
 * (set_memory_tags와 같은 검사: 낱말을 더하거나 빼지 않고 묶기만) 보고 맞는 것만 적용한다. 답에 없거나 틀린 기억은 목록에 남아
 * 다음 실행이나 기억 정리가 다시 본다. --dry-run은 모델에 묻고 무엇을 바꿀지만 보이며 DB에 쓰지 않는다.
 * 한 번 실행마다 걸린 시간과 토큰(입력·캐시 읽기·캐시 쓰기·출력)과 비용을 묶음마다, 그리고 합으로 낸다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DB_PATH } from '../core/config.ts';
import { readJson } from '../core/json-file.ts';
import { STAFF } from '../core/names.ts';
import { runJobScript, stripSessionLine } from '../staff/launch.ts';
import { readStaff } from '../staff/staff.ts';
import { openDb } from '../store/schema.ts';
import { Store, type Memory } from '../store/store.ts';
import { sameTagWords } from '../store/tag-names.ts';

/** Memories one model call sets the boundaries of. */
export const TAG_BATCH = 100;
/** The staff member whose values the call runs with: Haiku, no tools, a new session each time. */
const RUN_STAFF = STAFF.situationBoard;
const CONTENT_CHARS = 200;

export interface CallUsage {
  ms: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** What one batch's model call gives back: its text, and its usage when the raw record could be read. */
export type TagModel = (prompt: string) => Promise<{ text: string; usage: CallUsage }>;

export interface BatchResult {
  ids: number[];
  /** Tags set (or, dry, to be set): id → new tags, only where they differ from now. */
  changed: Array<{ id: number; before: string[]; after: string[] }>;
  /** Confirmed as they are (taken off the list unless dry). */
  same: number[];
  /** Answered with other words, an unknown id, or not at all: left on the list, with why. */
  left: Array<{ id: number; why: string }>;
  usage: CallUsage;
}

/** The prompt for one batch: the rules and one line per memory. */
export function tagPrompt(items: Array<{ id: number; tags: string[]; content: string }>): string {
  return [
    '# 기억 태그 경계 정하기',
    '',
    '아래 기억들의 태그는 예전에 한 글로 이어 저장돼 있다가 띄어쓰기로 나뉘었다. 그래서 두 낱말이 한 이름인 태그("할 일", "모종 가게", "크롬 확장")가 낱말마다 따로 쪼개져 있을 수 있다.',
    '기억마다 내용을 보고 원래 뜻대로 낱말을 다시 묶은 태그를 정한다.',
    '',
    '규칙:',
    '- 낱말을 더하거나 빼거나 바꾸지 않는다. 쪼개진 낱말을 다시 묶기만 한다(검색이 그 낱말로 찾는다).',
    '- 낱말 순서는 그대로 둔다. 첫 태그가 주제다(예: ["텃밭", "모종 가게", "할 일"]).',
    '- 이미 맞게 나뉘어 있으면 같은 태그를 그대로 적는다.',
    '- 사람이 보고 있지 않으니 묻지 말고, 설명 없이 기억마다 JSON 한 줄만 쓴다: {"id": 번호, "tags": ["태그", ...]}',
    '',
    '기억:',
    ...items.map((m) => JSON.stringify({ id: m.id, tags: m.tags, content: m.content.replace(/\s+/g, ' ').slice(0, CONTENT_CHARS) })),
  ].join('\n');
}

/** The {"id", "tags"} lines of an answer (other lines, code fences and prose, are passed over). */
export function parseTagAnswer(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const m = /\{.*\}/.exec(line);
    if (!m) continue;
    try {
      const v = JSON.parse(m[0]) as { id?: unknown; tags?: unknown };
      if (typeof v.id === 'number' && Array.isArray(v.tags) && v.tags.every((t) => typeof t === 'string')) out.set(v.id, v.tags as string[]);
    } catch {
      // not a JSON line
    }
  }
  return out;
}

/** One batch: asks the model, checks each answer, applies the good ones unless `dry`. */
export async function runBatch(store: Store, due: Memory[], model: TagModel, dry: boolean): Promise<BatchResult> {
  const items = due.map((m) => ({ id: m.id, tags: store.tagsOf(m.id), content: m.content }));
  const { text, usage } = await model(tagPrompt(items));
  const answer = parseTagAnswer(text);
  const r: BatchResult = { ids: items.map((m) => m.id), changed: [], same: [], left: [], usage };
  for (const m of items) {
    const tags = answer.get(m.id)?.map((t) => t.trim()).filter(Boolean);
    if (!tags?.length) {
      r.left.push({ id: m.id, why: '답에 없음' });
      continue;
    }
    if (!sameTagWords(m.tags, tags)) {
      r.left.push({ id: m.id, why: `낱말이 달라짐 ${JSON.stringify(tags)}` });
      continue;
    }
    const same = JSON.stringify(tags) === JSON.stringify(m.tags);
    if (same) r.same.push(m.id);
    else r.changed.push({ id: m.id, before: m.tags, after: tags });
    if (!dry) store.setMemoryTags(m.id, tags);
  }
  for (const id of answer.keys()) if (!r.ids.includes(id)) r.left.push({ id, why: '이 묶음에 없는 번호(무시)' });
  return r;
}

/** The model call through run-job (-Staff, -RawJson for the usage). */
export function runJobModel(timeoutMs: number): TagModel {
  return async (prompt) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-boundaries-'));
    try {
      const promptFile = path.join(dir, 'prompt.md');
      const rawFile = path.join(dir, 'raw.json');
      fs.writeFileSync(promptFile, prompt, 'utf8');
      const t = Date.now();
      const out = await runJobScript(['-Staff', RUN_STAFF, '-RawJson', rawFile], promptFile, timeoutMs);
      const ms = Date.now() - t;
      const raw = readJson<{ usage?: Record<string, number>; total_cost_usd?: unknown }>(rawFile);
      const u = raw.ok ? (raw.value.usage ?? {}) : {};
      return {
        text: stripSessionLine(out),
        usage: {
          ms,
          inputTokens: u.input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          costUsd: raw.ok && typeof raw.value.total_cost_usd === 'number' ? raw.value.total_cost_usd : null,
        },
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const usageLine = (u: CallUsage) =>
  `${(u.ms / 1000).toFixed(1)}초 · 토큰 입력 ${u.inputTokens} · 캐시 읽기 ${u.cacheReadTokens} · 캐시 쓰기 ${u.cacheWriteTokens} · 출력 ${u.outputTokens}${u.costUsd === null ? '' : ` · $${u.costUsd.toFixed(4)}`}`;

/** The whole run: up to `limit` memories off the list, `batch` per call. Returns the exit code. */
export async function runTagBoundaries(
  store: Store,
  opts: { limit?: number; batch?: number; dry?: boolean; model: TagModel },
  out: (s: string) => void = console.log,
): Promise<number> {
  const batch = opts.batch ?? TAG_BATCH;
  const { due, left } = store.tagChecksDue(opts.limit ?? Number.MAX_SAFE_INTEGER);
  out(`태그 경계를 확인할 기억 ${left}개 중 이번 ${due.length}개(${batch}개씩)${opts.dry ? ' · 미리보기(DB에 쓰지 않음)' : ''}`);
  const total: CallUsage = { ms: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };
  let changed = 0;
  let same = 0;
  let kept = 0;
  let failed = 0;
  for (let i = 0; i < due.length; i += batch) {
    const part = due.slice(i, i + batch);
    let r: BatchResult;
    try {
      r = await runBatch(store, part, opts.model, !!opts.dry);
    } catch (e) {
      failed++;
      out(`묶음 ${i / batch + 1}: 모델 호출 실패, 이 묶음은 목록에 남김: ${String((e as Error).message ?? e).split('\n')[0]}`);
      continue;
    }
    changed += r.changed.length;
    same += r.same.length;
    kept += r.left.filter((l) => r.ids.includes(l.id)).length;
    for (const k of Object.keys(total) as Array<keyof CallUsage>) {
      if (k === 'costUsd') total.costUsd = total.costUsd === null || r.usage.costUsd === null ? null : total.costUsd + r.usage.costUsd;
      else total[k] += r.usage[k];
    }
    out(`묶음 ${i / batch + 1} (${part.length}개): 바꿈 ${r.changed.length} · 그대로 맞음 ${r.same.length} · 남김 ${r.left.length} · ${usageLine(r.usage)}`);
    for (const c of r.changed) out(`  #${c.id} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
    for (const l of r.left) out(`  남김 #${l.id}: ${l.why}`);
  }
  out(`합: ${opts.dry ? '바꿀' : '바꾼'} 기억 ${changed} · 그대로 맞음 ${same} · 목록에 남긴 ${kept} · 실패한 묶음 ${failed} · ${usageLine(total)}`);
  if (!opts.dry) out(`남은 기억: ${store.tagChecksDue(1).left}개`);
  return failed ? 1 : 0;
}

export async function main(argv: string[], out: (s: string) => void = console.log, model?: TagModel): Promise<number> {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string) => {
    const v = opt(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}는 1 이상의 정수`);
    return n;
  };
  const store = new Store(openDb(path.resolve(opt('--db') ?? DB_PATH)));
  try {
    const timeoutMs = readStaff(RUN_STAFF).timeoutMinutes * 60_000;
    return await runTagBoundaries(store, { limit: num('--limit'), batch: num('--batch'), dry: argv.includes('--dry-run'), model: model ?? runJobModel(timeoutMs) }, out);
  } finally {
    store.db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
