// 위임 앞뒤 대조(기능 'guards'). 비서 폴더 밖에서는 입구 bin/delegate-check.mjs로 부른다.
//   node bin/delegate-check.mjs brief <지시 파일> --tag <태그> [--tag <태그>]... [--query <말>] [--db <DB 파일>] [--memories <개수>] [--rules <줄 수>]
//     지시서(TASK.md나 지시 파일)와 그 공간·업무 태그가 붙은 결정(decision) 기억을 대조해, 지시서에 안 들어간 듯한 결정 가운데
//     지시서와 낱말이 겹치는(드문 낱말일수록 무겁게) 것을 관련 높은 순으로 위 몇 개(기본 10) 보여 주고, 들어간 듯한 결정을 잇는다.
//     이어서 지시서가 있는 공간의 스킬(.agents/skills/*/SKILL.md, common-skills.json의 공통 스킬)에서 지시서와 낱말이 겹치는
//     규칙 줄을 점수 순으로 위 몇 줄(기본 10) 보여 준다(어긋났는지는 비서가 대조한다).
//     기억 DB는 읽기만 한다.
//   node bin/delegate-check.mjs report <보고 파일> [--root <폴더>]... [--top <결과물 상위 폴더>] [--hours <시간>]
//     보고의 "지웠다·없다·남지 않았다" 류 주장과 언급된 경로를 실제 파일·폴더와 대조하고, --root 아래 남은 시험·임시 폴더 후보와
//     결과물 상위 폴더(기본: 비서 폴더의 상위)의 낯선 항목·최근 바뀐 항목을 보여 준다.
// 둘 다 판단은 하지 않고 대조표만 낸다: 빠진 듯한 결정은 지시서에 넣을지, 어긋난 주장은 업무 세션에 물을지 비서가 정한다.
// 종료 코드: 0 = 걸린 것 없음, 1 = 걸린 것 있음(지시서와 낱말이 겹치는데 빠진 듯한 결정, 주장과 다른 실제, 없는 경로), 2 = 쓰는 법 오류.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, PROJECT_ROOT } from '../../src/core/config.ts';
import { formatLocal } from '../../src/core/kst-time.ts';
import { queryTerms, searchTerms } from '../../src/memory/korean-terms.ts';

// ---- brief ----------------------------------------------------------------------------------------------------------

export interface Decision {
  id: number;
  content: string;
  tags: string;
  created_at: string;
}

export interface Coverage {
  decision: Decision;
  /** Share of the decision's search terms found in the brief (0..1). */
  covered: number;
  /** Latin words and numbers of the decision (names, versions) the brief lacks. */
  missingNames: string[];
}

/** Below this share of its terms a decision counts as left out of the brief. */
export const LEFT_OUT_BELOW = 0.5;

