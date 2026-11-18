/**
 * Where results may go (feature 'mistake-guards'): nothing new directly under the results' parent folder (the secretary's own
 * parent, aiRoot), and nothing written into its temp folder (the user's own scratch space). What is already there
 * (workspaces, notes, inbox, the secretary folders) stays usable. The secretary's PreToolUse hook (pre-tool-hook.ts) and
 * the work sessions' worker-folder-guard (scripts/worker/worker-folder-guard.mjs) both ask here.
 *
 * A shell command is read as text: paths are found by their written form (absolute, under the home folder by variable,
 * or relative with ./ ../ against the folder the command is in at that point: a `cd` earlier in the same command moves
 * it). The text a command hands a program as input (a Bash heredoc's body, a PowerShell here-string) is not read: it is a
 * file's content or a message, not the command; nor is quoted prose (withoutQuotedProse). A path built inside a script, a variable of the command's own, an 8.3
 * short name, or a program that picks its output folder by itself is not seen.
 */
import os from 'node:os';
import path from 'node:path';
import { topEntries } from './mistake-guard-settings.ts';

export interface PlaceContext {
  /** The results' parent folder. */
  aiRoot: string;
  /** Its top-level entries now, lower case (read from the disk when left out). */
  existing?: Set<string>;
  /** The folder a relative path is from. */
  cwd?: string;
}

const SCRATCH = 'temp';

const placeHint = 'workspaces/_run-job-home/output/research/<날짜-일>/(단건 조사·시험), workspaces/quick-outputs(작은 결과물), 맡긴 일은 그 업무 공간 안';
const newTopReason = (root: string, seg: string) =>
  `새 폴더·파일은 ${placeHint}에 둔다(${path.basename(root)} 바로 아래(${seg})가 아니라). 꼭 그 자리여야 하면 먼저 사용자에게 묻는다.`;
const scratchReason = (root: string) =>
  `${path.basename(root)}/${SCRATCH}는 사용자의 임시 작업 폴더라 쓰지 않는다. ${placeHint}에 둔다.`;

