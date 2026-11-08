/**
 * The Stop hook's checks on the answer a turn ends with (feature 'guards'). Each finds one kind of slip the rules forbid
 * and says how to fix it; settings.ts says which ones send the turn back (block) and which are only told (warn).
 *   english       the answer is written in English (Korean is the rule; code, commands and names aside)
 *   path-prose    a results-folder path inside a sentence (paths go on their own line in a code block; web addresses,
 *                 like the phone address's tap-to-open link under the path's code block, are not paths)
 *   path-preview  a local path (C:\…, X:\…, file:///…, \\host\…, the other PC's folder) with "?" after it: a local preview
 *                 or draft is given without a query string and its options are buttons on the page (https links keep theirs)
 *   path-pair     a code line with a result path on this PC (under an output folder, a report, a note; not the
 *                 secretary's own folder, code or settings files) lacks its other-PC code line
 *   path-link     such a result path lacks its tap-to-open link to the phone address ([주소](주소), outside the code
 *                 blocks; only when the dashboard gives a phone address)
 *   path-block    a path on this PC and one on the other PC share one code block (each path goes in a code block of its
 *                 own, so either copies alone)
 *   next-action   the answer has no "다음 행동 및 순서:" line (short answers aside)
 *   open-questions the answer asks labelled questions ("A. …?") without a "남은 질문:" line (short answers aside)
 *   recommend-basis an option marked "(추천)" has no "근거:" line right under it (short answers aside)
 */
import path from 'node:path';
import { LABEL_LINE, parseQuestions, parseRemaining } from '../board/open-questions.ts';
import type { GuardSettings } from './settings.ts';

/** What the path checks need: the results folder, its other-PC and phone forms, and the secretary's own folder. */
export type PathRoots = Pick<GuardSettings, 'aiRoot' | 'otherPcRoot' | 'phoneRoot'> & { secretaryDir?: string | null };

export interface Finding {
  check: string;
  reason: string;
  /**
   * A catch of a check that is otherwise fixed by lines added after the answer (stop-guard.ts FILL_CHECKS) that this time
   * cannot be: the answer is written again whole.
   */
  rewrite?: boolean;
}

/** What the app writes in the model's place: never the model's own English. */
export const SYSTEM_TEXTS: RegExp[] = [
  /^You've hit your .*limit/i,
  /^API Error\b/i,
  /^Prompt is too long/i,
  /^Credit balance is too low/i,
  /^No response requested\.?$/i,
  /^Claude AI usage limit reached/i,
  /^Request timed out/i,
  /^Invalid API key/i,
  /^OAuth token/i,
  /^This conversation is too long/i,
  /^Execution error$/i,
];

/** Lines every answer ends with in Korean, whatever the body: left out of the language count. */
const TEMPLATE_LINE = /^\s*(?:[-*]\s*)?\**\s*(남은 질문|다음 행동)|^\s*>\s*(이어서|🎤)/;

/** The text a reader reads: without code blocks, inline code, addresses and paths. */
export function proseOnly(text: string): string {
  return text
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b(?:https?|file):\/\/\S+/gi, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
    .split('\n')
    .filter((l) => !TEMPLATE_LINE.test(l))
    .join('\n');
}

/** Hangul syllables over Hangul plus Latin letters in the prose; null when it has fewer than 2 letters of either. */
export function hangulRatio(text: string): { hangul: number; latin: number; ratio: number } | null {
  const prose = proseOnly(text);
  const hangul = (prose.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length;
  if (hangul + latin < 2 || latin < 2) return null;
  return { hangul, latin, ratio: hangul / (hangul + latin) };
}

/**
 * Below this an answer is English. Measured on 2,762 past answers: those in Korean all sat at 0.46 or above (code, paths
 * and the closing lines taken out), the English ones at 0, whatever their length.
 */
export const KOREAN_MIN_RATIO = 0.4;

export function checkEnglish(answer: string): Finding | null {
  const first = answer.trim().split('\n')[0] ?? '';
  if (SYSTEM_TEXTS.some((re) => re.test(first))) return null;
  const r = hangulRatio(answer);
  if (!r || r.ratio >= KOREAN_MIN_RATIO) return null;
  return {
    check: 'english',
    reason: `방금 답이 영어로 쓰였다(한글 비율 ${Math.round(r.ratio * 100)}%). 답은 언제나 한국어로 쓴다. 같은 내용을 한국어로 다시 써서 답을 끝낸다(코드·명령·고유명사는 그대로).`,
  };
}

// ---- paths -------------------------------------------------------------------------------------------------------

/** For comparing: forward slashes, no doubled ones, no trailing one, lower case. */
export const plainPath = (s: string) => s.replace(/\\+/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();

/** Lines inside fenced code blocks and outside them. */
export function splitFences(text: string): { code: string[]; prose: string[] } {
  const code: string[] = [];
  const prose: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m) {
      if (fence === null) fence = m[1];
      else if (fence === m[1]) fence = null;
      continue;
    }
    (fence === null ? prose : code).push(line);
  }
  return { code, prose };
}