/** Active decision memories carrying any of the tags (a tag may hold spaces, e.g. "업무 20"), plus those a query finds. */
export function decisionsFor(db: DatabaseSync, tags: string[], query?: string): Decision[] {
  const byId = new Map<number, Decision>();
  const tagged = db.prepare(
    `SELECT id, content, tags, created_at FROM memories
     WHERE valid_to IS NULL AND kind = 'decision' AND (' ' || tags || ' ') LIKE ? ORDER BY id`,
  );
  for (const t of tags.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    for (const r of tagged.all(`% ${t.replace(/[%_]/g, '')} %`) as unknown as Decision[]) byId.set(r.id, r);
  }
  if (query?.trim()) {
    const terms = queryTerms(query);
    if (terms.length) {
      const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
      const rows = db
        .prepare(
          `SELECT m.id, m.content, m.tags, m.created_at FROM memories_fts f JOIN memories m ON m.id = f.rowid
           WHERE memories_fts MATCH ? AND m.valid_to IS NULL AND m.kind = 'decision' ORDER BY bm25(memories_fts) LIMIT 30`,
        )
        .all(match) as unknown as Decision[];
      for (const r of rows) byId.set(r.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** A decision's own words: without the date and the "…결정(…):" lead most of them start with. */
export function decisionBody(content: string): string {
  return content
    .replace(/^\s*\d{4}-\d{2}-\d{2}\s*/, '')
    .replace(/^[^:\n]{0,40}결정(\([^)\n]{0,60}\))?\s*:\s*/, '');
}

/** How much of each decision the brief carries, least first. Numbers alone (dates, counts) are not counted. */
export function briefCoverage(brief: string, decisions: Decision[]): Coverage[] {
  const have = new Set(searchTerms(brief));
  const lower = brief.toLowerCase();
  return decisions
    .map((d) => {
      const body = decisionBody(d.content);
      const terms = queryTerms(body).filter((t) => !/^\d+$/.test(t));
      const covered = terms.length ? terms.filter((t) => have.has(t)).length / terms.length : 1;
      const names = [...new Set((body.match(/[A-Za-z][\w.+-]*/g) ?? []).filter((w) => w.length >= 2))];
      return { decision: d, covered, missingNames: names.filter((n) => !lower.includes(n.toLowerCase())) };
    })
    .sort((a, b) => a.covered - b.covered || a.decision.id - b.decision.id);
}

// A tag gathers every decision of a space (sound effects, topic picking, thumbnails…), most of them nothing to do with
// this brief, so "left out" alone buries the few that matter. Each decision is scored like the skill rules below: the
// brief's words it shares, a word counting by how rare it is among the gathered decisions (the space's name, which
// they all carry, tells nothing), and only the best few left-out ones are shown.

export interface RankedCoverage extends Coverage {
  /** How much the decision shares with the brief (0 = nothing telling). */
  relevance: number;
  /** The brief's words found in the decision, most telling first. */
  shared: string[];
}

/** Left-out decisions shown by default. */
export const MEMORIES_SHOWN = 10;

/**
 * The other active memories, for telling how rare a word is: among a space's few dozen decisions everyday words
 * ("다음", "이미", "직접") look rare and lift a long, unrelated decision.
 */
export function otherMemories(db: DatabaseSync, decisions: Decision[]): string[] {
  const skip = new Set(decisions.map((d) => d.id));
  return (db.prepare('SELECT id, content FROM memories WHERE valid_to IS NULL').all() as Array<{ id: number; content: string }>)
    .filter((r) => !skip.has(r.id))
    .map((r) => decisionBody(r.content));
}

/** Scores each decision against the brief, best first; one sharing fewer than two whole words (stems, Latin words) scores 0. */
export function rankCoverage(brief: string, coverage: Coverage[], corpus: string[] = []): RankedCoverage[] {
  const have = new Set(searchTerms(withoutFolders(brief)));
  const terms = coverage.map((c) => lineTerms(decisionBody(c.decision.content)));
  const df = new Map<string, number>();
  for (const t of [...terms, ...corpus.map((c) => lineTerms(c))]) for (const k of t.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const n = Math.max(coverage.length + corpus.length, 1);
  const idf = (t: string) => Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5));
  return coverage
    .map((c, i) => {
      const weight = (t: string) => idf(t) * (terms[i].get(t) ?? 0);
      const shared = [...terms[i].keys()].filter((t) => have.has(t)).sort((a, b) => weight(b) - weight(a));
      const whole = shared.filter((t) => terms[i].get(t) === 1).length;
      return { ...c, shared, relevance: whole < 2 ? 0 : shared.reduce((s, t) => s + weight(t), 0) };
    })
    .sort((a, b) => b.relevance - a.relevance || a.covered - b.covered || a.decision.id - b.decision.id);
}

function decisionLine(c: RankedCoverage, mark: string): string {
  return (
    `- [${mark} ${Math.round(c.covered * 100)}% · 관련 ${c.relevance.toFixed(1)}] #${c.decision.id} (${formatLocal(c.decision.created_at)}, ${c.decision.tags}) ${c.decision.content}` +
    (c.shared.length ? `\n    겹친 말: ${c.shared.slice(0, 8).join(', ')}` : '') +
    (c.missingNames.length ? `\n    지시서에 없는 이름·숫자: ${c.missingNames.join(', ')}` : '')
  );
}

/**
 * The left-out decisions that share words with the brief, best first and at most `top`, then the ones it seems to carry.
 * leftOut counts the left-out decisions that share words with it (shown or not): those with nothing in common are no finding.
 */
export function briefReport(briefFile: string, ranked: RankedCoverage[], tags: string[], top = MEMORIES_SHOWN): { text: string; leftOut: number } {
  const left = ranked.filter((c) => c.covered < LEFT_OUT_BELOW);
  const related = left.filter((c) => c.relevance > 0);
  const shown = related.slice(0, Math.max(0, top));
  const inBrief = ranked.filter((c) => c.covered >= LEFT_OUT_BELOW);
  const lines = [
    `지시서 대조: ${briefFile}`,
    `대조한 결정 기억 ${ranked.length}개(태그: ${tags.join(', ') || '없음'}). 지시서에 안 들어간 듯 ${left.length}개 중 지시서와 낱말이 겹치는 것 ${related.length}개, 관련 높은 위 ${shown.length}개(최대 ${top}, --memories로 바꿈):`,
  ];
  for (const c of shown) lines.push(decisionLine(c, '빠진 듯'));
  if (!shown.length && ranked.length) lines.push('(지시서와 겹치는 빠진 결정 없음)');
  const hidden = left.length - shown.length;
  if (hidden > 0) lines.push(`(안 보인 빠진 듯한 결정 ${hidden}개: 지시서와 겹치는 말이 적거나 위 ${top}개 밖. 다 보려면 --memories ${left.length})`);
  if (inBrief.length) {
    lines.push(`지시서에 들어간 듯 ${inBrief.length}개(관련 높은 순):`);
    for (const c of inBrief) lines.push(decisionLine(c, c.missingNames.length ? '일부' : '들어 있음'));
  }
  if (!ranked.length) lines.push('(이 태그의 결정 기억이 없음: 태그가 맞는지 list_topics로 확인한다)');
  lines.push('→ "빠진 듯"·"일부"는 지시서에 넣을지 정한다. 이 일과 상관없는 결정이면 그냥 둔다.');
  return { text: lines.join('\n'), leftOut: related.length };
}

// ---- brief: the space's skill rules ---------------------------------------------------------------------------------
// A brief can break a rule of the space it goes to (e.g. "back up right after uploading" while the space's skill says
// "back up once the video is public"). Judging that needs a model, so this only lists the skill lines that share words
// with the brief, most telling first, for the secretary to hold against it.

export interface SkillRule {
  /** Skill shown to the reader: its folder name, or "공통 <이름>" for a common skill. */
  skill: string;
  file: string;
  line: number;
  text: string;
  score: number;
  /** The brief's words found in the line, most telling first. */
  shared: string[];
}

/** Rules shown by default. */
export const RULES_SHOWN = 10;

/** The space a brief belongs to: the nearest folder above it holding AGENTS.md and .agents/skills. */
export function findSpaceRoot(briefFile: string): string | null {
  let dir = path.dirname(path.resolve(briefFile));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'AGENTS.md')) && fs.existsSync(path.join(dir, '.agents', 'skills'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The space's own SKILL.md files and the common ones its common-skills.json names (workspaces/_skills/<name>), each once. */
export function spaceSkillFiles(space: string): Array<{ skill: string; file: string }> {
  const out: Array<{ skill: string; file: string }> = [];
  const seen = new Set<string>();
  const add = (skill: string, file: string) => {
    if (!fs.existsSync(file)) return;
    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {}
    const key = real.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ skill, file });
  };
  let common: string[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(space, 'common-skills.json'), 'utf8'));
    if (Array.isArray(j?.skills)) common = j.skills.filter((s: unknown): s is string => typeof s === 'string');
  } catch {}
  const commonDir = path.join(path.dirname(space), '_skills');
  for (const name of common) add(`공통 ${name}`, path.join(commonDir, name, 'SKILL.md'));
  const skillsDir = path.join(space, '.agents', 'skills');
  let names: string[] = [];
  try {
    names = fs.readdirSync(skillsDir).sort();
  } catch {}
  for (const n of names) add(n.startsWith('common-') ? `공통 ${n.slice('common-'.length)}` : n, path.join(skillsDir, n, 'SKILL.md'));
  return out;
}