/** The first segment of `abs` under aiRoot ('' for aiRoot itself), or null when it is not under it. */
function firstSegment(abs: string, aiRoot: string): { seg: string; depth: number } | null {
  const rel = path.relative(path.resolve(aiRoot), path.resolve(abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  return { seg: parts[0] ?? '', depth: parts.length };
}

/** Why writing this file (Write, Edit) is in the wrong place; null when it is fine. */
export function writePlaceProblem(file: string, ctx: PlaceContext): string | null {
  const at = firstSegment(path.resolve(ctx.cwd ?? process.cwd(), file), ctx.aiRoot);
  if (!at || !at.seg) return null;
  const seg = at.seg.toLowerCase();
  if (seg === SCRATCH) return scratchReason(ctx.aiRoot);
  const existing = ctx.existing ?? topEntries(ctx.aiRoot);
  if (!existing.has(seg)) return newTopReason(ctx.aiRoot, at.seg);
  return null;
}

/** Commands that make, write, copy or move something, or go into a folder to work there. */
const WRITES =
  /(^|[\s;|&({])(mkdir|md|ni|New-Item|Set-Content|Add-Content|Out-File|Tee-Object|tee|Copy-Item|cp|copy|xcopy|robocopy|Move-Item|mv|move|Rename-Item|ren|Expand-Archive|tar|unzip|7z|cd|chdir|Set-Location|sl|Push-Location|pushd|touch)(\s|$)|\bgit\s+(clone|worktree\s+add|init)\b|\b(venv|virtualenv)\b|-OutFile\b|\s-o\s|--output\b|--out(-?dir)?\b|\[IO\.(File|Directory)\]::(Write|Append|Copy|Move|Create)|(^|[^\d&>])>{1,2}(?!&)/i;
/** A command that only looks (its first word), so a missing folder is only looked for. */
const LOOKS_ONLY = /^\s*(Test-Path|Get-ChildItem|gci|ls|dir|Get-Item|gi|Resolve-Path|Get-Content|gc|cat|type|stat|find|where\.exe|where)\b/i;

/** The command with home-folder forms written out ($env:USERPROFILE, %USERPROFILE%, $HOME, ~). */
function expandHome(cmd: string): string {
  const home = os.homedir();
  return cmd
    .replace(/\$env:USERPROFILE|%USERPROFILE%|\$\{?HOME\}?(?![\w])/gi, home)
    .replace(/(^|[\s"'=(])~(?=[\\/])/g, `$1${home}`);
}

/** The paths a command mentions under aiRoot: absolute ones (either slash, Git Bash /c/…) and ./ ../ ones. */
export function mentionedPaths(cmd: string, aiRoot: string, cwd: string): string[] {
  const text = expandHome(cmd);
  const found: string[] = [];
  const root = path.resolve(aiRoot);
  // The root in any slash, any case, and with the drive as Git Bash writes it (/c/…).
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(root);
  const rest = (drive ? drive[2] : root).split(/[\\/]+/).filter(Boolean).map(esc).join('[\\\\/]+');
  const head = drive ? `(?:${drive[1]}:|/${drive[1]})[\\\\/]+` : /^[\\/]/.test(root) ? '[\\\\/]+' : '';
  const re = new RegExp(head + rest, 'gi');
  for (const m of text.matchAll(re)) {
    const at = m.index;
    const after = text.slice(at + m[0].length);
    // A quoted path may hold spaces: it runs to its closing quote.
    const quote = text[at - 1] === '"' || text[at - 1] === "'" ? text[at - 1] : '';
    const t = quote ? new RegExp(`^([\\\\/][^${quote}\\n]*)?`).exec(after) : /^([\\/][^\s"'`;|&<>)]*)?/.exec(after);
    const tail = t?.[1] ?? '';
    const next = after[tail.length];
    // Another folder that only starts the same (ai-agent-2 beside ai-agent) is not this one.
    if (tail || next === undefined || /[\s"'`;|&<>)]/.test(next)) found.push(path.join(root, tail));
  }
  // Relative ones only from a known folder ('' after a `cd` to a folder the text does not show).
  if (cwd) for (const m of text.matchAll(/(?:^|[\s"'=(,])((?:\.{1,2}[\\/])+[^\s"'`;|&<>)]*)/g)) found.push(path.resolve(cwd, m[1]));
  return found;
}

/**
 * The command without the text it hands a program as input: a Bash heredoc's body (`<<EOF` … `EOF`, `<<-'EOF'`) and a
 * PowerShell here-string's (`@'` … `'@`, `@"` … `"@`; what follows the closing mark on its line is command again).
 */
export function withoutInlineText(cmd: string): string {
  const out: string[] = [];
  const ends: string[] = [];
  let hereString = '';
  for (const line of cmd.split(/\r?\n/)) {
    if (hereString) {
      if (line.startsWith(`${hereString}@`)) {
        hereString = '';
        out.push(line.slice(2));
      }
      continue;
    }
    if (ends.length) {
      if (line.trim() === ends[0]) ends.shift();
      continue;
    }
    // Bash: every << on the line (not <<<, a here-string of one word), in order.
    for (const m of line.replace(/<<<\S*/g, ' ').matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g)) ends.push(m[2]);
    // PowerShell: @' or @" ends the line (not Bash's "$@" there); the mark goes too, so its quote opens nothing.
    const opens = ends.length ? null : /(?<!\$)@(['"])\s*$/.exec(line);
    if (opens) hereString = opens[1];
    out.push(opens ? line.slice(0, opens.index) : line);
  }
  return out.join('\n');
}

/** A message flag or a printing command right before a quoted argument: what follows is a message. */
const MESSAGE_BEFORE = /(?:^|\s)(?:-m|--message|-Message|-Body|-Value|echo|Write-Host|Write-Output|printf)\s*=?\s*$/i;
/** Text that starts as a path (a quoted path argument stays read). */
const PATH_START = /^\s*(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~|\$|%)/;

/**
 * The command with quoted prose emptied (`git commit -m "…../notes 링크 고침"`, `echo "mkdir 하지 말 것"`): a quoted
 * string that does not start as a path and holds Korean or follows a message flag (-m, -Message, echo …) is words handed
 * to a program, not the command's own paths or writing. A quoted path (`mkdir "C:\…\새 폴더"`) and a quoted script
 * without Korean (`node -e "…"`) stay as they are.
 */
export function withoutQuotedProse(cmd: string): string {
  let out = '';
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c !== '"' && c !== "'") {
      out += c;
      i++;
      continue;
    }
    let j = i + 1;
    // No backslash escapes: a Windows path ends in one (`"C:\…\"`).
    while (j < cmd.length && cmd[j] !== c) j++;
    if (j >= cmd.length) {
      out += cmd.slice(i);
      break;
    }
    const body = cmd.slice(i + 1, j);
    const prose = !PATH_START.test(body) && (/[가-힣]/.test(body) || MESSAGE_BEFORE.test(cmd.slice(0, i)));
    out += prose ? c + c : cmd.slice(i, j + 1);
    i = j + 1;
  }
  return out;
}

/** The command cut where a shell starts the next one (; && || and new lines, outside quotes). */
function commandParts(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (c === ';' || c === '\n' || two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      if (two === '&&' || two === '||') i++;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.filter((p) => p.trim());
}

/** `cd <folder>` and its PowerShell and cmd forms: the folder as written (quotes taken off); null for another command. */
function cdTarget(part: string): string | null {
  const m = /^\s*(?:cd|chdir|Set-Location|sl|Push-Location|pushd)(?:\s+\/d)?(?:\s+-(?:Path|LiteralPath))?(?:\s+(.*?))?\s*$/i.exec(part);
  if (!m) return null;
  const arg = (m[1] ?? '').trim();
  const quoted = /^(["'])(.*)\1$/.exec(arg);
  return quoted ? quoted[2] : (arg.split(/\s+/)[0] ?? '');
}

/** The folder after `cd <target>` from `cwd`; '' when the text does not show it (a variable, `cd -`). */
function folderAfterCd(target: string, cwd: string): string {
  const t = expandHome(target || '~');
  if (!t || t === '-' || /[$%`]/.test(t) || !cwd && !path.isAbsolute(t)) return '';
  const bash = process.platform === 'win32' ? /^\/([A-Za-z])(?=\/|$)(.*)$/.exec(t) : null;
  return bash ? path.resolve(`${bash[1]}:\\`, `.${bash[2] || '/'}`) : path.resolve(cwd, t);
}

/** A folder written into a variable earlier in the command (`$wt = 'C:\…'`, `wt=/c/…`): its name and text. */
function assignment(part: string): { name: string; value: string } | null {
  const m = /^\s*\$(\w+)\s*=\s*(['"])([^'"$`]*)\2\s*$/.exec(part) ?? /^\s*(\w+)=(['"]?)([^'"$`\s]*)\2\s*$/.exec(part);
  return m ? { name: m[1].toLowerCase(), value: m[3] } : null;
}

/**
 * `git -C <folder>`: the folder as written (`raw`, for its own check from the command's folder), where it is ('' when the
 * text does not show it: a variable not set earlier in the command) and the part without it; null without `-C`.
 */
function gitFolder(part: string, cwd: string, vars: Map<string, string>): { raw: string; dir: string; rest: string } | null {
  const m = /\bgit\s+-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(part);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  const v = /^\$\{?(\w+)\}?$/.exec(raw);
  const literal = v ? (vars.get(v[1].toLowerCase()) ?? '') : raw;
  return { raw: v ? '' : raw, dir: literal ? folderAfterCd(literal, cwd) : '', rest: part.slice(0, m.index) + part.slice(m.index + m[0].length) };
}

/** Why a shell command puts something in the wrong place; null when it does not (as far as its text shows). */
export function commandPlaceProblem(cmd: string, ctx: PlaceContext): string | null {
  const text = withoutQuotedProse(withoutInlineText(cmd));
  const parts = commandParts(text);
  const writes = WRITES.test(text);
  // Going into a folder is not writing for this: a command that only moves about and looks writes nothing.
  const writesBesidesCd = parts.some((p) => cdTarget(p) === null && WRITES.test(p));
  const looksOnly = LOOKS_ONLY.test(text) && !writes;
  let existing = ctx.existing;
  const vars = new Map<string, string>();
  // Each command in its turn, from the folder the ones before it went to.
  let cwd = ctx.cwd ?? process.cwd();
  for (const part of parts) {
    // With no writing anywhere, a part that starts with a looking command only looks (`ls ../other 2>/dev/null`).
    const partLooks = looksOnly || (!writesBesidesCd && LOOKS_ONLY.test(part));
    // `git -C <folder>` works in that folder: the part's ./ ../ start there.
    const git = gitFolder(part, cwd, vars);
    const mentioned = git ? [...(git.raw ? mentionedPaths(git.raw, ctx.aiRoot, cwd) : []), ...mentionedPaths(git.rest, ctx.aiRoot, git.dir)] : mentionedPaths(part, ctx.aiRoot, cwd);
    for (const p of mentioned) {
      const at = firstSegment(p, ctx.aiRoot);
      if (!at || !at.seg) continue;
      const seg = at.seg.toLowerCase();
      if (seg === SCRATCH) {
        if (writes) return scratchReason(ctx.aiRoot);
        continue;
      }
      existing ??= topEntries(ctx.aiRoot);
      if (!existing.has(seg) && !partLooks) return newTopReason(ctx.aiRoot, at.seg);
    }
    const target = cdTarget(part);
    if (target !== null) cwd = folderAfterCd(target, cwd);
    const set = assignment(part);
    if (set) vars.set(set.name, set.value);
  }
  return null;
}
