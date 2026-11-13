/**
 * The Stop hook's checks on the answer a turn ends with (feature 'mistake-guards'). Each finds one kind of slip the rules forbid
 * and says how to fix it. What each check is, its level and how it is told: answer-check-table.ts, one row per check.
 */
import path from 'node:path';
import { BASIS_GUESS, BASIS_UNABLE } from '../core/basis-forms.ts';
import { LABEL_LINE } from '../session-continuity/open-questions.ts';
import type { CheckId } from './answer-check-table.ts';
import type { GuardSettings } from './mistake-guard-settings.ts';
import { readBasisSources, unopenedReportPaths, type Seen } from './seen-sources.ts';

/** What the path checks need: the results folder, its other-PC and phone forms, and the secretary's own folder. */
export type PathRoots = Pick<GuardSettings, 'aiRoot' | 'otherPcRoot' | 'phoneRoot'> & { secretaryDir?: string | null };

export interface Finding {
  check: CheckId;
  reason: string;
  /**
   * A catch of a check that is otherwise fixed by lines added after the answer (answer-check-table.ts `fill`) that this time
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
const TEMPLATE_LINE = /^\s*(?:[-*]\s*)?(?:\**\d{1,2}[.)]\**\s*)?\**\s*(남은 질문|다음 행동)|^\s*>\s*(이어서|🎤)/;

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

/** A web address up to whitespace or the ")" that closes a Markdown link. */
const WEB_ADDRESS = /\bhttps?:\/\/[^\s)]+/gi;

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
      reason: `본문 문장 속에 ${name} 폴더 경로가 있다("${inProse.trim().slice(0, 120)}"). 파일·폴더 경로는 복사하기 쉽게 경로 하나마다 코드 블록(\`\`\`) 하나에 따로 쓴다. 그 경로를 코드 블록으로 다시 적어 답을 마무리한다.`,
    });
  }

  // 2. Each bare result path on this PC in a code line has its other-PC code line (path-pair) and, when the dashboard
  //    gives a phone address, a tap-to-open link to it outside the code blocks (path-link): the three lines a result
  //    path is given in. Either may sit anywhere in the answer, in any code block (lines added after an answer sent back
  //    for them count: stop-guard.ts 'fill'). A phone address on a code line (the older form) is let be: it neither counts
  //    nor is caught.
  if (s.otherPcRoot || s.phoneRoot) {
    const lines = code.map((l) => l.trim()).filter(Boolean);
    const otherRels = new Set(s.otherPcRoot ? lines.map((l) => relUnder(l, s.otherPcRoot!)).filter((r): r is string => r !== null).map(plainPath) : []);
    const links = s.phoneRoot ? phoneLinks(prose, s.phoneRoot) : [];
    const linkRels = new Set(links.map((k) => k.rel));
    const namedRels = new Set(links.filter((k) => k.named).map((k) => k.rel));
    const noPair: string[] = [];
    const noLink: string[] = [];
    const misnamed: string[] = [];
    for (const l of lines) {
      if (!bareDrivePath(l)) continue;
      const rel = relUnder(l, s.aiRoot);
      if (rel === null || rel === '') continue;
      const key = plainPath(rel.split('?')[0]);
      if (!isResultPath(key, s.secretaryDir ? path.basename(s.secretaryDir) : null)) continue;
      if (s.otherPcRoot && !otherRels.has(plainPath(rel)) && !otherRels.has(key)) noPair.push(rel);
      if (s.phoneRoot && !linkRels.has(key)) noLink.push(rel);
      else if (s.phoneRoot && !namedRels.has(key)) misnamed.push(rel);
    }
    const list = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ` 외 ${xs.length - 3}개` : ''}`;
    if (noPair.length) {
      out.push({
        check: 'path-pair',
        reason: `${name} 안 결과물 경로에 다른 PC 경로 줄이 빠졌다: ${list(noPair)}. 이 PC 경로 코드 블록 아래에 다른 PC: ${s.otherPcRoot}\\<같은 경로> 줄을 자기 코드 블록으로 따로 붙인다(경로 하나에 코드 블록 하나).`,
      });
    }
    if (noLink.length || misnamed.length) {
      const how = `경로 코드 블록 바로 아래(블록 밖)에 [${s.phoneRoot}/<같은 경로>](같은 주소) 형식으로 주소 자체를 링크 이름으로 쓴 링크 한 줄을 붙인다(/ 로 잇고 공백은 %20, 주소 속 괄호는 %28·%29). 폰 주소는 이 링크 줄로만 쓴다.`;
      const what = [
        ...(noLink.length ? [`${name} 안 결과물 경로에 누르면 열리는 링크 줄이 빠졌다: ${list(noLink)}.`] : []),
        ...(misnamed.length
          ? [`${name} 안 결과물 경로의 폰 링크 이름이 주소가 아니다: ${list(misnamed)}. 링크 이름은 "폰에서 열기" 같은 말이나 로컬 경로가 아니라 링크 주소를 그대로 쓴다([주소](주소)).`]
          : []),
      ];
      out.push({ check: 'path-link', reason: `${what.join(' ')} ${how}` });
    }
  }
  return out;
}

/** The paths under phoneRoot (decoded, without a query string, as plainPath) that Markdown links outside code point to. */
export function phoneLinkRels(prose: string[], phoneRoot: string): string[] {
  return phoneLinks(prose, phoneRoot).map((l) => l.rel);
}

/** An address as read, for comparing a link's name with its target: %-escapes decoded, no trailing slash, lower case. */
function readAddress(s: string): string {
  let a = s.trim().replace(/^<|>$/g, '').replace(/%28/gi, '(').replace(/%29/gi, ')');
  try {
    a = decodeURIComponent(a);
  } catch {
    // left as written
  }
  return a.replace(/\/+$/, '').toLowerCase();
}

/**
 * The Markdown links outside code to an address under phoneRoot: the path they point to (as phoneLinkRels gives it) and
 * whether the link's name is that address itself ([주소](주소), decided 2026-11-07), written either escaped or decoded.
 * A name other than the address ("폰에서 열기", a local path) hides where the link goes, so it does not count as the link.
 */
export function phoneLinks(prose: string[], phoneRoot: string): { rel: string; named: boolean }[] {
  const root = phoneRoot.replace(/\/+$/, '').toLowerCase();
  const out: { rel: string; named: boolean }[] = [];
  for (const l of prose) {
    for (const m of l.matchAll(LINK)) {
      const t = m[2];
      if (!t.toLowerCase().startsWith(`${root}/`)) continue;
      let rel = t.slice(root.length + 1).split('?')[0].replace(/%28/gi, '(').replace(/%29/gi, ')');
      try {
        rel = decodeURIComponent(rel);
      } catch {
        // left as written
      }
      out.push({ rel: plainPath(rel), named: readAddress(m[1]) === readAddress(t) });
    }
  }
  return out;
}

/** A Markdown link: its name (no "]" inside) and its target, up to the ")" that closes it (a "(" inside is written %28). */
const LINK = /\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi;

/** An answer this short (non-empty lines) is a quick reply ("기다릴게요"): the recommendation checks pass it by. */
export const SHORT_ANSWER_LINES = 2;

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
 * The options marked "(추천)" with no "근거: …" line right under them or right after their indented detail lines (backedAt; the rule: the reason right under the pick it backs, what
 * was checked this turn or in this talk, or "근거: 확인할 자료 없음(짐작)"). Code blocks and inline code are left out (a rule
 * or an example quoted). A labelled question asked again further down counts by its last block only: the block written
 * again with its basis lines, after an answer sent back for them (stop-guard.ts 'fill'), replaces the first.
 */
/**
 * Whether the "(추천)" option at line i has its basis: the next line, or the first line after the option's own indented
 * lines (its details, a sub-list) that is not one of them. The next option, a blank line or an unindented paragraph comes
 * first: no basis.
 */
function backedAt(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (BASIS_LINE.test(l)) return true;
    if (OPTION_LINE.test(l) || !/^\s+\S/.test(l)) return false;
  }
  return false;
}

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
      if (RECOMMENDED.test(l) && !backedAt(lines, i)) {
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
    reason: `"(추천)"을 단 선택지 아래(바로 다음 줄, 또는 그 선택지에 들여쓴 세부 줄 바로 뒤)에 추천 근거("> 근거:" 줄)가 없다: ${named.join(', ')}${picks.length > 3 ? ` 외 ${picks.length - 3}개` : ''}. 추천한 선택지 줄 바로 아래에 들여쓴 인용 줄 "> 근거:" 하나를 붙인다. 선택지에 들여쓴 세부 줄(목록 등)이 딸려 있으면 그 줄들 바로 뒤, 다음 선택지 앞에 붙인다. 빈 줄이나 들여쓰지 않은 문단 뒤, 다음 선택지 뒤의 근거는 그 추천의 근거로 치지 않는다. 근거는 이 턴(또는 이 대화)에서 실제로 확인한 것(연 파일, 기록, 명령 출력, 숫자, 기억 번호)을 짧게 쓴다. 확인할 자료가 있으면 지금 열어 보고 쓰고(끝내 못 열었을 때만 "근거: ${BASIS_UNABLE}"), 확인할 자료가 원래 없는 짐작이면 "근거: ${BASIS_GUESS}"으로 쓴다.`,
    // Options under no labelled question cannot be written again as "that question's block": the whole answer is.
    ...(picks.some((p) => p.label === null) ? { rewrite: true } : {}),
  };
}

/** A basis that says it was not looked at. */
const NOT_LOOKED = /확인\s*안\s*(?:함|했|됨)|안\s*(?:봄|봤|열었|열어\s*봄)|못\s*(?:봄|봤|열었|열어\s*봄)|미확인/;
/**
 * Something in a basis one could open this turn: inline code (a command, a path), a file name, a line number, a memory or
 * log number, a path, a report, a record. The rule (AGENTS.md, decided 2026-11-10): with such a thing, open it and say what
 * was seen; "근거: 확인할 자료 없음(짐작)" is for a guess no record can settle.
 */
const CHECKABLE: [string, RegExp][] = [
  ['명령·경로', /`[^`\n]+`/],
  ['파일 이름', /[\w가-힣.-]+\.(?:tsx?|mts|mjs|cjs|jsx?|jsonl?|md|ps1|py|sh|txt|ya?ml|toml|csv|html?|css|log|db|ini|env)\b/i],
  ['줄 번호', /\d+\s*줄/],
  ['기록 번호', /#\d+|기억\s*\d+/],
  ['경로', /[A-Za-z]:[\\/]|[\w.-]+\/[\w.-]+/],
  ['보고', /보고|서브에이전트|run-?job|업무 세션/],
  // "기록" alone is left out: "기록에 없음" says there is nothing to open.
  ['명령', /명령|출력|로그/],
];