/** Rule lines of a SKILL.md: not the front matter, headings, code blocks or the "이유:" (why) lines under a rule. */
export function ruleLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  let inCode = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(```|~~~)/.test(t)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !t || t.startsWith('#') || /^(이유|근거)\s*:/.test(t) || /^\|?[\s:|-]+\|?$/.test(t)) continue;
    out.push({ line: i + 1, text: t });
  }
  return out;
}

/**
 * A path keeps only its last part and a file name loses its usual extension: the folders of an example path
 * ("output/records/…/ep02-…") and ".py" say nothing of the rule.
 */
export function withoutFolders(text: string): string {
  return text
    .replace(/[^\s`'"()<>]*[\\/][^\s`'"()<>]*/g, (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '')
    .replace(/(\w)\.(py|md|json|jsonl|ts|mjs|js|ps1|txt|csv|html)\b/gi, '$1');
}

/** Bigrams a Korean word starts with: its stem ("백업한다" → 백업), unlike the inner ones ("업한"). */
function stemTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const [w] of text.normalize('NFC').toLowerCase().matchAll(/[\p{Script=Hangul}\p{Script=Han}]{2,}/gu)) out.add(Array.from(w).slice(0, 2).join(''));
  return out;
}

/** Inner bigrams of a Korean word count this much of a stem or a Latin word. */
const INNER_WEIGHT = 0.4;

