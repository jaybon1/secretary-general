// 업무 세션 PreToolUse 훅: 규칙 글로는 "드물게", 훅으로는 "거의 불가능하게" 막을 것만 막는다(Anthropic AI-native SDLC playbook).
// start-worker.ps1이 업무 세션 설정(--settings)에 넣는다: node worker-folder-guard.mjs <공간 폴더> [--lock-tests] [--secretary <비서 폴더>]...
// 막는 것: 공간 폴더 밖에 파일 쓰기(Write/Edit), git push, 공개 게시·업로드 명령, 큰 삭제, (--lock-tests면) 테스트 파일 수정,
// 결과물 상위 폴더 바로 아래에 새 폴더 만들기·그 temp 폴더에 쓰기를 하는 셸 명령(src/mistake-guards/folder-place.ts, 기능 'mistake-guards'가 켜졌을 때),
// 비서 폴더를 건드리는 셸 명령(--secretary로 받은 폴더. 긴 이름·8.3 짧은 이름 형식을 함께 받는다): 비서 진입점 bin\<이름>을 부르는 것만 된다.
// src\cli.ts 직접 실행, 비서 파일 읽기·고치기, 리디렉션·복사로 쓰기는 막힌다. 비서 폴더 환경변수(SECRETARY_<번호>_DIR, SECRETARY_DIR)도
// 그 아래 bin\만 된다. 읽기 전용 기억 도구(MCP)는 셸 명령이 아니라 이 훅과 상관없다.
// 셸 명령 안의 파일 쓰기(> 리디렉션 등)는 다 잡지 못한다. Claude Code가 아닌 CLI(agy, Copilot)에는 훅이 걸리지 않는다.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandPlaceProblem } from '../../src/mistake-guards/folder-place.ts';
import { guardsOn } from '../../src/mistake-guards/mistake-guard-settings.ts';

/** argv after the script: <workspace> [--lock-tests] [--secretary <dir>]... */
export function parseArgs(argv) {
  const [folder, ...rest] = argv;
  const secretary = [];
  let lockTests = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--lock-tests') lockTests = true;
    else if (rest[i] === '--secretary' && rest[i + 1]) secretary.push(rest[++i]);
  }
  return { folder, lockTests, secretary };
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

export function check(toolName, toolInput, workspace, { lockTests = false, secretary = [], cwd, aiRoot = AI_ROOT } = {}) {
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
    return secretaryProblem(cmd, secretary) ?? placeProblem(cmd, cwd ?? workspace, aiRoot);
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
  const { folder, lockTests, secretary } = parseArgs(process.argv.slice(2));
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const reason = check(input.tool_name ?? '', input.tool_input, folder, { lockTests, secretary, cwd: input.cwd });
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[업무 세션 규칙] ${reason}` },
    }));
  }
}