/**
 * Quoted words ("…", “…”, ‘…’, '…', 「…」, 『…』): what a rule or a record says, not what the basis says of itself. A basis
 * quoting the rule's "확인 안 됨" was caught as not looked at (2026-11-10).
 */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*'|「[^」\n]*」|『[^』\n]*』/g;
const INLINE_CODE = /`[^`\n]*`/g;
/**
 * "자료 있음, 못 봄(<무엇>, 이유: <못 연 이유>)": the form for something there that could not be opened this turn (AGENTS.md
 * 추천 근거: only when it still could not be opened by the end of the turn). Not looking needs no reason, not being able to
 * does (decided 2026-11-12), so the form counts only with a reason after "이유:". Group 1: what is in the parentheses.
 */
const UNABLE = /자료\s*있음\s*[,，·]?\s*못\s*봄\s*(?:\(((?:[^()\n]|\([^()\n]*\))*)\))?/dg;
/** The reason in the form's parentheses: "이유:" with something after it. */
const UNABLE_REASON = /이유\s*[:：]\s*[^\s,，.。)]/;
const blank = (s: string, re: RegExp) => s.replace(re, (m) => ' '.repeat(m.length));

export interface BasisRead {
  line: string;
  /** What it names that one could open and did not (basis-unopened). */
  unopened: string[];
  /** Uses "자료 있음, 못 봄" without the reason it could not be opened after "이유:" (basis-unopened). */
  noReason: boolean;
  /** Says it was not looked at and names nothing to open: the old form (basis-old-form). */
  oldForm: boolean;
}

/**
 * The basis lines (outside code blocks) that say something was not looked at, read in two parts. The form "자료 있음, 못
 * 봄(<무엇>, 이유: <못 연 이유>)" is judged by its reason alone: with one it passes whatever it names (a file, a command,
 * a line number); without it → unopened. The rest of the line, quotes and inline code aside, says "확인 안 함"/"안 봄"
 * (the old "자료 있음, 안 봄(<무엇>)" too) or not: naming something to open → unopened ("근거: paths.ts 21줄(확인 안 함)");
 * naming nothing → the old form ("근거: 확인 안 함(짐작)"). So a line is one of the two, never both, and a sentence after
 * the form ("…못 봄(화면, 이유: …). 서브에이전트가 연 문서에는 …") is not caught by the form's "못 봄".
 */
export function readBases(answer: string): BasisRead[] {
  const out: BasisRead[] = [];
  for (const l of splitFences(answer).prose) {
    if (!BASIS_LINE.test(l)) continue;
    // Positions kept, so the form found outside quotes is cut from the line as written too, and its reason read there
    // (a reason may quote what it could not open).
    const unquoted = blank(l, QUOTED);
    let noReason = false;
    let rest = l;
    let said = unquoted;
    for (const m of unquoted.matchAll(UNABLE)) {
      const at = m.indices?.[1];
      const inside = at ? l.slice(at[0], at[1]) : '';
      if (!UNABLE_REASON.test(inside)) noReason = true;
      const cut = (s: string) => s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
      rest = cut(rest);
      said = cut(said);
    }
    const names = new Set<string>();
    const notLooked = NOT_LOOKED.test(blank(said, INLINE_CODE));
    if (notLooked) for (const [n, re] of CHECKABLE) if (re.test(rest)) names.add(n);
    if (names.size || notLooked || noReason) out.push({ line: l.trim(), unopened: [...names], noReason, oldForm: notLooked && !names.size });
  }
  return out;
}

/** The basis lines that name something one could open and say it was not looked at, each with what it names. */
export function unopenedBases(answer: string): { line: string; names: string[] }[] {
  return readBases(answer)
    .filter((b) => b.unopened.length)
    .map((b) => ({ line: b.line, names: b.unopened }));
}

const listed = (lines: string[]) => `${lines.slice(0, 3).join(', ')}${lines.length > 3 ? ` 외 ${lines.length - 3}개` : ''}`;

/** The two forms a basis is written in, said after a catch. */
const BASIS_FORMS = `근거는 두 형식 중 하나로 쓴다: 확인할 자료가 있으면 열어 보고 본 것을 쓰고, 그 턴에 끝내 열지 못했을 때만 "근거: ${BASIS_UNABLE}"으로 못 연 까닭까지 쓴다. 확인할 자료가 원래 없는 짐작이면 "근거: ${BASIS_GUESS}"으로 쓴다.`;

export function checkBasisUnopened(answer: string): Finding | null {
  const bases = readBases(answer);
  const found = bases.filter((b) => b.unopened.length);
  const noReason = bases.filter((b) => b.noReason);
  if (!found.length && !noReason.length) return null;
  const what = [
    ...(found.length
      ? [`추천 근거에 확인할 수 있는 자료를 적고 "확인 안 함"·"안 봄"으로 넘겼다: ${listed(found.map((f) => `"${f.line.slice(0, 80)}"(${f.unopened.join('·')})`))}. 자료가 있으니 열어 확인하고 무엇을 봤는지 근거로 쓴다.`]
      : []),
    ...(noReason.length
      ? [`추천 근거에 "자료 있음, 못 봄"을 쓰고 못 연 이유를 적지 않았다: ${listed(noReason.map((f) => `"${f.line.slice(0, 80)}"`))}. 열 수 있으면 지금 열어 보고 본 것을 쓰고, 끝내 못 열면 괄호 안에 "이유: <못 연 이유>"를 적는다.`]
      : []),
  ];
  return { check: 'basis-unopened', reason: `${what.join(' ')} ${BASIS_FORMS}` };
}

export function checkBasisOldForm(answer: string): Finding | null {
  const found = readBases(answer).filter((b) => b.oldForm);
  if (!found.length) return null;
  return {
    check: 'basis-old-form',
    reason: `추천 근거를 옛 형식("확인 안 함"·"안 봄" 계열)으로 썼다: ${listed(found.map((f) => `"${f.line.slice(0, 80)}"`))}. ${BASIS_FORMS} 짐작이면 규칙대로 그 아래 두 번째 의견 줄을 붙인다.`,
  };
}

// ---- what the basis and the relayed report name was opened (seen-sources.ts) ---------------------------------------

export function checkBasisSource(answer: string, seen: Seen | null | undefined): Finding | null {
  if (!seen) return null;
  const found = readBasisSources(answer, seen);
  if (!found.length) return null;
  const unopened = found.filter((f) => f.unopened.length);
  const bare = found.filter((f) => f.reasoningOnly);
  const what = [
    ...(unopened.length
      ? [`추천 근거에 적은 자료를 이 턴(과 앞 두 턴)의 도구 호출로 연 흔적이 없다: ${listed(unopened.map((f) => `"${f.line.slice(0, 70)}"(${f.unopened.map((r) => `${r.kind} ${r.shown}`).slice(0, 3).join(', ')})`))}. 그 자료를 지금 열어 보고, 본 것으로 근거와 추천을 다시 확인한다(열어 보니 달라지면 바로잡는다).`]
      : []),
    ...(bare.length
      ? [`추천 근거에 출처(파일, 기억·대화 #번호, 커밋, 명령)가 없이 추론만 있다: ${listed(bare.map((f) => `"${f.line.slice(0, 70)}"`))}. 확인할 자료가 있으면 열어 보고 그 출처를 적는다.`]
      : []),
  ];
  return { check: 'basis-source', reason: `${what.join(' ')} ${BASIS_FORMS}` };
}

