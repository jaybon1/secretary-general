/**
 * What the secretary actually opened in this conversation, read from the transcript (JSONL), and the two answer checks
 * that hold an answer to it (2026-11-13 user's call; the askback review found 52 of 78 questions the user asked
 * back ended in a changed answer, and the cited source was often never opened: P1, P5).
 *
 * - basis-source (P1): each "> 근거:" line's sources (a file or a path, a #number of a memory or a log row, a commit, a
 *   command or a code name in backticks, a hook's notice) must have passed through a tool call (its input or its result)
 *   or a hook's injection since the conversation's last compaction (the whole talk after a /clear: AGENTS.md lets a basis
 *   be what was checked "in this turn or this conversation"); a memory injected anywhere in the session since its last
 *   /clear or compaction counts too (stop-guard.ts). A basis with no source at all, none of the two forms for "not seen"
 *   (core/basis-forms.ts), no check said in words ("열어 보니", "세어 보니", "확인했다"), no line number ("○○ 20~31줄")
 *   and none of the user's own words is only reasoning: caught too.
 * - report-relay (P5): an answer passing on a report (a subagent's, a run-job's, a work session's) names paths from it;
 *   each file must have been opened by the secretary's own tools, not only read in the report (a folder, a web address,
 *   and a path the answer itself marks "확인 안 됨" are not asked for).
 *
 * Both only warn: what counts as "opened" is read off the words of a tool call and may be wrong both ways.
 */
import { BASIS_GUESS } from '../core/basis-forms.ts';
import { splitFences } from './fences.ts';
import { linesSinceCompaction, startsTurn, toolName, type Line } from './last-turn.ts';
import { blocks, parseLines } from '../core/transcript.ts';
import { USER_WORD, wordsGroup } from '../store/user-title.ts';

/**
 * One tool call or result (or a hook's text) seen in the window, lower-cased with / for \. A report's `tool` is the
 * report tool's name, 'notification' for a task notification that hands over a report (a subagent's end, the end of a
 * background command that runs or waits for a run-job or a work session), or 'background-command' for the end of any
 * other background command (npm test, a script the secretary runs itself): see notificationReport.
 */
export interface SeenText {
  tool: string;
  text: string;
  /** A report from a shell call (its output, or its end when it ran in the background): the command it ran. */
  command?: string;
}

export interface Seen {
  /** The secretary's tool inputs (every tool but a report's own call: its input is the secretary's writing, not opening). */
  inputs: SeenText[];
  /** Results of those tools, and the hook context (memory injection) of the same turns. */
  results: SeenText[];
  /** The text of reports the last turn received (a subagent's result, a run-job's output, a background notification). */
  reports: SeenText[];
}

/** Tool calls whose result is a report someone else wrote. */
const REPORT_TOOL = /^(Agent|Task|TaskOutput|mcp__secretary__get_task)$/;
/**
 * A shell command that runs or waits for a run-job or a work session, or shows what a work session wrote (worker-logs:
 * its last answer, the main way a [질문] is read; watch-worker: its notices): its output is a report.
 */
const REPORT_COMMAND = /run-job|wait-job|start-worker|worker-logs|watch-worker|worker-status/i;

const norm = (s: string) => s.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();

/** A background command's end: Claude Code's summary `Background command "<description>" completed (exit code 0)`. */
const BACKGROUND_COMMAND = /<summary>\s*Background command "([^"]*)"/;
const TOOL_USE_ID = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/;

/**
 * Which report a task notification is. A background command's end is a report only when the command runs or waits for a
 * run-job or a work session (REPORT_COMMAND, the same test as a foreground call's output); its call is found by the
 * notification's tool-use id among the window's calls. The description is not enough: by the rules it starts with the
 * task's number and name ("업무N(이름) 모니터링"), so a word like 업무 is in a plain command's too. A call from before
 * a compaction is not in the window; then the description alone is read with REPORT_COMMAND.
 */
