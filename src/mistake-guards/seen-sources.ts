/**
 * What the secretary actually opened in the last turns, read from the transcript (JSONL), and the two answer checks that
 * hold an answer to it (2026-11-13 user's call; the askback review found 52 of 78 questions the user asked
 * back ended in a changed answer, and the cited source was often never opened: P1, P5).
 *
 * - basis-source (P1): each "> 근거:" line's sources (a file, a #number of a memory or a log row, a commit, a command in
 *   backticks) must have passed through a tool call (its input or its result) or the memory injection in this turn or the
 *   two before it. A basis with no source at all, and neither of the two forms for "not seen" (core/basis-forms.ts), is
 *   only reasoning: caught too.
 * - report-relay (P5): an answer passing on a report (a subagent's, a run-job's, a work session's) names paths from it;
 *   each must have been opened by the secretary's own tools, not only read in the report.
 *
 * Both only warn: what counts as "opened" is read off the words of a tool call and may be wrong both ways.
 */
import { BASIS_GUESS } from '../core/basis-forms.ts';
import { splitFences } from './answer-checks.ts';
import { blocks, startsTurn, tailLines, toolName, type Line } from './last-turn.ts';

/** One tool call or result (or a hook's text) seen in the window, lower-cased with / for \. */
export interface SeenText {
  tool: string;
  text: string;
}

export interface Seen {
  /** The secretary's tool inputs (every tool but a report's own call: its input is the secretary's writing, not opening). */
  inputs: SeenText[];
  /** Results of those tools, and the hook context (memory injection) of the same turns. */
  results: SeenText[];
  /** The text of reports the last turn received (a subagent's result, a run-job's output, a background notification). */
  reports: SeenText[];
}

/** How many turns before the last one count as "this turn" for a basis (the user's call: the turn, or the two before it). */
export const SEEN_TURNS_BEFORE = 2;

/** Tool calls whose result is a report someone else wrote. */
const REPORT_TOOL = /^(Agent|Task|TaskOutput|mcp__secretary__get_task)$/;
/** A shell command that runs or waits for a run-job or a work session: its output is a report. */
const REPORT_COMMAND = /run-job|wait-job|start-worker|external-device-job|worker-status/i;

const norm = (s: string) => s.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
}

/**
 * The window's seen texts. `parsed` are the transcript lines in order; the window is the last turn and the
 * SEEN_TURNS_BEFORE turns before it (each starts at a line startsTurn takes).
 */