export function checkReportRelay(answer: string, seen: Seen | null | undefined): Finding | null {
  if (!seen) return null;
  const paths = unopenedReportPaths(answer, seen);
  if (!paths.length) return null;
  return {
    check: 'report-relay',
    reason: `보고(서브에이전트·run-job·업무 세션)에 나온 경로를 열어 보지 않고 전했다: ${listed(paths)}. 보고가 가리키는 자리(파일·줄·기록)를 직접 열어 맞는지 보고, 많으면 몇 개만 보고 나머지에는 "확인 안 됨"을 붙여 전한다.`,
  };
}

// ---- words the secretary made up (invented-words.json) ----------------------------------------------------------

/** The lines a reader decides on: a labelled question, an option, a basis. */
const DECIDING_LINE = (l: string) => LABEL_LINE.test(l) || OPTION_LINE.test(l) || BASIS_LINE.test(l);
/** Endings a Korean noun takes (so "틀" is found in "틀을" but not in "틀린"). */
const PARTICLE = '(?:은|는|이|가|을|를|에|에서|에는|에게|으로|로|으로는|로는|과|와|도|만|의|이나|나|처럼|마다|까지|부터|이라|라|이란|란|이고|이다|입니다|이에요|예요|하고)';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The list words found unexplained in deciding lines (outside code and quotes): each word once, with its line. */
export function inventedWordsIn(answer: string, words: readonly string[]): Array<{ word: string; line: string }> {
  const out = new Map<string, string>();
  const res = words
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => ({ w, re: new RegExp(`(?<![가-힣A-Za-z])${escapeRe(w).replace(/\s+/g, '\\s+')}(${PARTICLE})?(?![가-힣])(\\s*\\()?`, 'g') }));
  for (const raw of splitFences(answer).prose) {
    if (!DECIDING_LINE(raw)) continue;
    const l = blank(blank(raw, INLINE_CODE), QUOTED);
    for (const { w, re } of res) {
      if (out.has(w)) continue;
      for (const m of l.matchAll(re)) {
        // "칸(컬럼)": explained right after it.
        if (m[2]) continue;
        out.set(w, raw.trim());
        break;
      }
    }
  }
  return [...out].map(([word, line]) => ({ word, line }));
}

