// 업무 세션 PreToolUse 훅: 규칙 글로는 "드물게", 훅으로는 "거의 불가능하게" 막을 것만 막는다(Anthropic AI-native SDLC playbook).
// start-worker.ps1(업무 세션)과, 개인정보를 넣으면 안 되는 공급자의 run-job.ps1이 설정(--settings)에 넣는다(providers.ps1 Get-FolderGuardHook):
//   node worker-folder-guard.mjs <공간 폴더> [--lock-tests] [--secretary <비서 폴더>]...
//     [--limit-reads [--read-root <폴더>]... [--private <폴더>]... [--read-scope <폴더·파일>]... [--sibling-private <폴더>]...]
// --read-scope가 있으면 읽기는 공간 폴더 대신 그것만(run-job: 그 일의 결과 폴더와 작업 폴더의 AGENTS.md·CLAUDE.md, 쓰기는 그대로 공간 폴더 안),
// --sibling-private <폴더>면 셸 명령이 그 폴더 옆의 다른 폴더(다른 run-job의 결과 폴더)를 적어도 막는다.
// --limit-reads(개인정보를 넣으면 안 되는 공급자, providers.json personalDataAllowed가 true가 아님): Read·Grep·Glob은 공간 폴더와
// --read-root 폴더(공통 스킬 폴더), 그 세션 자기 임시 파일만 읽게 하고, 셸 명령이 개인 자료 자리(키 폴더 등 --private, ~/.secretary,
// 결과물 상위의 notes·inbox, ~/.claude 설정 폴더, secretary.db)를 적으면 막는다. 개인 자료가 외부 중개 서버로 나가지 않게 하기 위해서다.
// 막는 것: 공간 폴더 밖에 파일 쓰기(Write/Edit), git push, 공개 게시·업로드 명령, 큰 삭제, (--lock-tests면) 테스트 파일 수정,
// 결과물 상위 폴더 바로 아래에 새 폴더 만들기·그 temp 폴더에 쓰기를 하는 셸 명령(src/mistake-guards/folder-place.ts, 기능 'mistake-guards'가 켜졌을 때),
// 비서 폴더를 건드리는 셸 명령(--secretary로 받은 폴더. 긴 이름·8.3 짧은 이름 형식을 함께 받는다): 비서 진입점 bin\<이름>을 부르는 것만 된다.
// src\cli.ts 직접 실행, 비서 파일 읽기·고치기, 리디렉션·복사로 쓰기는 막힌다. 비서 폴더 환경변수(SECRETARY_<번호>_DIR, SECRETARY_DIR)도
// 그 아래 bin\만 된다. 읽기 전용 기억 도구(MCP)는 셸 명령이 아니라 이 훅과 상관없다.
// 셸 명령 안의 파일 쓰기(> 리디렉션 등)는 다 잡지 못한다. Claude Code가 아닌 CLI(agy, Copilot)에는 훅이 걸리지 않는다.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandPlaceProblem } from '../../src/mistake-guards/folder-place.ts';
import { guardsOn } from '../../src/mistake-guards/mistake-guard-settings.ts';