function notificationReport(raw: string, toolById: Map<string, { report: boolean; command?: string }>): SeenText {
  const text = norm(raw);
  const bg = BACKGROUND_COMMAND.exec(raw);
  if (!bg) return { tool: 'notification', text };
  const call = toolById.get(TOOL_USE_ID.exec(raw)?.[1] ?? '');
  const report = call ? call.report : REPORT_COMMAND.test(bg[1]);
  return { tool: report ? 'notification' : 'background-command', text, ...(call?.command ? { command: call.command } : {}) };
}

/**
 * Whether a shell command runs or waits for a run-job or a work session itself (the script's name as a word, not part of a
 * folder name such as `_run-job-home`), rather than reading a file (grep, sed, Get-Content …) whose path holds such a name.
 * REPORT_COMMAND above stays the loose test for the reports list other checks read (report-relay: a path seen in a report
 * file is still one to open); the report-judgment check asks this one.
 */
export function runsReportCommand(command: string): boolean {
  if (/^\s*(?:grep|rg|sed|awk|cat|head|tail|less|wc|ls|find|git|type|dir|Get-Content|gc|Select-String|sls|Get-ChildItem|gci)\b/i.test(command)) return false;
  return new RegExp(`(?:^|[\\s"'\`&;|(/\\\\])(?:${REPORT_COMMAND.source})(?:-[\\w-]+)?(?:\\.(?:ps1|mjs|ts))?(?=$|[\\s"'\`;|)])`, 'i').test(command);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
}

/** A compaction's line: the conversation before it is a summary from here on (core/transcript.ts). */
const isCompaction = (o: Line & { subtype?: string }) => o.type === 'system' && o.subtype === 'compact_boundary';

/**
 * The window's seen texts. `parsed` are the transcript lines in order; the window is everything after the last
 * compaction line (the whole of them without one: a /clear starts a new transcript), so a basis may be what was checked
 * anywhere in this conversation (AGENTS.md 추천 근거; until 2026-11-18 it was the last turn and the two before it, which
 * caught a source opened four turns earlier as never opened). The reports are the last turn's only.
 */
export function seenSinceCompaction(parsed: Line[]): Seen {
  let from = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (isCompaction(parsed[i])) {
      from = i + 1;
      break;
    }
  }
  let lastStart = from;
  for (let i = parsed.length - 1; i >= from; i--) {
    if (startsTurn(parsed[i])) {
      lastStart = i;
      break;
    }
  }
  const seen: Seen = { inputs: [], results: [], reports: [] };
  const toolById = new Map<string, { name: string; report: boolean; command?: string }>();
  for (let i = from; i < parsed.length; i++) {
    const o = parsed[i] as Line & { attachment?: { type?: string; content?: unknown; prompt?: unknown } };
    const inLast = i >= lastStart;
    if (o.isSidechain) continue;
    if (o.type === 'attachment' && o.attachment?.type === 'hook_additional_context') {
      const c = o.attachment.content;
      seen.results.push({ tool: 'injected', text: norm(Array.isArray(c) ? c.join('\n') : String(c ?? '')) });
      continue;
    }
    if (o.type === 'attachment' && o.attachment?.type === 'queued_command' && inLast && /<task-notification>/.test(String(o.attachment.prompt ?? ''))) {
      const raw = String(o.attachment.prompt);
      seen.reports.push(notificationReport(raw, toolById));
      continue;
    }
    if (o.type === 'user') {
      const bs = blocks(o.message?.content);
      if (i === lastStart && inLast) {
        const t = bs.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
        // A background job or a subagent finishing starts a turn with its notification: that text is a report.
        if (/<task-notification>/.test(t)) seen.reports.push(notificationReport(t, toolById));
      }
      for (const b of bs as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (b?.type !== 'tool_result') continue;
        const t = toolById.get(b.tool_use_id ?? '');
        const text = norm(resultText(b.content));
        if (t?.report) {
          if (inLast) seen.reports.push({ tool: t.name, text, ...(t.command ? { command: t.command } : {}) });
        } else seen.results.push({ tool: t?.name ?? '?', text });
      }
      continue;
    }
    if (o.type !== 'assistant') continue;
    for (const b of blocks(o.message?.content)) {
      if (b?.type !== 'tool_use') continue;
      const name = toolName(b);
      const input = JSON.stringify(b.input ?? {});
      const command = typeof b.input?.command === 'string' ? b.input.command : '';
      const report = REPORT_TOOL.test(b.name ?? '') || ((b.name === 'Bash' || b.name === 'PowerShell') && REPORT_COMMAND.test(command));
      if (b.id) toolById.set(b.id, { name, report, ...(command ? { command } : {}) });
      if (report && b.name !== 'Bash' && b.name !== 'PowerShell') continue;
      // A loaded skill is its SKILL.md opened.
      const extra = name.startsWith('Skill:') ? ` ${name.slice(6)}/skill.md` : '';
      seen.inputs.push({ tool: name, text: norm(input) + extra });
    }
  }
  return seen;
}

