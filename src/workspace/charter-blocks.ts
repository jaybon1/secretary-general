/**
 * A workspace charter's (AGENTS.md) secretary blocks kept to the template (workspace/rules-text.ts): workspace-links writes
 * what is between each block's marks again and leaves the rest of the file as it is.
 *
 * A charter from before the marks (until 2026-11-12) is moved once: its sections are matched to the template's blocks by
 * their headings, each line is the template's (today's, or an old template's: old-charter-lines.ts) or the workspace's own,
 * and the template's lines go into the block while the workspace's own stay after it. Where that cannot be told for sure (a
 * line like a template line but not one, a section the template has but the charter has not), nothing is changed and the
 * reason is reported: the secretary marks that charter itself, then workspace-links keeps it like any other.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { OLD_CHARTER_LINES } from './old-charter-lines.ts';
import { BLOCK_MARK, blockBegin, blockEnd, charterBlockIds, charterBlockLines, type CharterBlockId, type CharterContext, renderRunJobHome, wrapBlock } from './rules-text.ts';
import { HISTORY_FILE, RUN_JOB_HOME, workspaceRootOf } from './workspace-paths.ts';

export type CharterFix = { text: string; moved: boolean } | { problem: string };

/**
 * The charter text as the template wants it for the secretary at root (moved into blocks when it had none), or why it is
 * left. addMissing: a charter without marks that lacks a section the template has gets the section's block (the secretary
 * asks the user first: such a charter is from an old template, `workspace-links --add-missing`). The text comes in with LF.
 */
export function fixCharter(text: string, folder: string, root: string, addMissing = false): CharterFix {
  const runJob = path.basename(path.resolve(folder)) === RUN_JOB_HOME;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.some((l) => BLOCK_MARK.test(l))) return rewriteBlocks(lines, root);
  return runJob ? moveRunJob(lines, root) : moveCharter(lines, root, addMissing);
}

/** Every block between its marks written again; a mark without its pair or a name the template does not have is reported. */
function rewriteBlocks(lines: string[], root: string): CharterFix {
  const ids = lines.flatMap((l) => (l.match(BLOCK_MARK)?.[1] === 'begin' ? [l.match(BLOCK_MARK)![2]] : []));
  const c: CharterContext = { hasHistory: ids.includes('learning'), root };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BLOCK_MARK);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const id = m[2];
    const end = lines.indexOf(blockEnd(id), i + 1);
    const next = lines.findIndex((l, j) => j > i && BLOCK_MARK.test(l));
    if (m[1] !== 'begin' || end < 0 || next !== end) return { problem: `AGENTS.md의 비서 표시 짝이 맞지 않음(${lines[i]})` };
    const body = charterBlockLines(id, c);
    if (!body) return { problem: `AGENTS.md에 틀에 없는 비서 표시: ${id}` };
    out.push(...wrapBlock(id, body));
    i = end;
  }
  return { text: out.join('\n'), moved: false };
}

/** A line with the secretary folder, the workspaces folder and the secretary's variable name written as <S>, <W>, <ENV>. */
export function charterLineKey(line: string, secretaryRoot: string, workspaceRoot: string): string {
  let l = line.trimEnd();
  for (const [p, tag] of [
    [path.resolve(secretaryRoot), '<S>'],
    [path.resolve(workspaceRoot), '<W>'],
  ]) {
    for (const v of new Set([p, p.replaceAll('\\', '/')])) l = l.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), tag);
  }
  return l.replace(/SECRETARY_(?:[A-Z0-9]{4,12}_)?DIR/g, '<ENV>');
}
/** How old-charter-lines.ts holds a line (its key's sha1, first 12 hex digits). */
export const charterLineHash = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 12);

/** Two lines' likeness, 0..1 (Dice coefficient of their letter pairs). */
function likeness(a: string, b: string): number {
  const pairs = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const x = pairs(a);
  const y = pairs(b);
  let n = 0;
  for (const [k, v] of x) n += Math.min(v, y.get(k) ?? 0);
  return (2 * n) / Math.max(1, a.length + b.length - 2);
}
/** A line this much like a template line but not one is not taken for the workspace's own. */
const LIKE = 0.5;

/** Tells a charter line the template's (today's or an old one's) from the workspace's own. */
function lineJudge(root: string, todays: string[]) {
  const ws = workspaceRootOf(root);
  const key = (l: string) => charterLineKey(l, root, ws);
  const now = new Set(todays.map(key));
  const nowList = [...now].filter((l) => l.trim());
  return {
    isTemplate: (l: string) => now.has(key(l)) || OLD_CHARTER_LINES.has(charterLineHash(key(l))),
    /** The template line it is like, when it is like one. */
    like: (l: string) => nowList.find((t) => likeness(key(l), t) >= LIKE),
  };
}

const trimBlank = (lines: string[]) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};
const short = (l: string) => (l.length > 60 ? `${l.slice(0, 60)}…` : l);

interface Section {
  heading: string | null;
  lines: string[];
}
function sections(lines: string[]): Section[] {
  const out: Section[] = [{ heading: null, lines: [] }];
  for (const l of lines) {
    if (l.startsWith('## ')) out.push({ heading: l.slice(3).trim(), lines: [] });
    else out.at(-1)!.lines.push(l);
  }
  return out;
}

/** In these blocks' sections the workspace's own list follows the block (its roles, its check commands). */
const LIST_AFTER = new Set<CharterBlockId>(['team', 'verify']);