/** Terms of a line worth matching, with their weight: not numbers alone, not one Latin letter. */
function lineTerms(text: string): Map<string, number> {
  const plain = withoutFolders(text);
  const stems = stemTerms(plain);
  const out = new Map<string, number>();
  for (const t of queryTerms(plain)) {
    if (/^\d+$/.test(t) || /^[a-z]$/.test(t)) continue;
    out.set(t, /[\p{Script=Hangul}\p{Script=Han}]/u.test(t) && !stems.has(t) ? INNER_WEIGHT : 1);
  }
  return out;
}

/**
 * The skill lines sharing words with the brief, best first. A shared word counts by how rare it is among all the
 * space's rule lines (a word every rule has tells nothing), and a line needs at least two shared words.
 */
export function skillRulesFor(brief: string, files: Array<{ skill: string; file: string }>, top = RULES_SHOWN): SkillRule[] {
  const have = new Set(searchTerms(withoutFolders(brief)));
  const all: Array<Omit<SkillRule, 'score' | 'shared'> & { terms: Map<string, number> }> = [];
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f.file, 'utf8');
    } catch {
      continue;
    }
    for (const r of ruleLines(text)) all.push({ skill: f.skill, file: f.file, line: r.line, text: r.text, terms: lineTerms(r.text) });
  }
  const df = new Map<string, number>();
  for (const r of all) for (const t of r.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(all.length, 1);
  const idf = (t: string) => Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5));
  const scored: SkillRule[] = [];
  for (const r of all) {
    const weight = (t: string) => idf(t) * (r.terms.get(t) ?? 0);
    const shared = [...r.terms.keys()].filter((t) => have.has(t)).sort((a, b) => weight(b) - weight(a));
    if (shared.filter((t) => r.terms.get(t) === 1).length < 2) continue;
    const score = shared.reduce((s, t) => s + weight(t), 0);
    scored.push({ skill: r.skill, file: r.file, line: r.line, text: r.text, score, shared });
  }
  return scored.sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill) || a.line - b.line).slice(0, Math.max(0, top));
}

export function rulesReport(space: string | null, files: number, rules: SkillRule[], top: number): string {
  if (!space) return '공간 스킬 규칙: 지시서 위쪽 폴더에서 공간(AGENTS.md와 .agents/skills가 있는 곳)을 못 찾음. 그 공간 스킬을 직접 연다.';
  const lines = [`공간 스킬 규칙(지시서와 맞는지 확인): ${space}의 스킬 ${files}개에서 지시서와 낱말이 겹치는 줄 위 ${rules.length}개(최대 ${top}, --rules로 바꿈)`];
  for (const r of rules) {
    lines.push(`- [${r.skill} ${path.basename(path.dirname(r.file))}/SKILL.md:${r.line}] ${r.text.length > 300 ? `${r.text.slice(0, 300)}…` : r.text}`);
    lines.push(`    겹친 말: ${r.shared.slice(0, 8).join(', ')}`);
  }
  if (!rules.length) lines.push('(겹치는 줄 없음)');
  lines.push('→ 지시서의 단계·때·방법이 이 규칙과 어긋나면(예: 규칙은 "공개가 끝난 뒤", 지시서는 "올린 뒤 바로") 지시서를 규칙에 맞추거나, 규칙과 달리 할 까닭을 지시서에 적는다.');
  return lines.join('\n');
}

// ---- report ---------------------------------------------------------------------------------------------------------

/** Lines claiming something is gone, cleaned or never there. */
export const GONE_CLAIM =
  /지웠|지움|지워졌|삭제했|삭제함|삭제됨|삭제 완료|정리했|정리함|치웠|없(다|음|습니다|어요|었|앴)|남지 않|남은 (것|폴더|파일)(이|은)? 없|남기지 않|\b(removed|deleted|cleaned( up)?|no longer (exists?|there)|nothing (is )?left)\b/i;