// ---- what a basis cites --------------------------------------------------------------------------------------------

export interface SourceRef {
  /** 코드: a name in backticks that is no command (a function, a variable, `exit 5`); 안내: a hook's notice. */
  kind: '파일' | '번호' | '커밋' | '명령' | '코드' | '안내';
  /** As written (for the notice). */
  shown: string;
  /** What to look for in the seen texts (lower case). */
  needle: string;
  /**
   * Counts as the basis's source when the window shows it, and is never told as unopened when it does not (a hook's
   * notice named by a loose word such as "사용량": the secretary may have read the number elsewhere).
   */
  soft?: boolean;
}

/** Files that are always in context: the rules (CLAUDE.md loads AGENTS.md every turn). */
const ALWAYS_SEEN = new Set(['agents.md', 'claude.md']);
const FILE = /[\w가-힣.-]*[\w가-힣]\.(?:tsx?|mts|mjs|cjs|jsx?|jsonl?|md|ps1|psm1|py|sh|txt|ya?ml|toml|csv|html?|css|log|db|ini|env)\b/gi;
const FILE_IN = new RegExp(FILE.source, 'i');
/** "#1234", "기억 1234", "대화 #1234" (a question label like "#A" is no number). */
const NUMBER = /#(\d{2,})|(?:기억|대화|로그|log)\s*#?\s*(\d{2,})/gi;
const COMMIT = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;
const INLINE = /`([^`\n]{3,})`/g;
/**
 * What in backticks reads as a command one runs: a known program or a PowerShell cmdlet first, or a script path (that one
 * is a file ref already). Anything else is a name in the code (`judge`, `$w.code`, `exit 5`): a '코드' ref, looked for the
 * same way but not called a command.
 */
const COMMAND_HEAD =
  /^(?:node|npm|npx|pnpm|yarn|git|gh|pwsh|powershell|bash|sh|cmd|python3?|py|pip|sqlite3|rg|grep|claude|curl|ssh|scp|ffmpeg|docker|winget|tsc|deno|bun|cat|ls|dir|findstr|schtasks|robocopy|tasklist|taskkill|wsl)(?:\.exe)?(?:\s|$)|^[A-Z][a-z]+-[A-Z][A-Za-z]+(?:\s|$)/;
/** A home folder written short (`~\.secretary`, `$HOME/…`, `%USERPROFILE%\…`): tool calls write it out, so only what follows is looked for. */
const HOME_HEAD = /^(?:~|\$home|\$env:userprofile|%userprofile%)(?=\/)/i;
/** A hook's notice a basis may point to by its tag or by what it is about (the board, the usage line, the to-do summary, the injected memories). */
const NOTICE_WORDS: Array<[RegExp, string]> = [
  [/상황판/, 'secretary-board'],
  [/사용량/, 'secretary-usage'],
  [/할\s*일\s*(?:요약|안내)/, 'secretary-todo'],
  [/자동\s*(?:주입|으로\s*붙은)|관련\s*기억/, 'secretary-memory'],
];
const NOTICE_TAG = /<?\/?(secretary-[a-z-]+)>?/g;
/** A check said in words: "열어 보니", "세어 보니", "돌려 봤다", "확인했다" (the user's call 2026-11-18: a source too). */
const SAID_CHECKED = /(?:세어|열어|돌려|찾아|읽어|대조해|조회해|실행해|검색해|재어|비교해|grep해)\s*(?:보니|봤|봄|본\s*(?:결과|바|것)|보았)|확인\s*(?:했|함|됨|해\s*보니|한\s*결과|한\s*바)/;
/** A line number cited: "○○ 20줄", "20~31줄", "103·149줄", "`:108`" (the user's call 2026-11-18: a source too). */
const LINE_NUMBER = /\d+\s*(?:[~∼\-–·,]\s*\d+\s*)*줄|(?<![\w:/])[:：]\d+(?:\s*[-~]\s*\d+)?(?!\d)/;
/** "자료 있음, 못 봄(…)": declared not seen with its reason (basis-unopened judges that form). */
const UNABLE_FORM = /자료\s*있음\s*[,，·]?\s*못\s*봄\s*(?:\((?:[^()\n]|\([^()\n]*\))*\))?/g;
const UNABLE_ONE = new RegExp(UNABLE_FORM.source);
const GUESS_FORM = new RegExp(BASIS_GUESS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\(짐작\\)', '\\s*\\(짐작\\)'));
/** "확인 안 함", "안 봄" and the like: the old forms basis-old-form and basis-unopened speak to. */
const SAID_NOT_SEEN = /확인\s*안\s*(?:함|했|됨)|안\s*(?:봄|봤)|못\s*(?:봄|봤)|미확인|짐작/;
/** The judge's line for a guess ("> <judge> 판단 · N번 · 확률 N%", AGENTS.md 추천 근거). */
const JUDGED = /판단\s*·\s*\d+\s*번/;
const BASIS_LINE = /^\s*(?:>\s*)?(?:[-*]\s*)?\**\s*근거\s*\**\s*[:：]/;

/**
 * The user's own words this turn or a decision quoted, a source the transcript holds without a tool call: "사용자 말",
 * "사용자가 이 대화에서 직접 쓰셨어요", and the same with the title the user goes by (store/user-title.ts), "원문",
 * "이번 질문".
 */
export function userWordsPattern(words: readonly string[] = [USER_WORD]): RegExp {
  const who = wordsGroup(words.length ? words : [USER_WORD]);
  return new RegExp(`${who}\\s*(?:님)?(?:이|가|의|께서|께)?[^.。\\n]{0,40}?(?:말|답|요청|지시|결정|원문|고름|고르|골랐|정함|정했|정하|쓰셨|적으셨|보내셨|하셨)|원문|이번 질문`);
}

/** The literal part of a path with wildcards (`*.py` → `.py`, `src/**\/*.ts` → `src/`): its longest piece without one. */
const literalPart = (s: string) => s.split(/[*?]+/).sort((a, b) => b.length - a.length)[0] ?? '';