/** A workspace charter without marks moved into blocks (see the top of this file). */
function moveCharter(lines: string[], root: string, addMissing: boolean): CharterFix {
  const secs = sections(lines);
  const has = (h: string) => secs.some((s) => s.heading === h);
  const codeSec = secs.find((s) => s.heading?.startsWith('코드를 쓸 때'));
  const scale = codeSec?.lines.includes('### 대규모 공간') ? 'large' : codeSec?.lines.includes('### 중규모 공간') ? 'medium' : 'small';
  const hasHistory = has('스킬과 기억') || lines.some((l) => l.includes(`\`${HISTORY_FILE}\``));
  const kind = has('팀') ? 'team' : has('혼자 맡는 방식') ? 'solo' : hasHistory ? 'team' : 'quick';
  const want = charterBlockIds({ kind, agents: has('팀') ? [{ name: 'x', description: '', prompt: '' }] : [], code: !!codeSec, scale });
  const c: CharterContext = { hasHistory, root };
  const bodies = new Map(want.map((id) => [id, charterBlockLines(id, c)!]));
  // Every block's lines of every kind count as today's template (a line of another kind's block is still not the workspace's).
  const todays = (['intro', 'team', 'solo', 'start', 'learning', 'work', 'code', 'code-medium', 'code-large', 'verify', 'ask', 'finish'] as const).flatMap((id) => [
    ...charterBlockLines(id, { hasHistory: true, root })!,
    ...charterBlockLines(id, { hasHistory: false, root })!,
  ]);
  const judge = lineJudge(root, todays);
  const idOf = new Map<string, CharterBlockId>();
  for (const id of want) if (id !== 'intro') idOf.set(bodies.get(id)![0].slice(3).trim(), id);

  const missing = want.filter((id) => id !== 'intro' && !secs.some((s) => s.heading !== null && idOf.get(s.heading) === id));
  if (missing.length && !addMissing) return { problem: `AGENTS.md에 비서 표시가 없고, 지금 틀에 있는 절이 없어 자동으로 옮기지 않음(${missing.map((id) => bodies.get(id)![0].slice(3)).join(', ')})` };

  /** The workspace's own lines of a template section, or the line that makes it unsure. */
  const own = (id: CharterBlockId, body: string[]): string[] | { unsure: string } => {
    const kept: string[] = [];
    for (const l of body) {
      if (!l.trim() || judge.isTemplate(l)) {
        if (kept.length && !l.trim()) kept.push(l);
        continue;
      }
      if (LIST_AFTER.has(id) && /^\s*[-*] /.test(l)) {
        kept.push(l);
        continue;
      }
      if (judge.like(l)) return { unsure: l };
      kept.push(l);
    }
    return trimBlank(kept);
  };

  const out: string[] = [];
  const placed = new Set<CharterBlockId>();
  const put = (id: CharterBlockId, after: string[]) => {
    out.push(...wrapBlock(id, bodies.get(id)!), ...after, '');
    placed.add(id);
  };
  /** Missing blocks that go before id (addMissing). */
  const putMissingBefore = (id: CharterBlockId) => {
    for (const m of want.slice(0, want.indexOf(id))) if (missing.includes(m) && !placed.has(m)) put(m, []);
  };
  for (const s of secs) {
    if (s.heading === null) {
      // The title, then the intro sentence (the template's) and anything else before the first section.
      const title = s.lines.filter((l) => l.startsWith('# '));
      const rest = s.lines.filter((l) => !l.startsWith('# '));
      const after = own('intro', rest);
      if (!Array.isArray(after)) return { problem: unsure('맨 위', after.unsure) };
      out.push(...title, '');
      put('intro', after);
      continue;
    }
    const id = idOf.get(s.heading);
    if (!id) {
      // The workspace's own section (what it does, its context, one the user added) or a section the template no longer has.
      const body = trimBlank(s.lines);
      if (body.length && body.every((l) => !l.trim() || judge.isTemplate(l))) continue;
      out.push(`## ${s.heading}`, '', ...body, '');
      continue;
    }
    const after = own(id, s.lines);
    if (!Array.isArray(after)) return { problem: unsure(s.heading, after.unsure) };
    putMissingBefore(id);
    put(id, after);
  }
  for (const m of missing) if (!placed.has(m)) put(m, []);
  return { text: [...trimBlank(out), ''].join('\n'), moved: true };
}

const unsure = (where: string, line: string) => `AGENTS.md에 비서 표시가 없고, "${where}"의 줄이 틀 줄과 비슷하지만 같지 않아 자동으로 옮기지 않음: ${short(line)}`;

/** run-job's folder rules without marks: the title, then every template line into the block and the folder's own after it. */
function moveRunJob(lines: string[], root: string): CharterFix {
  const todays = renderRunJobHome(root).split('\n').filter((l) => !BLOCK_MARK.test(l));
  const judge = lineJudge(root, todays);
  const title = lines.filter((l) => l.startsWith('# ')).slice(0, 1);
  // Rules with no template line at all are the user's own (aux-folders.ts never rewrites a file that is there).
  if (!lines.some((l) => l.trim() && !title.includes(l) && judge.isTemplate(l))) return { problem: 'AGENTS.md에 비서 표시도 틀 줄도 없음(사용자가 고친 규칙으로 보고 그대로 둠)' };
  const kept: string[] = [];
  for (const l of lines) {
    if (title.includes(l) || !l.trim() || judge.isTemplate(l)) {
      if (kept.length && !l.trim()) kept.push(l);
      continue;
    }
    if (judge.like(l)) return { problem: unsure('run-job 규칙', l) };
    kept.push(l);
  }
  const block = renderRunJobHome(root).split('\n');
  const begin = block.indexOf(blockBegin('run-job'));
  const end = block.indexOf(blockEnd('run-job'));
  return { text: [...(title.length ? title : block.slice(0, 1)), '', ...block.slice(begin, end + 1), ...trimBlank(kept), ''].join('\n'), moved: true };
}
