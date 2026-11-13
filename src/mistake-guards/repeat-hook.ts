/**
 * The repeat reminder (feature 'mistake-guards'): a PostToolUse hook that counts, within one turn, the tool calls of one kind
 * (the same tool on the same kind of target: a shell command's head, files read in one folder, pages of one site, one
 * browser tool) and, the first time a kind reaches the limit (scripts/mistake-guards.local.json repeatLimit, default 10), adds a
 * note to the model's context: check whether a tool or script could do the rest at once, and count what is left and how
 * long it takes. It never refuses a call, and says it once per kind per turn.
 *
 * Not counted, as steps any work repeats rather than a task's one step done item by item (decided 2026-11-07 from the
 * turns of 517 transcripts where the old count would have spoken): looking at files from the shell (cat, sed, grep, ls…,
 * the shell's Read, Edit, Grep and Glob), code run inline (python -c, python - with a heredoc, node -e: each one a different
 * edit or look), the progress list and agent polling (TaskUpdate, ListAgents), a search engine's result page fetched (a
 * search, as WebSearch is), a file read or written again (a file counts once in its folder, in parts or not), and the
 * same command run again (a build or test rerun after each fix: the same command line counts once). Nor are images read
 * with Read (looking at a picture is the model's own step; files that are not images are still counted).
 *
 * Put in for the secretary (.claude/settings.json), work sessions (scripts/worker/worker-lib.ps1) and run-jobs
 * (scripts/run-job/run-job.ps1). Started on its own (`node src/mistake-guards/repeat-hook.ts`, the hook's JSON on stdin), it
 * reads the transcript (only what was added since its last run, kept in a small state file per session under the temp
 * folder) and never opens the secretary's database. Anything it cannot read lets the call pass without a word.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repeatLimit } from './mistake-guard-settings.ts';
import { blocks, startsTurn, type Line } from './last-turn.ts';
import { noteToolHookHit } from './tool-hook-hits.ts';

/** Where the per-session counts live; tests point it elsewhere. */
export const STATE_DIR_ENV = 'SECRETARY_TEST_REPEAT_HOOK_STATE_DIR';
export const stateDir = () => process.env[STATE_DIR_ENV] || path.join(os.tmpdir(), 'secretary-repeat');

/** A session seen for the first time is read from this far back (the turn it is in, mostly). */
const FIRST_READ_BYTES = 4 * 1024 * 1024;
/** State files of sessions quiet this long are removed when a new one is made. */
const STATE_KEEP_MS = 3 * 86_400_000;

/** Calls that are not a task's repeated step: thinking tools, edits while coding, searches, the secretary's memory. */
const SKIP = /^(Agent|Task|Skill|ToolSearch|TodoWrite|TaskStop|TaskOutput|TaskCreate|TaskUpdate|TaskList|TaskGet|ListAgents|Monitor|SendMessage|SubagentHandback|ExitPlanMode|EnterPlanMode|AskUserQuestion|Edit|MultiEdit|NotebookEdit|Glob|Grep|LS|WebSearch|mcp__secretary__.*)$/;
/**
 * Images read to be looked at (decided 2026-11-07): seeing is the model's own step and no script can do it, and of the 11
 * image-reading notes in 517 transcripts, 8 were already contact sheets and the other 3 checks of drafts or screenshots.
 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|ico)$/i;
const SCRIPT_EXT =/\.(ps1|psm1|mjs|cjs|js|ts|py|sh|bat|cmd)$/i;
/** A first word that only sets up the real command (it is skipped). */
const SETUP = /^(?:(?:cd|set-location|pushd|popd|export|set)(?:\s|$)|\$[\w:]+\s*=)/i;
/** Looking at or writing files from the shell (the shell's Read, Edit, Grep, Glob): a segment that is skipped too. */
const VIEW = new Set(
  'cat type head tail less more sed awk grep egrep fgrep rg ls dir find tree wc cut sort uniq tr echo printf diff du stat file pwd date true test mkdir get-content gc select-string sls get-childitem gci get-item gi test-path write-output write-host measure-object select-object where-object sort-object format-table format-list out-string get-date get-location set-content add-content out-file new-item'.split(' '),
);
/** Interpreters whose code can be given inline (-c, -e, - for stdin) instead of a script file. */
const INTERPRETER = /^(python3?|py|node|deno|bun)$/;
const INLINE_FLAG = /^(-c|-e|--eval|-p|--print|-|--input-type=\S+)$/;

const HEREDOC_MARK = /^@@heredoc(\d+)@@$/;

/**
 * A command with its heredoc bodies (the lines after `<<'EOF'` up to `EOF`) taken out, so their lines are not read as
 * commands: each body is left as a mark (@@heredoc0@@) right after its `<<'EOF'`, and returned in bodies.
 */