/** argv after the script: <workspace> [--lock-tests] [--secretary <dir>]... [--limit-reads] [--read-root <dir>]... [--private <dir>]... */
export function parseArgs(argv) {
  const [folder, ...rest] = argv;
  const secretary = [];
  const readRoots = [];
  const privateDirs = [];
  const readScope = [];
  const siblingPrivate = [];
  let lockTests = false;
  let limitReads = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--lock-tests') lockTests = true;
    else if (rest[i] === '--limit-reads') limitReads = true;
    else if (rest[i] === '--secretary' && rest[i + 1]) secretary.push(rest[++i]);
    else if (rest[i] === '--read-root' && rest[i + 1]) readRoots.push(rest[++i]);
    else if (rest[i] === '--private' && rest[i + 1]) privateDirs.push(rest[++i]);
    else if (rest[i] === '--read-scope' && rest[i + 1]) readScope.push(rest[++i]);
    else if (rest[i] === '--sibling-private' && rest[i + 1]) siblingPrivate.push(rest[++i]);
  }
  return { folder, lockTests, secretary, limitReads, readRoots, privateDirs, readScope, siblingPrivate };
}

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;
export const TEST_FILE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|[._-](test|spec)\.[a-z0-9]+$/i;
export const BLOCKED_COMMANDS = [
  [/\bgit\s+push\b/i, 'git push'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b/i, '패키지·이미지 게시'],
  [/\bgh\s+(release|repo|gist|pr)\s+create\b/i, 'GitHub 게시'],
  [/(^|[;&|]\s*)(npx\s+)?(vercel|netlify\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish)|surge)\b/im, '배포'],
  [/\bcurl\b.*\s(-T|--upload-file|-F|--form)\s|\bInvoke-(RestMethod|WebRequest)\b.*-InFile\b/i, '파일 업로드'],
  [/\brm\s+(-\w*r\w*|--recursive)\b|\bRemove-Item\b.*-Recurse\b|\b(rmdir|rd)\s+\/s\b/i, '큰 삭제(폴더 통째 삭제)'],
];

/** 원본에만 있는 기능(외부 기기)의 막기 자리: 배포판에는 그 입구가 없어 막을 것이 없다. */
export function deviceExecProblem() {
  return null;
}
export function deviceMarks() {
  return { names: [], keys: [], keyPaths: [] };
}
export function deviceSshProblem() {
  return null;
}
export function deviceKeyReadProblem() {
  return null;
}