export interface ReportFinding {
  kind: 'still-there' | 'missing-path' | 'leftover' | 'top-unknown';
  text: string;
}

/** Paths written in a line: a name or path in backticks (one word), or absolute Windows / ./ ../ ones. */
export function pathsIn(line: string): string[] {
  const out = new Set<string>();
  for (const m of line.matchAll(/`([^`\n]+)`/g)) if (!/\s/.test(m[1].trim()) && !m[1].trim().startsWith('-')) out.add(m[1].trim());
  for (const m of line.matchAll(/(?:^|[\s(])([A-Za-z]:[\\/][^\s`'"()]+|\.{1,2}[\\/][^\s`'"()]+)/g)) out.add(m[1]);
  return [...out];
}

function resolveFrom(p: string, roots: string[], reportDir: string): string[] {
  if (path.isAbsolute(p)) return [p];
  return [...roots, reportDir].map((r) => path.resolve(r, p));
}

const LEFTOVER_NAME = /(^|[-_. ])(test|tests|tmp|temp|sandbox|scratch|old|backup|bak|trial|시험|임시)([-_. ]|\d|$)|^_/i;

/** Folders under root (depth up to `depth`) named like a test, temp or scratch folder; node_modules and .git are not entered. */
export function leftoverFolders(root: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git' || e.name === '.claude' || e.name === '.agents') continue;
      const p = path.join(dir, e.name);
      if (LEFTOVER_NAME.test(e.name)) out.push(p);
      if (d < depth) walk(p, d + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** The results' parent folder's entries that are not one of its usual places, and those changed within `hours`. */
export function topReport(top: string, hours: number, now = Date.now()): { unknown: string[]; recent: string[] } {
  const usual = (n: string) => /^(workspaces|notes|inbox|temp)$/i.test(n) || /^secretary/i.test(n) || n.startsWith('.');
  let names: string[] = [];
  try {
    names = fs.readdirSync(top);
  } catch {}
  const recent: string[] = [];
  for (const n of names) {
    try {
      if (now - fs.statSync(path.join(top, n)).mtimeMs < hours * 3600_000) recent.push(n);
    } catch {}
  }
  return { unknown: names.filter((n) => !usual(n)), recent };
}

export function reportCheck(reportText: string, opts: { reportFile: string; roots: string[]; top: string | null; hours: number }): { text: string; findings: ReportFinding[] } {
  const findings: ReportFinding[] = [];
  const reportDir = path.dirname(path.resolve(opts.reportFile));
  const claims: string[] = [];
  const seen = new Set<string>();
  let inCode = false;
  const codePaths: string[] = [];
  for (const raw of reportText.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      if (/^\s*([A-Za-z]:[\\/]|\.{1,2}[\\/])\S/.test(raw) && !/\s-{1,2}\w/.test(raw)) codePaths.push(raw.trim());
      continue;
    }
    if (!GONE_CLAIM.test(raw)) continue;
    claims.push(raw.trim());
    for (const p of pathsIn(raw)) {
      for (const full of resolveFrom(p, opts.roots, reportDir)) {
        if (seen.has(full) || !fs.existsSync(full)) continue;
        seen.add(full);
        findings.push({ kind: 'still-there', text: `주장 "${raw.trim().slice(0, 100)}" ↔ 실제로 있음: ${full}` });
      }
    }
  }
  for (const p of [...new Set([...codePaths, ...reportText.split(/\r?\n/).flatMap((l) => (GONE_CLAIM.test(l) ? [] : pathsIn(l)))])]) {
    const candidates = resolveFrom(p, opts.roots, reportDir);
    if (path.isAbsolute(p) && !fs.existsSync(p)) findings.push({ kind: 'missing-path', text: `보고에 적힌 경로가 없음: ${p}` });
    else if (!path.isAbsolute(p) && /[\\/]/.test(p) && !candidates.some((c) => fs.existsSync(c))) findings.push({ kind: 'missing-path', text: `보고에 적힌 경로를 못 찾음(상대 경로, --root 기준): ${p}` });
  }
  for (const root of opts.roots) for (const f of leftoverFolders(root)) findings.push({ kind: 'leftover', text: `남은 시험·임시 폴더 후보: ${f}` });
  let top: { unknown: string[]; recent: string[] } | null = null;
  if (opts.top) {
    top = topReport(opts.top, opts.hours);
    for (const n of top.unknown) findings.push({ kind: 'top-unknown', text: `결과물 상위 폴더의 낯선 항목: ${path.join(opts.top, n)}` });
  }
  const lines = [
    `보고 대조: ${opts.reportFile}`,
    `"지웠다·없다" 류 주장 ${claims.length}줄${claims.length ? ':' : ''}`,
    ...claims.slice(0, 20).map((c) => `  - ${c.slice(0, 160)}`),
    findings.length ? `걸린 것 ${findings.length}개:` : '걸린 것 없음(경로가 없는 주장은 이 대조로 못 본다: 그 자리를 직접 연다).',
    ...findings.map((f) => `- ${f.text}`),
  ];
  if (top) lines.push(`결과물 상위 폴더 ${opts.top}: 최근 ${opts.hours}시간에 바뀐 항목 ${top.recent.length ? top.recent.join(', ') : '없음'}`);
  lines.push('→ 걸린 것은 보고를 전하기 전에 그 자리를 열어 보고, 주장과 다르면 업무 세션에 묻거나 "확인 안 됨"으로 전한다.');
  return { text: lines.join('\n'), findings };
}

// ---- command line ---------------------------------------------------------------------------------------------------

const USAGE = [
  '사용:',
  '  node bin/delegate-check.mjs brief <지시 파일> --tag <태그> [--tag <태그>]... [--query <말>] [--db <DB 파일>] [--memories <개수>] [--rules <줄 수>]',
  '  node bin/delegate-check.mjs report <보고 파일> [--root <폴더>]... [--top <결과물 상위 폴더>] [--hours <시간>]',
].join('\n');

function flags(args: string[]): { pos: string[]; multi: Record<string, string[]> } {
  const pos: string[] = [];
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && args[i + 1] !== undefined) (multi[a.slice(2)] ??= []).push(args[++i]);
    else pos.push(a);
  }
  return { pos, multi };
}