export function splitHeredocs(command: string): { text: string; bodies: string[] } {
  const out: string[] = [];
  const bodies: string[] = [];
  let end = '';
  let body: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    if (end) {
      if (line.trim() === end) {
        end = '';
        bodies.push(body.join('\n'));
        body = [];
      } else body.push(line);
      continue;
    }
    const m = line.match(/<<-?\s*(['"]?)([\w.-]+)\1/);
    if (!m) {
      out.push(line);
      continue;
    }
    end = m[2];
    const at = (m.index ?? 0) + m[0].length;
    out.push(`${line.slice(0, at)} @@heredoc${bodies.length}@@ ${line.slice(at)}`);
  }
  if (end) bodies.push(body.join('\n'));
  return { text: out.join('\n'), bodies };
}

const base = (s: string) => s.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? s;

/** The head of a shell command: its program, with a subcommand word or the script it runs ("git log", "node export.mjs"). */
export function commandHead(command: string): string {
  return commandStep(command).head;
}

/**
 * The segment of a shell command that is its step (the first one not setting up, looking at files or inline code): its
 * head, and the segment itself with the heredoc it is fed (what tells one run of it from another).
 */
export function commandStep(command: string): { head: string; segment: string } {
  const { text, bodies } = splitHeredocs(command);
  const segments = text.split(/\r?\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (SETUP.test(seg)) continue;
    const head = segmentHead(seg);
    if (head === null) continue;
    const segment = seg.replace(/@@heredoc(\d+)@@/g, (_, i: string) => bodies[Number(i)] ?? '').replace(/\s+/g, ' ').trim();
    return { head, segment };
  }
  return { head: '', segment: '' };
}

/** One segment's head, or null for a segment that is skipped (looking at files, inline code). */
function segmentHead(seg: string): string | null {
  const tokens = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((t) => t !== '&' && !/^\w+=/.test(t) && !HEREDOC_MARK.test(t));
  if (!tokens.length) return null;
  const program = base(tokens[0]).toLowerCase().replace(/\.exe$/, '');
  if (!program || VIEW.has(program)) return null;
  const args = tokens.slice(1);
  const script = args.find((t) => SCRIPT_EXT.test(t.replace(/["']/g, '')));
  if (script) return `${program} ${base(script).toLowerCase()}`;
  if (INTERPRETER.test(program)) {
    if (args.some((t) => INLINE_FLAG.test(t))) return null;
    // python -m unittest, python -m yt_dlp: the module is the subcommand.
    const m = args.indexOf('-m');
    if (m >= 0 && args[m + 1]) return `${program} -m ${args[m + 1].toLowerCase()}`;
  }
  const word = args[0];
  return word && /^[a-z][\w:-]*$/i.test(word) ? `${program} ${word.toLowerCase()}` : program;
}

/** A search engine's result page (fetched as a search, which WebSearch does and is not counted). */
const SEARCH_HOST = /(^|\.)(bing|google|duckduckgo|naver|daum|yahoo|brave|startpage|ecosia)\.[a-z.]+$/i;
export const isSearchPage = (u: URL) => SEARCH_HOST.test(u.hostname) && /[?&](q|query|p|wd)=/.test(u.search);

const dirOf = (file: unknown) => (typeof file === 'string' && file ? path.dirname(file.replace(/\\/g, '/')).toLowerCase() : '');

/** What kind of call this is, for counting; '' for a call that is never counted. */
export function callKind(name: string, input: Record<string, unknown> = {}): string {
  if (!name || SKIP.test(name)) return '';
  if (name === 'Bash' || name === 'PowerShell') {
    const head = commandHead(String(input.command ?? ''));
    return head ? `${name}: ${head}` : '';
  }
  if (name === 'Read' && typeof input.file_path === 'string' && IMAGE_EXT.test(input.file_path)) return '';
  if (name === 'Read' || name === 'Write') {
    const dir = dirOf(input.file_path);
    return dir ? `${name}: ${dir}/` : '';
  }
  if (name === 'WebFetch') {
    try {
      const u = new URL(String(input.url));
      return isSearchPage(u) ? '' : `WebFetch: ${u.host}`;
    } catch {
      return 'WebFetch';
    }
  }
  return name;
}

/**
 * What one call works on, when calls on the same thing count once: a file read or written (in parts or again), a shell
 * step's command line (the same build or test run again after a fix).
 */
export function callUnit(name: string, input: Record<string, unknown> = {}): string {
  if ((name === 'Read' || name === 'Write') && typeof input.file_path === 'string') return input.file_path.replace(/\\/g, '/').toLowerCase();
  if (name === 'Bash' || name === 'PowerShell') {
    // Kept short: the state file holds one per call.
    const seg = commandStep(String(input.command ?? '')).segment;
    return seg ? createHash('sha1').update(seg).digest('hex').slice(0, 16) : '';
  }
  return '';
}

export interface RepeatState {
  /** Bytes of the transcript already read. */
  offset: number;
  /** uuid of the line that started the turn being counted ('' when its start was not read). */
  turn: string;
  /** tool_use id → kind, for this turn (an id is counted once even if two hooks read the same line). */
  calls: Record<string, string>;
  /** tool_use id → what it works on, for calls that count once per thing (callUnit); absent for the rest. */
  units?: Record<string, string>;
  /** Kinds already told about in this turn. */
  told: string[];
}

const fresh = (): RepeatState => ({ offset: 0, turn: '', calls: {}, units: {}, told: [] });

/** Feeds transcript lines (JSON strings) into the counts. */
export function feed(state: RepeatState, lines: string[]): void {
  for (const l of lines) {
    let o: Line & { message?: { content?: unknown } };
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (startsTurn(o)) {
      state.turn = o.uuid ?? '';
      state.calls = {};
      state.units = {};
      state.told = [];
      continue;
    }
    if (o.type !== 'assistant' || o.isSidechain) continue;
    for (const b of blocks(o.message?.content)) {
      if (b?.type !== 'tool_use' || !b.id) continue;
      const kind = callKind(b.name ?? '', b.input ?? {});
      if (!kind) continue;
      state.calls[b.id] = kind;
      const unit = callUnit(b.name ?? '', b.input ?? {});
      if (unit) (state.units ??= {})[b.id] = unit;
    }
  }
}

/** Kinds that reached the limit and were not told yet (marked told). */
export function due(state: RepeatState, limit: number): Array<{ kind: string; count: number }> {
  if (limit < 1) return [];
  // A kind's count: the things its calls worked on, each call its own thing unless it has a unit (callUnit).
  const things = new Map<string, Set<string>>();
  for (const [id, k] of Object.entries(state.calls)) {
    let set = things.get(k);
    if (!set) things.set(k, (set = new Set()));
    set.add(state.units?.[id] ?? `#${id}`);
  }
  const out: Array<{ kind: string; count: number }> = [];
  for (const [kind, set] of things) {
    const count = set.size;
    if (count < limit || state.told.includes(kind)) continue;
    state.told.push(kind);
    out.push({ kind, count });
  }
  return out;
}

export function reminder(hits: Array<{ kind: string; count: number }>): string {
  return hits
    .map(
      (h) =>
        `[반복 작업 알림] 같은 조작(${h.kind})을 이 턴에서 ${h.count}번 되풀이 중. 도구·스크립트로 한꺼번에 처리할 수 있는지 따져 보고, 남은 건수와 예상 시간(한 건 시간 × 남은 건수)을 계산하라. 훨씬 나은 길이 있으면 방법을 바꾸거나 묻고, 없으면 그대로 계속한다(막지 않는 알림이다).`,
    )
    .join('\n');
}

/** Reads what the transcript gained since state.offset (a whole number of lines) and feeds it. */
export function catchUp(state: RepeatState, transcript: string): void {
  const size = fs.statSync(transcript).size;
  if (state.offset > size) Object.assign(state, fresh());
  let start = state.offset;
  let skipPartial = false;
  if (start === 0 && size > FIRST_READ_BYTES) {
    start = size - FIRST_READ_BYTES;
    skipPartial = true;
  }
  if (start >= size) return;
  const fd = fs.openSync(transcript, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // Only whole lines: a line still being written is read next time.
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return;
  const lines = buf.subarray(0, end).toString('utf8').split('\n');
  if (skipPartial) lines.shift();
  feed(state, lines.filter(Boolean));
  state.offset = start + end + 1;
}

function stateFile(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}

function readState(file: string): RepeatState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as RepeatState;
    return typeof s.offset === 'number' && s.calls && Array.isArray(s.told) ? s : null;
  } catch {
    return null;
  }
}

function dropOld(dir: string, now = Date.now()): void {
  try {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      if (now - fs.statSync(f).mtimeMs > STATE_KEEP_MS) fs.rmSync(f, { force: true });
    }
  } catch {}
}

export interface HookInput {
  session_id?: string;
  tool_name?: string;
  transcript_path?: string;
}

/** One hook run: the note to add ('' for none). */
export function runRepeatHook(input: HookInput, opts: { limit: number; dir?: string }): string {
  if (opts.limit < 1 || !input.session_id || !input.transcript_path) return '';
  const dir = opts.dir ?? stateDir();
  const file = stateFile(dir, input.session_id);
  let state = readState(file);
  if (!state) {
    fs.mkdirSync(dir, { recursive: true });
    dropOld(dir);
    state = fresh();
  }
  catchUp(state, input.transcript_path);
  const hits = due(state, opts.limit);
  fs.writeFileSync(file, JSON.stringify(state));
  return hits.length ? reminder(hits) : '';
}

export function hookOutput(note: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } });
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as HookInput;
  const note = runRepeatHook(input, { limit: repeatLimit() });
  if (!note) return;
  process.stdout.write(hookOutput(note));
  // Noted for the secretary's turn record only (tool-hook-hits.ts: a work session or run-job notes nothing).
  noteToolHookHit(input.session_id, { hook: 'PostToolUse', check: 'repeat', level: 'warn', tool: input.tool_name ?? '' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {});
}