/** Commands that write, copy, move or delete: never in the same command as the secretary folder, not even its bin\. */
const WRITES = /(^|[^\w-])(Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|Remove-Item|Rename-Item|Clear-Content|cp|mv|rm|del|copy|move|tee|sc|ac)(\s|$)|\bsed\s+-i\b|\[IO\.File\]::(Write|Append|Copy|Move|Delete)/i;
/** A file redirect (> or >>, not 2>&1) right before a mention. */
const REDIRECT_BEFORE = />{1,2}\s*["']?$/;
/** A secretary folder variable in PowerShell, bash or cmd form, and what follows it (the keys folder's variable is not one). */
const DIR_VAR = /(\$env:|\$\{?|%)SECRETARY(?:_(?!KEYS_)[A-Z0-9]+)?_DIR\}?%?(\S*)/gi;

/** A path as commands write it, for comparing: forward slashes, no doubled slashes, lower case. */
const plain = (s) => s.replace(/\\+/g, '/').replace(/\/{2,}/g, '/').toLowerCase();

/**
 * Each secretary folder in the forms a command may use: C:/x/y, the Git Bash /c/x/y, and /<folder name> for a
 * relative path from the workspace (..\..\secretary-x\src).
 */
function forms(dirs) {
  const out = new Set();
  for (const d of dirs) {
    const p = plain(resolve(d)).replace(/\/$/, '');
    out.add(p);
    const m = /^([a-z]):\/(.*)$/.exec(p);
    if (m) out.add(`/${m[1]}/${m[2]}`);
    // Not a short 8.3 name: SECRET~1 in another folder is another folder.
    const name = p.split('/').pop();
    if (name && !name.includes('~')) out.add(`/${name}`);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The bin entries of the secretary (the files in its bin folder), lower case; empty when it can't be read. */
function entries(dirs) {
  for (const d of dirs) {
    try {
      return new Set(readdirSync(join(d, 'bin')).map((n) => n.toLowerCase()));
    } catch {}
  }
  return new Set();
}

/**
 * Why a shell command may not touch the secretary folder; null when it does not touch it or only calls a bin entry.
 * Every mention (the folder in any form, or a folder variable) must be <folder>/bin/<entry> with nothing written.
 */
export function secretaryProblem(cmd, dirs, names = entries(dirs)) {
  if (!dirs?.length) return null;
  const text = plain(cmd);
  const bad = (why) => `비서 폴더는 진입점(bin\\<이름>)을 부르는 것만 된다(${why}). 그 밖의 파일이 꼭 필요하면 [질문]으로 물어라.`;
  let touched = false;
  for (const f of forms(dirs)) {
    let at = text.indexOf(f);
    while (at >= 0) {
      const end = at + f.length;
      const next = text[end];
      // Another folder that only starts the same (secretary-2 beside secretary): not this one.
      if (next !== undefined && !/[\/"'\s;|&)`]/.test(next)) {
        at = text.indexOf(f, end);
        continue;
      }
      touched = true;
      const m = /^\/bin\/([\w.-]+)/.exec(text.slice(end));
      if (!m) return bad(`비서 폴더 ${text.slice(at, end + 30).split(/[\s"'`]/)[0]}`);
      if (!names.has(m[1])) return bad(`bin에 없는 진입점 ${m[1]}`);
      if (REDIRECT_BEFORE.test(text.slice(0, at))) return bad('진입점에 리디렉션으로 쓰기');
      at = text.indexOf(f, end);
    }
  }
  for (const v of cmd.matchAll(DIR_VAR)) {
    touched = true;
    const m = /^[\\/]+bin[\\/]+([\w.-]+)/.exec(v[2]);
    if (!m) return bad(`비서 폴더 환경변수 ${v[0]}`);
    if (names.size && !names.has(m[1].toLowerCase())) return bad(`bin에 없는 진입점 ${m[1]}`);
  }
  if (touched && WRITES.test(cmd)) return bad('쓰기·복사·지우기 명령과 함께');
  return null;
}

/** The results' parent folder: the parent of the secretary folder this guard is in (scripts/worker/ → two up). */
export const AI_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

// ---- --limit-reads: what a session on a provider that may not see personal data can read ----

const READ_TOOLS = /^(Read|Grep|Glob)$/;
const GLOB_CHAR = /[*?[\]{}]/;
/** A Git Bash drive path (/c/Users/...) as Windows writes it. */
const fromBash = (p) => p.replace(/^\/([a-z])(?=\/|$)/i, '$1:');

/**
 * Where a path really is, in plain form: the real path of its nearest existing folder (junctions and links followed, 8.3 short
 * names made long) with the rest added. A link made inside the workspace to a private folder is caught by where it leads.
 */
function realPlain(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return plain(join(realpathSync.native(cur), ...rest));
    } catch {}
    const up = dirname(cur);
    if (up === cur) return plain(resolve(p));
    rest.unshift(basename(cur));
    cur = up;
  }
}

const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The session's own files: under its transcript folder or the temp folder, in a folder named by its session id (tool results, scratchpad). */
function ownSessionFile(p, sessionId, transcriptPath) {
  if (!sessionId || !p.split('/').includes(String(sessionId).toLowerCase())) return false;
  const roots = [realPlain(tmpdir())];
  if (transcriptPath) roots.push(realPlain(dirname(transcriptPath)));
  return roots.some((r) => inside(p, r));
}

/**
 * The folders a read tool reaches: Read its file, Grep its path (or the session's folder), Glob its path and the fixed start
 * of its pattern (before the first wildcard: C:/x/** or ../** reach out). null when a Glob pattern climbs (..) after a wildcard.
 */
function readTargets(toolName, input, base) {
  if (toolName === 'Read') return input?.file_path ? [resolve(base, fromBash(String(input.file_path)))] : [];
  const dir = input?.path ? resolve(base, fromBash(String(input.path))) : base;
  if (toolName === 'Grep') return [dir];
  const pattern = fromBash(String(input?.pattern ?? ''));
  const g = pattern.search(GLOB_CHAR);
  if (g < 0) return [resolve(dir, pattern)];
  if (/(^|[\\/])\.\.([\\/]|$)/.test(pattern.slice(g))) return null;
  const cut = Math.max(pattern.lastIndexOf('/', g), pattern.lastIndexOf('\\', g));
  return [cut < 0 ? dir : resolve(dir, pattern.slice(0, cut + 1))];
}

/**
 * Why a Read, Grep or Glob may not run in a --limit-reads session; null when it stays in the workspace (or, with --read-scope,
 * only those folders and files: a run-job's result folder and its folder's AGENTS.md), a --read-root or its own files.
 */
export function readProblem(toolName, input, { workspace, readRoots = [], readScope = [], cwd, sessionId, transcriptPath } = {}) {
  const roots = [...(readScope.length ? readScope : [workspace]), ...readRoots].filter(Boolean).map(realPlain);
  const targets = readTargets(toolName, input, cwd ?? workspace ?? process.cwd());
  const why = (what) =>
    `이 세션은 개인정보를 넣으면 안 되는 공급자로 돌아 공간 폴더와 공통 스킬 폴더 밖은 읽지 않는다: ${what}. 업무에 꼭 필요한 파일이면 [질문]으로 공간 폴더 안에 넣어 달라고 하라.`;
  if (targets === null) return why(`Glob 패턴 ${input?.pattern}(와일드카드 뒤의 ..)`);
  for (const t of targets) {
    const p = realPlain(t);
    if (!roots.some((r) => inside(p, r)) && !ownSessionFile(p, sessionId, transcriptPath)) return why(t);
  }
  return null;
}

/** A home-folder start a command may write a path with (~, $HOME, $env:USERPROFILE, %USERPROFILE%). */
const HOME_START = /^(~|\$\{?HOME\}?|\$env:(USERPROFILE|HOME)|%USERPROFILE%)(?=[\\/]|$)/i;

/** The path-like words of a command: whole quoted strings and the pieces between spaces, quotes and shell marks. */
function pathWords(cmd) {
  const words = [];
  for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'/g)) words.push(m[1] ?? m[2]);
  words.push(...cmd.split(/[\s"'`;|&<>(),=]+/));
  return words.filter((w) => w && !/^[a-z][\w+.-]*:\/\//i.test(w) && (/[\\/]/.test(w) || HOME_START.test(w) || /^\.\.?$/.test(w)));
}

/**
 * Why a shell command in a --limit-reads session may not run: it names a private place, the keys folder (--private, its
 * variable SECRETARY_KEYS_DIR), ~/.secretary, the notes and inbox beside the secretary, a Claude config folder in the home
 * folder (~/.claude, ~/.claude-b: every conversation's transcript) or secretary.db. Paths are read from the command's words
 * (relative ones from cwd); a path built inside a script is not seen (a speed bump against mistakes and injected
 * instructions, like the rest of this guard). The session's own files (tool results under its config folder) pass.
 */
export function privateShellProblem(cmd, { cwd, privateDirs = [], siblingPrivate = [], aiRoot = AI_ROOT, home = homedir(), sessionId, transcriptPath } = {}) {
  const why = (what) => `이 세션은 개인정보를 넣으면 안 되는 공급자로 돌아 개인 자료 자리는 읽지 않는다(${what}). 업무에 꼭 필요한 파일이면 [질문]으로 공간 폴더 안에 넣어 달라고 하라.`;
  if (/\bSECRETARY_KEYS_DIR\b/i.test(cmd)) return why('키 폴더 환경변수 SECRETARY_KEYS_DIR');
  if (/(^|[\\/'"`\s=:(])\.secretary([\\/'"`\s);|&]|$)/i.test(cmd)) return why('~/.secretary');
  if (/(^|[^\w-])secretary\.db\b/i.test(cmd)) return why('secretary.db');
  const homeReal = realPlain(home);
  const roots = [...privateDirs, join(home, '.secretary'), ...(aiRoot ? [join(aiRoot, 'notes'), join(aiRoot, 'inbox')] : [])].map(realPlain);
  const siblings = siblingPrivate.map((s) => [realPlain(dirname(resolve(s))), realPlain(s)]);
  for (const w of pathWords(cmd)) {
    const p = realPlain(resolve(cwd ?? process.cwd(), fromBash(w.replace(HOME_START, home.replace(/\$/g, '$$$$')))));
    if (ownSessionFile(p, sessionId, transcriptPath)) continue;
    if (roots.some((r) => inside(p, r))) return why(w);
    // --sibling-private <dir>: the folders beside it (a run-job's result folder: the other jobs' results) and their parent.
    if (siblings.some(([parent, self]) => inside(p, parent) && !inside(p, self))) return why(`다른 일의 결과 폴더 ${w}`);
    const first = inside(p, homeReal) ? p.slice(homeReal.length).split('/').filter(Boolean)[0] : undefined;
    if (first && /^\.claude(-[^/]*)?$/.test(first)) return why(`Claude 설정 폴더 ${w}`);
  }
  return null;
}

export function check(
  toolName,
  toolInput,
  workspace,
  {
    lockTests = false,
    secretary = [],
    cwd,
    aiRoot = AI_ROOT,
    limitReads = false,
    readRoots = [],
    privateDirs = [],
    readScope = [],
    siblingPrivate = [],
    sessionId,
    transcriptPath,
    home,
    devices,
  } = {},
) {
  const keyRead = READ_TOOLS.test(toolName) ? deviceKeyReadProblem(toolName, toolInput, devices, cwd ?? workspace) : null;
  if (keyRead) return keyRead;
  if (limitReads && READ_TOOLS.test(toolName)) return readProblem(toolName, toolInput, { workspace, readRoots, readScope, cwd, sessionId, transcriptPath });
  if (WRITE_TOOLS.test(toolName)) {
    const file = toolInput?.file_path ?? toolInput?.notebook_path;
    if (!file || !workspace) return null;
    const rel = relative(resolve(workspace), resolve(workspace, file));
    if (rel.startsWith('..') || isAbsolute(rel)) return `공간 폴더 안에만 쓴다(밖은 읽기만): ${file}`;
    if (lockTests && TEST_FILE.test(rel)) return `테스트 잠금 업무라 테스트 파일은 고칠 수 없다: ${rel}. 테스트가 아니라 코드를 고치고, 테스트가 틀렸다고 보이면 [질문]으로 물어라.`;
    return null;
  }
  if (SHELL_TOOLS.test(toolName)) {
    const cmd = String(toolInput?.command ?? '');
    for (const [pattern, what] of BLOCKED_COMMANDS) if (pattern.test(cmd)) return `${what} 명령은 업무 세션에서 막혀 있다. 꼭 필요하면 [질문]으로 물어라.`;
    return (
      deviceExecProblem(cmd) ??
      deviceSshProblem(cmd, devices) ??
      secretaryProblem(cmd, secretary) ??
      (limitReads ? privateShellProblem(cmd, { cwd: cwd ?? workspace, privateDirs, siblingPrivate, aiRoot, home, sessionId, transcriptPath }) : null) ??
      placeProblem(cmd, cwd ?? workspace, aiRoot)
    );
  }
  return null;
}

/**
 * The secretary's folder-place rule (src/mistake-guards/folder-place.ts, feature 'mistake-guards'): nothing new directly under the
 * results' parent folder, nothing written into its temp folder. Writes outside the workspace are refused above already;
 * this reads shell commands. Skipped when the feature is off or there is no parent folder to compare with.
 */
function placeProblem(cmd, cwd, aiRoot) {
  if (!aiRoot || !guardsOn()) return null;
  const why = commandPlaceProblem(cmd, { aiRoot, cwd: cwd ?? process.cwd() });
  return why ? `${why} 꼭 필요하면 [질문]으로 물어라.` : null;
}

// 테스트가 check만 가져다 쓸 수 있게, 훅으로 실행됐을 때만 표준입력을 읽는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { folder, ...opts } = parseArgs(process.argv.slice(2));
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  // 외부 기기 표시(host·키 이름·키 경로)는 셸 명령과 읽기 도구일 때만 설정에서 읽는다.
  const devices = SHELL_TOOLS.test(input.tool_name ?? '') || READ_TOOLS.test(input.tool_name ?? '') ? deviceMarks() : undefined;
  const reason = check(input.tool_name ?? '', input.tool_input, folder, { ...opts, cwd: input.cwd, sessionId: input.session_id, transcriptPath: input.transcript_path, devices });
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[업무 세션 규칙] ${reason}` },
    }));
  }
}