export function checkInventedWords(answer: string, words: readonly string[] | undefined): Finding | null {
  if (!words?.length) return null;
  const found = inventedWordsIn(answer, words);
  if (!found.length) return null;
  return {
    check: 'invented-word',
    reason: `질문·선택지·근거 줄에 비서가 지어내 사용자가 되물은 적 있는 낱말이 풀이 없이 나왔다: ${listed(found.map((f) => `"${f.word}"(${f.line.slice(0, 60)})`))}. 사람이 말로 쓰는 말이나 현업 용어로 바꿔 쓰거나, 꼭 써야 하면 바로 뒤 괄호에 뜻을 붙인다(예: 컬럼(column)).`,
  };
}

// ---- a question that leans on another question's answer ------------------------------------------------------

/** The labelled questions of an answer, each with its lines (question, options, details, basis) up to the next label. */
export function questionBlocks(answer: string): Array<{ label: string; lines: string[] }> {
  const out: Array<{ label: string; lines: string[] }> = [];
  let cur: { label: string; lines: string[] } | null = null;
  for (const l of splitFences(answer).prose) {
    const q = LABEL_LINE.exec(l);
    if (q) {
      cur = { label: q[1], lines: [l] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.trim() && !OPTION_LINE.test(l) && !BASIS_LINE.test(l) && !/^\s+\S/.test(l)) {
      cur = null;
      continue;
    }
    cur.lines.push(l);
  }
  return out;
}

/** "SF1이면", "A를 고르면", "B2로 정하면", "C에 따라", "D의 답": a condition on another question's answer. */
const leansOn = (label: string) =>
  new RegExp(`(?<![A-Za-z])${label}(?:\\s?\\d{1,2})?(?:번)?\\s*(?:(?:을|를|으로|로)\\s*(?:고르|정하|하)[가-힣]*면|이면|면|이라면|라면|일\\s*때|일\\s*경우|에\\s*따라|의\\s*답|답에\\s*따라)`);

export function dependentQuestions(answer: string): Array<{ label: string; on: string; line: string }> {
  const blocks = questionBlocks(answer);
  const labels = new Set(blocks.map((b) => b.label));
  const out: Array<{ label: string; on: string; line: string }> = [];
  for (const b of blocks) {
    for (const other of labels) {
      if (other === b.label) continue;
      const re = leansOn(other);
      const line = b.lines.find((l) => re.test(blank(l, INLINE_CODE)));
      if (line) {
        out.push({ label: b.label, on: other, line: line.trim() });
        break;
      }
    }
  }
  return out;
}

export function checkDependentQuestions(answer: string): Finding | null {
  const found = dependentQuestions(answer);
  if (!found.length) return null;
  return {
    check: 'dependent-question',
    reason: `한 답에서 다른 질문의 답에 기대는 질문을 같이 물었다: ${listed(found.map((f) => `${f.label}가 ${f.on}의 답에 기댐("${f.line.slice(0, 60)}")`))}. 그 질문은 앞 질문의 답을 받은 다음 턴에 묻는다. 이번에는 앞 질문만 남기고, 딸린 질문은 "다음 행동 및 순서"에 "${found[0].on}의 답을 받은 뒤 물을 것"으로 적어 둔다.`,
  };
}

/** What the checks beyond the answer's own text read: the turn's tool calls, the made-up words list. */
export interface CheckContext {
  seen?: Seen | null;
  inventedWords?: readonly string[];
}

/** Every check on one answer. */
export function checkAnswer(answer: string, s: PathRoots, ctx: CheckContext = {}): Finding[] {
  if (!answer.trim()) return [];
  return [
    checkEnglish(answer),
    ...checkPaths(answer, s),
    checkRecommendBasis(answer),
    checkBasisUnopened(answer),
    checkBasisOldForm(answer),
    checkBasisSource(answer, ctx.seen),
    checkReportRelay(answer, ctx.seen),
    checkInventedWords(answer, ctx.inventedWords),
    checkDependentQuestions(answer),
  ].filter((f): f is Finding => f !== null);
}