export function seenInTurns(parsed: Line[], before = SEEN_TURNS_BEFORE): Seen {
  const starts: number[] = [];
  for (let i = parsed.length - 1; i >= 0 && starts.length <= before; i--) if (startsTurn(parsed[i])) starts.push(i);
  const from = starts.length ? starts[starts.length - 1] : 0;
  const lastStart = starts[0] ?? 0;
  const seen: Seen = { inputs: [], results: [], reports: [] };
  const toolById = new Map<string, { name: string; report: boolean }>();
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
      seen.reports.push({ tool: 'notification', text: norm(String(o.attachment.prompt)) });
      continue;
    }
    if (o.type === 'user') {
      const bs = blocks(o.message?.content);
      if (i === lastStart && inLast) {
        const t = bs.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
        // A background job or a subagent finishing starts a turn with its notification: that text is a report.
        if (/<task-notification>/.test(t)) seen.reports.push({ tool: 'notification', text: norm(t) });
      }
      for (const b of bs as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (b?.type !== 'tool_result') continue;
        const t = toolById.get(b.tool_use_id ?? '');
        const text = norm(resultText(b.content));
        if (t?.report) {
          if (inLast) seen.reports.push({ tool: t.name, text });
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
      if (b.id) toolById.set(b.id, { name, report });
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
  kind: '파일' | '번호' | '커밋' | '명령';
  /** As written (for the notice). */
  shown: string;
  /** What to look for in the seen texts (lower case). */
  needle: string;
}

/** Files that are always in context: the rules (CLAUDE.md loads AGENTS.md every turn). */
const ALWAYS_SEEN = new Set(['agents.md', 'claude.md']);
const FILE = /[\w가-힣.-]*[\w가-힣]\.(?:tsx?|mts|mjs|cjs|jsx?|jsonl?|md|ps1|psm1|py|sh|txt|ya?ml|toml|csv|html?|css|log|db|ini|env)\b/gi;
const FILE_IN = new RegExp(FILE.source, 'i');
/** "#1234", "기억 1234", "대화 #1234" (a question label like "#A" is no number). */
const NUMBER = /#(\d{2,})|(?:기억|대화|로그|log)\s*#?\s*(\d{2,})/gi;
const COMMIT = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;
const INLINE = /`([^`\n]{3,})`/g;
/** The user's own words this turn or a decision quoted: a source the transcript holds without a tool call. */
const USER_WORDS = /사용자(?:가|의)?\s*(?:말|답|요청|지시|결정|원문|고름|골랐|정함|정했)|원문|이번 질문/;
/** "자료 있음, 못 봄(…)": declared not seen with its reason (basis-unopened judges that form). */
const UNABLE_FORM = /자료\s*있음\s*[,，·]?\s*못\s*봄\s*(?:\((?:[^()\n]|\([^()\n]*\))*\))?/g;
const UNABLE_ONE = new RegExp(UNABLE_FORM.source);
const GUESS_FORM = new RegExp(BASIS_GUESS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\(짐작\\)', '\\s*\\(짐작\\)'));
/** "확인 안 함", "안 봄" and the like: the old forms basis-old-form and basis-unopened speak to. */
const SAID_NOT_SEEN = /확인\s*안\s*(?:함|했|됨)|안\s*(?:봄|봤)|못\s*(?:봄|봤)|미확인|짐작/;
/** The judge's line for a guess ("> <judge> 판단 · N번 · 확률 N%", AGENTS.md 추천 근거). */
const JUDGED = /판단\s*·\s*\d+\s*번/;
const BASIS_LINE = /^\s*(?:>\s*)?(?:[-*]\s*)?\**\s*근거\s*\**\s*[:：]/;

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
    add({ kind: '명령', shown: code, needle: norm(code).replace(/\s+/g, ' ') });
  }
  return [...out.values()];
}

/** Whether a needle shows in one of the texts: a number stands alone, anything else as a substring. */
function found(r: SourceRef, texts: SeenText[]): boolean {
  if (r.kind === '번호') {
    const re = new RegExp(`(?<!\\d)${r.needle}(?!\\d)`);
    return texts.some((t) => re.test(t.text));
  }
  if (r.kind === '명령') return texts.some((t) => t.text.replace(/\s+/g, ' ').includes(r.needle));
  return texts.some((t) => t.text.includes(r.needle));
}

export interface BasisSourceRead {
  line: string;
  /** Sources it names that no tool call of the window shows. */
  unopened: SourceRef[];
  /** Names no source and is neither of the two forms for "not seen": reasoning only. */
  reasoningOnly: boolean;
}

/** The "> 근거:" lines (outside code blocks) that cite something not opened, or nothing at all. */
export function readBasisSources(answer: string, seen: Seen): BasisSourceRead[] {
  const pool = [...seen.inputs, ...seen.results];
  const out: BasisSourceRead[] = [];
  for (const l of splitFences(answer).prose) {
    if (!BASIS_LINE.test(l)) continue;
    const refs = sourceRefs(l);
    const unopened = refs.filter((r) => !found(r, pool));
    const declared = GUESS_FORM.test(l) || UNABLE_ONE.test(l) || SAID_NOT_SEEN.test(l) || JUDGED.test(l);
    const reasoningOnly = !refs.length && !declared && !USER_WORDS.test(l);
    if (unopened.length || reasoningOnly) out.push({ line: l.trim(), unopened, reasoningOnly });
  }
  return out;
}

// ---- report relay --------------------------------------------------------------------------------------------------

/** Paths an answer names (prose and code lines): a file name, or an absolute path's last part. */
export function answerPaths(answer: string): Array<{ shown: string; needle: string }> {
  const out = new Map<string, { shown: string; needle: string }>();
  const { code, prose } = splitFences(answer);
  for (const l of [...prose, ...code]) {
    for (const m of l.matchAll(/[A-Za-z]:[\\/][^\s`'"()<>]+/g)) {
      const parts = m[0].replace(/[\\/]+$/, '').split(/[\\/]/);
      const base = parts.pop()!.toLowerCase();
      if (base && !ALWAYS_SEEN.has(base)) out.set(base, { shown: m[0], needle: base });
    }
    for (const m of l.matchAll(FILE)) {
      const base = m[0].split(/[\\/]/).pop()!.toLowerCase();
      if (!ALWAYS_SEEN.has(base) && !out.has(base)) out.set(base, { shown: m[0], needle: base });
    }
  }
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
    const parsed: Line[] = [];
    for (const l of tailLines(transcriptPath)) {
      try {
        parsed.push(JSON.parse(l) as Line);
      } catch {}
    }
    return seenInTurns(parsed);
  } catch {
    return null;
  }
}