/** "C:\a\b" as it may appear: either slash, any case. */
function rootPattern(root: string): RegExp {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`${parts.join('[\\\\/]+')}(?=[\\\\/]|$|[\\s\`'")])`, 'i');
}

/** The part of a bare path line under root ('' for root itself), or null when the line is not one. */
export function relUnder(line: string, root: string): string | null {
  let s = line.trim().replace(/^["'`]|["'`]$/g, '');
  s = s.replace(/^file:\/\/\//i, '');
  const r = plainPath(root);
  const p = plainPath(s);
  if (p !== r && !p.startsWith(`${r}/`)) return null;
  return s.replace(/\\/g, '/').slice(r.length).replace(/^\/+/, '');
}

/** A line that is one path and nothing else (no command around it, no flags). */
const bareDrivePath = (line: string) => /^["'`]?[A-Za-z]:[\\/]/.test(line.trim()) && !/\s-{1,2}[A-Za-z]/.test(line) && (line.trim().match(/[A-Za-z]:[\\/]/g) ?? []).length === 1;

/** Folders that hold results whatever is in them. */
const OUTPUT_SEGMENT = /^(output|outputs|result|results)$/i;
/** Folders of code and settings (a workspace's own tools, the app's folders). */
const CODE_SEGMENTS = new Set(['src', 'scripts', 'bin', 'lib', 'test', 'tests', 'node_modules', '.claude', '.agents', '.git', '.github', '.vscode']);
/** Code and settings files. */
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|ps1|psm1|psd1|py|sh|bash|cmd|bat|json|jsonc|jsonl|ya?ml|toml|ini|cfg|conf|env|lock|gitignore|gitattributes)$/i;

/**
 * Whether a path under the results folder (relative, / separated) is a result to open on the other PC: never in the
 * secretary's own folder (no results live there); anything under an output folder; else not code or settings.
 */
export function isResultPath(rel: string, secretaryName?: string | null): boolean {
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return false;
  if (secretaryName && parts[0].toLowerCase() === secretaryName.toLowerCase()) return false;
  if (parts.some((p) => OUTPUT_SEGMENT.test(p))) return true;
  if (parts.some((p) => CODE_SEGMENTS.has(p.toLowerCase()))) return false;
  return !CODE_FILE.test(parts.at(-1)!);
}

/** A local path as written: file:///…, a drive (C:\, X:/), a share (\\host\…). Up to whitespace or a quote. */
const LOCAL_PATH = /file:\/\/\/?[^\s`'"<>]+|(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s`'"<>]*|\\\\[^\s\\`'"<>]+\\[^\s`'"<>]*/g;
/** A web address up to whitespace or the ")" that closes a Markdown link. */
const WEB_ADDRESS = /\bhttps?:\/\/[^\s)]+/gi;
/** "?" with something after it (a query string, not a question mark ending a sentence). */
const QUERY = /\?[^\s?)\]]/;

