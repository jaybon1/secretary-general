/**
 * Where results may go (feature 'guards'): nothing new directly under the results' parent folder (the secretary's own
 * parent, aiRoot), and nothing written into its temp folder (the user's own scratch space). What is already there
 * (workspaces, notes, inbox, the secretary folders) stays usable. The secretary's PreToolUse hook (pre-tool-hook.ts) and
 * the work sessions' worker-guard (scripts/worker/worker-guard.mjs) both ask here.
 *
 * A shell command is read as text: paths are found by their written form (absolute, under the home folder by variable,
 * or relative with ./ ../ against the command's folder). A path built inside a script, a variable of the command's own,
 * an 8.3 short name, or a program that picks its output folder by itself is not seen.
 */
import os from 'node:os';
import path from 'node:path';
import { topEntries } from './settings.ts';

export interface PlaceContext {
  /** The results' parent folder. */
  aiRoot: string;
  /** Its top-level entries now, lower case (read from the disk when left out). */
  existing?: Set<string>;
  /** The folder a relative path is from. */
  cwd?: string;
}

const SCRATCH = 'temp';

const placeHint = 'workspaces/run-job-home/output/research/<날짜-일>/(단건 조사·시험), workspaces/quick-outputs(작은 결과물), 맡긴 일은 그 업무 공간 안';
const newTopReason = (root: string, seg: string) =>
  `${path.basename(root)} 바로 아래에는 새 폴더·파일을 만들지 않는다(${seg}). ${placeHint}에 둔다. 꼭 그 자리여야 하면 먼저 사용자에게 묻는다.`;
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
  for (const m of text.matchAll(/(?:^|[\s"'=(,])((?:\.{1,2}[\\/])+[^\s"'`;|&<>)]*)/g)) found.push(path.resolve(cwd, m[1]));
  return found;
}

/** Why a shell command puts something in the wrong place; null when it does not (as far as its text shows). */
export function commandPlaceProblem(cmd: string, ctx: PlaceContext): string | null {
  const cwd = ctx.cwd ?? process.cwd();
  const writes = WRITES.test(cmd);
  const looksOnly = LOOKS_ONLY.test(cmd) && !writes;
  let existing = ctx.existing;
  for (const p of mentionedPaths(cmd, ctx.aiRoot, cwd)) {
    const at = firstSegment(p, ctx.aiRoot);
    if (!at || !at.seg) continue;
    const seg = at.seg.toLowerCase();
    if (seg === SCRATCH) {
      if (writes) return scratchReason(ctx.aiRoot);
      continue;
    }
    existing ??= topEntries(ctx.aiRoot);
    if (!existing.has(seg) && !looksOnly) return newTopReason(ctx.aiRoot, at.seg);
  }
  return null;
}
