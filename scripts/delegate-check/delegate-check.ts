// 위임 앞뒤 대조(기능 'guards'). 비서 폴더 밖에서는 입구 bin/delegate-check.mjs로 부른다.
//   node bin/delegate-check.mjs brief <지시 파일> --tag <태그> [--tag <태그>]... [--query <말>] [--db <DB 파일>]
//     지시서(TASK.md나 지시 파일)와 그 공간·업무 태그가 붙은 결정(decision) 기억을 대조해, 지시서에 안 들어간 듯한 결정을 먼저 보여 준다.
//     기억 DB는 읽기만 한다.
//   node bin/delegate-check.mjs report <보고 파일> [--root <폴더>]... [--top <결과물 상위 폴더>] [--hours <시간>]
//     보고의 "지웠다·없다·남지 않았다" 류 주장과 언급된 경로를 실제 파일·폴더와 대조하고, --root 아래 남은 시험·임시 폴더 후보와
//     결과물 상위 폴더(기본: 비서 폴더의 상위)의 낯선 항목·최근 바뀐 항목을 보여 준다.
// 둘 다 판단은 하지 않고 대조표만 낸다: 빠진 듯한 결정은 지시서에 넣을지, 어긋난 주장은 업무 세션에 물을지 비서가 정한다.
// 종료 코드: 0 = 걸린 것 없음, 1 = 걸린 것 있음(빠진 듯한 결정, 주장과 다른 실제, 없는 경로), 2 = 쓰는 법 오류.
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

export function briefReport(briefFile: string, coverage: Coverage[], tags: string[]): { text: string; leftOut: number } {
  const left = coverage.filter((c) => c.covered < LEFT_OUT_BELOW);
  const lines = [
    `지시서 대조: ${briefFile}`,
    `대조한 결정 기억 ${coverage.length}개(태그: ${tags.join(', ') || '없음'}). 지시서에 안 들어간 듯 ${left.length}개.`,
  ];
  for (const c of coverage) {
    const mark = c.covered < LEFT_OUT_BELOW ? '빠진 듯' : c.missingNames.length ? '일부' : '들어 있음';
    lines.push(
      `- [${mark} ${Math.round(c.covered * 100)}%] #${c.decision.id} (${formatLocal(c.decision.created_at)}, ${c.decision.tags}) ${c.decision.content}` +
        (c.missingNames.length ? `\n    지시서에 없는 이름·숫자: ${c.missingNames.join(', ')}` : ''),
    );
  }
  if (!coverage.length) lines.push('(이 태그의 결정 기억이 없음: 태그가 맞는지 list_topics로 확인한다)');
  lines.push('→ "빠진 듯"·"일부"는 지시서에 넣을지 정한다. 이 일과 상관없는 결정이면 그냥 둔다.');
  return { text: lines.join('\n'), leftOut: left.length };
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
  '  node bin/delegate-check.mjs brief <지시 파일> --tag <태그> [--tag <태그>]... [--query <말>] [--db <DB 파일>]',
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
      const r = briefReport(pos[0], briefCoverage(brief, decisionsFor(db, tags, multi.query?.join(' '))), tags);
      out(r.text);
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