export function main(argv: string[], out: (s: string) => void = console.log): number {
  const [cmd, ...rest] = argv;
  const { pos, multi } = flags(rest);
  if (cmd === 'brief' && pos.length === 1) {
    const tags = (multi.tag ?? []).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
    if (!tags.length && !multi.query) {
      out('태그(--tag)나 검색어(--query)를 하나 이상 준다(공간 이름, 업무 태그).');
      return 2;
    }
    const brief = fs.readFileSync(pos[0], 'utf8');
    const dbFile = multi.db?.[0] ?? DB_PATH;
    if (!fs.existsSync(dbFile)) {
      out(`기억 DB가 없음: ${dbFile}`);
      return 2;
    }
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const count = (v: string | undefined, dflt: number) => {
        const x = Number(v ?? dflt);
        return Number.isInteger(x) && x >= 0 ? x : dflt;
      };
      const decisions = decisionsFor(db, tags, multi.query?.join(' '));
      const ranked = rankCoverage(brief, briefCoverage(brief, decisions), otherMemories(db, decisions));
      const r = briefReport(pos[0], ranked, tags, count(multi.memories?.[0], MEMORIES_SHOWN));
      out(r.text);
      const shown = count(multi.rules?.[0], RULES_SHOWN);
      const space = findSpaceRoot(pos[0]);
      const files = space ? spaceSkillFiles(space) : [];
      out('');
      out(rulesReport(space, files.length, skillRulesFor(brief, files, shown), shown));
      return r.leftOut ? 1 : 0;
    } finally {
      db.close();
    }
  }
  if (cmd === 'report' && pos.length === 1) {
    const hours = Number(multi.hours?.[0] ?? 24);
    const r = reportCheck(fs.readFileSync(pos[0], 'utf8'), {
      reportFile: pos[0],
      roots: (multi.root ?? []).map((r) => path.resolve(r)),
      top: multi.top?.[0] ? path.resolve(multi.top[0]) : path.dirname(PROJECT_ROOT),
      hours: Number.isFinite(hours) && hours > 0 ? hours : 24,
    });
    out(r.text);
    return r.findings.some((f) => f.kind !== 'top-unknown') ? 1 : 0;
  }
  out(USAGE);
  return 2;
}

if (['delegate-check.mjs', 'delegate-check.ts'].includes(path.basename(process.argv[1] ?? ''))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 2;
  }
}