/** The first line with a local path carrying a query string (web addresses left out), or null. */
export function localQueryLine(text: string, otherPcRoot: string | null): string | null {
  const other = otherPcRoot ? rootPattern(otherPcRoot) : null;
  for (const l of text.split('\n')) {
    const bare = l.replace(WEB_ADDRESS, ' ');
    if ((bare.match(LOCAL_PATH) ?? []).some((p) => QUERY.test(p))) return l;
    const m = other?.exec(bare);
    if (m && /^[^\s`'"]*\?[^\s?)\]]/.test(bare.slice(m.index + m[0].length))) return l;
  }
  return null;
}

export function checkPaths(answer: string, s: PathRoots): Finding[] {
  const out: Finding[] = [];
  const { code, prose } = splitFences(answer);
  const roots = [s.aiRoot, ...(s.otherPcRoot ? [s.otherPcRoot] : [])].map(rootPattern);
  const name = path.basename(s.aiRoot);

  // 1. A results path inside a sentence (inline code counts: it still sits in the sentence). Web addresses are left out:
  //    the dashboard's phone address goes under the path's code block as a link one can tap ([https://…](https://…)), and its path
  //    (…/share/<name>/…) is not a local path.
  const inProse = prose.find((l) => {
    const bare = l.replace(WEB_ADDRESS, ' ');
    return roots.some((re) => re.test(bare));
  });
  if (inProse) {
    out.push({
      check: 'path-prose',
      reason: `본문 문장 속에 ${name} 폴더 경로가 있다("${inProse.trim().slice(0, 120)}"). 파일·폴더 경로는 문장에 섞지 않고 코드 블록(\`\`\`)에 한 줄씩 따로 쓴다. 그 경로를 코드 블록으로 다시 적어 답을 마무리한다.`,
    });
  }

  // 2. A local path with a query string: Chrome turns "?" into %3F in the drive form, and options belong on the page.
  const bad = localQueryLine(answer, s.otherPcRoot);
  if (bad) {
    out.push({
      check: 'path-preview',
      reason: `로컬 경로 뒤에 ?(쿼리스트링)가 붙었다("${bad.trim().slice(0, 120)}"). 로컬 미리보기·시안은 쿼리스트링 없는 주소로 주고, 옵션(정지 화면, 장면 고르기 등)은 페이지 안 버튼으로 둔다. ? 없이 다시 적고, 옵션이 필요하면 페이지에 버튼을 넣게 한다(외부 https 링크의 쿼리스트링은 그대로 둬도 된다).`,
    });
  }

  // 3. Each bare result path on this PC in a code line has its other-PC code line (path-pair) and, when the dashboard
  //    gives a phone address, a tap-to-open link to it outside the code blocks (path-link): the three lines a result
  //    path is given in. Either may sit anywhere in the answer, in any code block (lines added after an answer sent back
  //    for them count: stop-guard.ts 'fill'; both in one block is path-block's catch, not a missing pair). A phone
  //    address on a code line (the older form) is let be: it neither counts nor is caught.
  if (s.otherPcRoot || s.phoneRoot) {
    const lines = code.map((l) => l.trim()).filter(Boolean);
    const otherRels = new Set(s.otherPcRoot ? lines.map((l) => relUnder(l, s.otherPcRoot!)).filter((r): r is string => r !== null).map(plainPath) : []);
    const linkRels = new Set(s.phoneRoot ? phoneLinkRels(prose, s.phoneRoot) : []);
    const noPair: string[] = [];
    const noLink: string[] = [];
    for (const l of lines) {
      if (!bareDrivePath(l)) continue;
      const rel = relUnder(l, s.aiRoot);
      if (rel === null || rel === '') continue;
      const key = plainPath(rel.split('?')[0]);
      if (!isResultPath(key, s.secretaryDir ? path.basename(s.secretaryDir) : null)) continue;
      if (s.otherPcRoot && !otherRels.has(plainPath(rel)) && !otherRels.has(key)) noPair.push(rel);
      if (s.phoneRoot && !linkRels.has(key)) noLink.push(rel);
    }
    const list = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ` 외 ${xs.length - 3}개` : ''}`;
    if (noPair.length) {
      out.push({
        check: 'path-pair',
        reason: `${name} 안 결과물 경로에 다른 PC 경로 줄이 빠졌다: ${list(noPair)}. 이 PC 경로 코드 블록 아래에 다른 PC: ${s.otherPcRoot}\\<같은 경로> 줄을 자기 코드 블록으로 따로 붙인다(한 블록에 같이 넣지 않는다).`,
      });
    }
    if (noLink.length) {
      out.push({
        check: 'path-link',
        reason: `${name} 안 결과물 경로에 누르면 열리는 링크 줄이 빠졌다: ${list(noLink)}. 경로 코드 블록 바로 아래(블록 밖)에 [${s.phoneRoot}/<같은 경로>](같은 주소) 꼴로 주소 자체를 링크 이름으로 쓴 링크 한 줄을 붙인다(/ 로 잇고 공백은 %20, 주소 속 괄호는 %28·%29). 폰 주소를 코드 줄로 따로 쓰지 않는다.`,
      });
    }
  }

  // 4. Each path in a code block of its own: a block holding a path line on this PC and one on the other PC is caught
  //    (copying one takes the other along). Unless each of its paths is written again further down in a block that does
  //    not mix them (the blocks added after an answer sent back for it: stop-guard.ts 'fill').
  if (s.otherPcRoot) {
    const mixed = mixedPathBlocks(answer, s.aiRoot, s.otherPcRoot);
    if (mixed.length) {
      const list = `${mixed.slice(0, 3).join(', ')}${mixed.length > 3 ? ` 외 ${mixed.length - 3}개` : ''}`;
      out.push({
        check: 'path-block',
        reason: `이 PC 경로와 다른 PC 경로를 코드 블록 하나에 같이 넣었다: ${list}. 경로 하나마다 자기 코드 블록을 따로 쓴다(이 PC 경로 블록, 다른 PC 경로 블록, 그 아래 블록 밖에 링크 줄 순서).`,
      });
    }
  }
  return out;
}

/**
 * The paths (this PC's form, else the other PC's) of the code blocks that hold both a path line under aiRoot and one
 * under otherPcRoot, leaving out a block whose every path line is written again in a later block that mixes nothing.
 */
export function mixedPathBlocks(text: string, aiRoot: string, otherPcRoot: string): string[] {
  const blocks: { here: string[]; there: string[] }[] = [];
  let fence: string | null = null;
  let cur: { here: string[]; there: string[] } | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m) {
      if (fence === null) {
        fence = m[1];
        cur = { here: [], there: [] };
      } else if (fence === m[1]) {
        fence = null;
        if (cur) blocks.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur) continue;
    const l = line.trim();
    if (!l || (l.match(/[A-Za-z]:[\\/]|\\\\/g) ?? []).length > 1) continue;
    const here = relUnder(l, aiRoot);
    const there = here === null ? relUnder(l, otherPcRoot) : null;
    if (here !== null) cur.here.push(plainPath(here.split('?')[0]));
    else if (there !== null) cur.there.push(plainPath(there.split('?')[0]));
  }
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (!b.here.length || !b.there.length) return;
    const later = blocks.slice(i + 1).filter((x) => !x.here.length || !x.there.length);
    const hereLater = new Set(later.flatMap((x) => x.here));
    const thereLater = new Set(later.flatMap((x) => x.there));
    if (b.here.every((r) => hereLater.has(r)) && b.there.every((r) => thereLater.has(r))) return;
    out.push(...b.here.map((r) => r || '.'));
  });
  return [...new Set(out)];
}

/** The paths under phoneRoot (decoded, without a query string, as plainPath) that Markdown links outside code point to. */
export function phoneLinkRels(prose: string[], phoneRoot: string): string[] {
  const root = phoneRoot.replace(/\/+$/, '').toLowerCase();
  const out: string[] = [];
  for (const l of prose) {
    for (const m of l.matchAll(LINK_TARGET)) {
      const t = m[1];
      if (!t.toLowerCase().startsWith(`${root}/`)) continue;
      let rel = t.slice(root.length + 1).split('?')[0].replace(/%28/gi, '(').replace(/%29/gi, ')');
      try {
        rel = decodeURIComponent(rel);
      } catch {
        // left as written
      }
      out.push(plainPath(rel));
    }
  }
  return out;
}

/** A Markdown link's target, up to the ")" that closes it (a "(" inside is written %28). */
const LINK_TARGET = /\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi;

// ---- the answer's closing lines ----------------------------------------------------------------------------------

/** The closing line every answer ends with ("다음 행동 및 순서: …", also as a list item or in bold). */
const NEXT_LINE = /^\s*(?:[-*>]\s*)?\**\s*다음 행동(?:\s*및\s*순서)?\s*\**\s*[:：]/m;

/** An answer this short (non-empty lines) is a quick reply ("기다릴게요"): its closing lines are not asked for. */
export const SHORT_ANSWER_LINES = 2;

/**
 * The closing lines: "다음 행동 및 순서:" at the end of every answer (next-action), and "남은 질문:" under an answer that
 * asks labelled questions ("A. …?", open-questions). Code blocks are left out; a short answer is not checked (the rule's
 * own exceptions, like an explanation asked for, cannot be told apart by a script, so the short ones stand for them).
 */
export function checkClosing(answer: string): Finding[] {
  const prose = splitFences(answer).prose.join('\n');
  if (prose.split('\n').filter((l) => l.trim()).length <= SHORT_ANSWER_LINES) return [];
  const out: Finding[] = [];
  const asked = Object.keys(parseQuestions(prose));
  if (asked.length && parseRemaining(prose) === null) {
    out.push({
      check: 'open-questions',
      reason: `질문(${asked.slice(0, 5).join(', ')})을 물었는데 "남은 질문:" 줄이 없다. 답 끝("다음 행동" 위)에 "남은 질문: ${asked.join(', ')}"처럼 아직 답을 못 받은 질문 기호를 한 줄로 붙인다.`,
    });
  }
  if (!NEXT_LINE.test(prose)) {
    out.push({
      check: 'next-action',
      reason: '답 끝에 "다음 행동 및 순서:" 줄이 없다. 사용자가 이 대화에서 지금 할 일을 순서대로 적고, 없으면 "다음 행동 및 순서: 없음"(백그라운드 일이 돌면 괄호에 기다리시면 된다는 말)을 붙인다.',
    });
  }
  return out;
}

// ---- recommendations -------------------------------------------------------------------------------------------

/** An option line: "1. …", "2) …", "- 1. …", "**1.** …". */
const OPTION_LINE = /^\s*(?:[-*]\s*)?\**\d{1,2}[.)]\**\s+\S/;
const RECOMMENDED = /\(추천\)/;
/** "근거: …" (indented or not, quoted with ">", as a list item or in bold). */
const BASIS_LINE = /^\s*(?:>\s*)?(?:[-*]\s*)?\**\s*근거\s*\**\s*[:：]/;

export interface UnbackedPick {
  /** The question's label, or null for options under no labelled question. */
  label: string | null;
  /** The option line, trimmed. */
  option: string;
}

/**
 * The options marked "(추천)" whose next line is not "근거: …" (the rule: the reason right under the pick it backs, what
 * was checked this turn or in this talk, or "근거: 확인 안 함(짐작)"). Code blocks and inline code are left out (a rule
 * or an example quoted). A labelled question asked again further down counts by its last block only: the block written
 * again with its basis lines, after an answer sent back for them (stop-guard.ts 'fill'), replaces the first.
 */
export function unbackedPicks(answer: string): UnbackedPick[] {
  // Code lines blanked, not dropped, so that a line's neighbour stays its neighbour.
  let fence: string | null = null;
  const lines = answer.split(/\r?\n/).map((l) => {
    const m = /^\s*(```|~~~)/.exec(l);
    if (m) {
      if (fence === null) fence = m[1];
      else if (fence === m[1]) fence = null;
      return '';
    }
    return fence === null ? l.replace(/`[^`\n]*`/g, ' ') : '';
  });
  const byLabel = new Map<string, UnbackedPick[]>();
  const unlabelled: UnbackedPick[] = [];
  let label: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const q = LABEL_LINE.exec(l);
    if (q) {
      label = q[1];
      // Asked again: this block replaces the earlier one.
      byLabel.set(label, []);
      continue;
    }
    if (OPTION_LINE.test(l)) {
      if (RECOMMENDED.test(l) && !BASIS_LINE.test(lines[i + 1] ?? '')) {
        const pick = { label, option: l.trim() };
        if (label === null) unlabelled.push(pick);
        else byLabel.get(label)!.push(pick);
      }
      continue;
    }
    // Blank lines, basis lines and the options' indented lines stay in the question; any other line ends it.
    if (l.trim() && !BASIS_LINE.test(l) && !/^\s+\S/.test(l)) label = null;
  }
  return [...[...byLabel.values()].flat(), ...unlabelled];
}

export function checkRecommendBasis(answer: string): Finding | null {
  const prose = splitFences(answer).prose.join('\n');
  if (prose.split('\n').filter((l) => l.trim()).length <= SHORT_ANSWER_LINES) return null;
  const picks = unbackedPicks(answer);
  if (!picks.length) return null;
  const named = picks.slice(0, 3).map((p) => `${p.label ? `${p.label}의 ` : ''}"${p.option.slice(0, 60)}"`);
  return {
    check: 'recommend-basis',
    reason: `"(추천)"을 단 선택지 바로 아래에 근거 줄이 없다: ${named.join(', ')}${picks.length > 3 ? ` 외 ${picks.length - 3}개` : ''}. 추천한 선택지 줄 바로 아래에 들여쓴 인용 줄 "> 근거:" 하나를 붙인다. 근거는 이 턴(또는 이 대화)에서 실제로 확인한 것(연 파일, 기록, 명령 출력, 숫자, 기억 번호)을 짧게 쓰고, 확인하지 못했으면 "근거: 확인 안 함(짐작)"으로 쓴다. 확인할 수 있으면 지금 확인하고 쓴다.`,
    // Options under no labelled question cannot be written again as "that question's block": the whole answer is.
    ...(picks.some((p) => p.label === null) ? { rewrite: true } : {}),
  };
}

/** Every check on one answer. */
export function checkAnswer(answer: string, s: PathRoots): Finding[] {
  if (!answer.trim()) return [];
  return [checkEnglish(answer), ...checkPaths(answer, s), ...checkClosing(answer), checkRecommendBasis(answer)].filter((f): f is Finding => f !== null);
}