export function sourceRefs(line: string): SourceRef[] {
  const out = new Map<string, SourceRef>();
  const add = (r: SourceRef) => out.has(r.kind + r.needle) || out.set(r.kind + r.needle, r);
  const rest = line.replace(UNABLE_FORM, ' ');
  for (const m of rest.matchAll(FILE)) {
    const base = m[0].split(/[\\/]/).pop()!.toLowerCase();
    if (!ALWAYS_SEEN.has(base)) add({ kind: '파일', shown: m[0], needle: base });
  }
  for (const m of rest.matchAll(NUMBER)) add({ kind: '번호', shown: m[0].trim(), needle: m[1] ?? m[2] });
  for (const m of rest.replace(INLINE, ' ').matchAll(COMMIT)) add({ kind: '커밋', shown: m[0], needle: m[0].toLowerCase() });
  for (const m of rest.matchAll(INLINE)) {
    const code = m[1].trim();
    // A commit in backticks (one of only digits too: `9100882`, which the commit pattern outside them leaves to numbers).
    if (/^[0-9a-f]{7,40}$/i.test(code)) {
      add({ kind: '커밋', shown: code, needle: code.toLowerCase() });
      continue;
    }
    // A file or a number in backticks is caught above; a path's last part is what a tool call names.
    if (FILE_IN.test(code) || /^#?\d+$/.test(code)) continue;
    // A line reference (`:108`) or a value (`{"open":[]}`, `"x"`) is no command one could have run.
    if (/^[:{\["'(<]/.test(code) || !/[A-Za-z]{2,}/.test(code)) continue;
    // A folder or a pattern (`~\.secretary\keys`, `*.py`): what a tool call wrote of it, the home folder and wildcards left out.
    if (!/\s/.test(code) && /[\\/*?]/.test(code)) {
      const needle = literalPart(norm(code).replace(HOME_HEAD, '')).replace(/\/+$/, '');
      if (needle.replace(/[/.]/g, '').length >= 2) add({ kind: '파일', shown: code, needle });
      continue;
    }
    add({ kind: COMMAND_HEAD.test(code) ? '명령' : '코드', shown: code, needle: norm(code).replace(/\s+/g, ' ') });
  }
  // A hook's notice: named by its tag, or by what it is about.
  for (const m of rest.matchAll(NOTICE_TAG)) add({ kind: '안내', shown: m[0], needle: `<${m[1].toLowerCase()}`, soft: true });
  for (const [re, tag] of NOTICE_WORDS) {
    const m = re.exec(rest);
    if (m) add({ kind: '안내', shown: m[0], needle: `<${tag}`, soft: true });
  }
  return [...out.values()];
}

/** Whether a needle shows in one of the texts: a number stands alone, anything else as a substring. */
function found(r: SourceRef, texts: SeenText[]): boolean {
  if (r.kind === '번호') {
    const re = new RegExp(`(?<!\\d)${r.needle}(?!\\d)`);
    return texts.some((t) => re.test(t.text));
  }
  if (r.kind === '명령' || r.kind === '코드') return texts.some((t) => t.text.replace(/\s+/g, ' ').includes(r.needle));
  return texts.some((t) => t.text.includes(r.needle));
}

export interface BasisSourceRead {
  line: string;
  /** Sources it names that no tool call of the window shows. */
  unopened: SourceRef[];
  /** Names no source and is neither of the two forms for "not seen": reasoning only. */
  reasoningOnly: boolean;
}

/**
 * The "> 근거:" lines (outside code blocks) that cite something not opened, or nothing at all. `userWords`: the words the
 * user goes by (사용자, and the title when one is set: store/user-title.ts userWords).
 */
export function readBasisSources(answer: string, seen: Seen, userWords?: readonly string[]): BasisSourceRead[] {
  const pool = [...seen.inputs, ...seen.results];
  const userSaid = userWordsPattern(userWords);
  const out: BasisSourceRead[] = [];
  for (const l of splitFences(answer).prose) {
    if (!BASIS_LINE.test(l)) continue;
    const refs = sourceRefs(l);
    const firm = refs.filter((r) => !r.soft);
    const unopened = firm.filter((r) => !found(r, pool));
    const declared =
      GUESS_FORM.test(l) || UNABLE_ONE.test(l) || SAID_NOT_SEEN.test(l) || JUDGED.test(l) || userSaid.test(l) || SAID_CHECKED.test(l) || LINE_NUMBER.test(l) || refs.some((r) => r.soft && found(r, pool));
    const reasoningOnly = !firm.length && !declared;
    if (unopened.length || reasoningOnly) out.push({ line: l.trim(), unopened, reasoningOnly });
  }
  return out;
}

// ---- report relay --------------------------------------------------------------------------------------------------

/** A web address (any scheme): taken out before paths are looked for, or its `s://host/…` reads as a drive path. */
const WEB_ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi;
/** An absolute drive path (not the `s:` of `https:`). */
const DRIVE_PATH = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s`'"()<>]+/g;
/** A name with an extension: a file (a path ending in a bare name is taken for a folder). */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
/**
 * The answer says it did not open it: AGENTS.md lets a relay check a few of many paths and mark the rest "확인 안 됨"
 * (on the path's line, or on the line before or right after its code block).
 */
const MARKED_UNCHECKED = /확인\s*안\s*(?:됨|함|했)|미확인|안\s*열어\s*봄|못\s*열어\s*봄/;

/**
 * Files an answer names (prose and code lines): a file name, or an absolute path's last part. Web addresses, folders and
 * paths marked as not checked are left out.
 */
export function answerPaths(answer: string): Array<{ shown: string; needle: string }> {
  const out = new Map<string, { shown: string; needle: string }>();
  const take = (raw: string) => {
    const l = raw.replace(WEB_ADDRESS, ' ');
    for (const m of l.matchAll(DRIVE_PATH)) {
      const base = m[0].replace(/[\\/]+$/, '').split(/[\\/]/).pop()!.toLowerCase();
      if (/[\\/]$/.test(m[0]) || !HAS_EXTENSION.test(base)) continue;
      if (!ALWAYS_SEEN.has(base)) out.set(base, { shown: m[0], needle: base });
    }
    for (const m of l.matchAll(FILE)) {
      const base = m[0].split(/[\\/]/).pop()!.toLowerCase();
      if (!ALWAYS_SEEN.has(base) && !out.has(base)) out.set(base, { shown: m[0], needle: base });
    }
  };
  let fence: string | null = null;
  let block: string[] = [];
  let lastProse = '';
  // A code block just closed: its lines wait for the prose line after it (a "확인 안 됨" there marks them too).
  let closed: { lines: string[]; before: string } | null = null;
  let blockBefore = '';
  const flush = (after: string) => {
    if (closed && !MARKED_UNCHECKED.test(closed.before) && !MARKED_UNCHECKED.test(after)) closed.lines.forEach(take);
    closed = null;
  };
  for (const l of answer.split(/\r?\n/)) {
    const m = /^\s*(```|~~~)/.exec(l);
    if (m) {
      if (fence === null) {
        flush('');
        fence = m[1];
        block = [];
        blockBefore = lastProse;
      } else if (fence === m[1]) {
        fence = null;
        closed = { lines: block, before: blockBefore };
        // The next block's line before is not this block's.
        lastProse = '';
      }
      continue;
    }
    if (fence !== null) {
      block.push(l);
      continue;
    }
    if (!l.trim()) continue;
    flush(l);
    lastProse = l;
    if (!MARKED_UNCHECKED.test(l)) take(l);
  }
  // An unclosed block is code to its end.
  if (fence !== null) closed = { lines: block, before: blockBefore };
  flush('');
  return [...out.values()];
}

/**
 * When the last turn received a report: the paths of the answer that came from it (the report names them) and that no
 * tool of the secretary's opened (inputs only: reading a report that names a path is not opening the path).
 */
export function unopenedReportPaths(answer: string, seen: Seen): string[] {
  if (!seen.reports.length) return [];
  return answerPaths(answer)
    .filter((p) => seen.reports.some((r) => r.text.includes(p.needle)))
    .filter((p) => !seen.inputs.some((t) => t.text.includes(p.needle)))
    .map((p) => p.shown);
}

/** The window read from a transcript file; null when it cannot be read. */
export function readSeen(transcriptPath: string): Seen | null {
  try {
    return seenSinceCompaction(parseLines(linesSinceCompaction(transcriptPath)) as Line[]);
  } catch {
    return null;
  }
}
