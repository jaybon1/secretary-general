// 업무 세션 PreToolUse 훅: 규칙 글로는 "드물게", 훅으로는 "거의 불가능하게" 막을 것만 막는다(Anthropic AI-native SDLC playbook).
// start-worker.ps1이 업무 세션 설정(--settings)에 넣는다: node worker-guard.mjs <공간 폴더> [--lock-tests]
// 막는 것: 공간 폴더 밖에 파일 쓰기(Write/Edit), git push, 공개 게시·업로드 명령, 큰 삭제, (--lock-tests면) 테스트 파일 수정.
// 셸 명령 안의 파일 쓰기(> 리디렉션 등)는 다 잡지 못한다. Claude Code가 아닌 CLI에는 훅이 걸리지 않는다.
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const [folder, ...flags] = process.argv.slice(2);
const lockTests = flags.includes('--lock-tests');

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

export function check(toolName, toolInput, workspace, { lockTests = false } = {}) {
  if (WRITE_TOOLS.test(toolName)) {
    const file = toolInput?.file_path ?? toolInput?.notebook_path;
    if (!file || !workspace) return null;
    const rel = relative(resolve(workspace), resolve(workspace, file));
    if (rel.startsWith('..') || isAbsolute(rel)) return `공간 폴더 밖에는 쓰지 않는다: ${file}`;
    if (lockTests && TEST_FILE.test(rel)) return `테스트 잠금 업무라 테스트 파일은 고칠 수 없다: ${rel}. 테스트가 아니라 코드를 고치고, 테스트가 틀렸다고 보이면 [질문]으로 물어라.`;
    return null;
  }
  if (SHELL_TOOLS.test(toolName)) {
    const cmd = String(toolInput?.command ?? '');
    for (const [pattern, what] of BLOCKED_COMMANDS) if (pattern.test(cmd)) return `${what} 명령은 업무 세션에서 막혀 있다. 꼭 필요하면 [질문]으로 물어라.`;
  }
  return null;
}

// 테스트가 check만 가져다 쓸 수 있게, 훅으로 실행됐을 때만 표준입력을 읽는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const reason = check(input.tool_name ?? '', input.tool_input, folder, { lockTests });
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[업무 세션 규칙] ${reason}` },
    }));
  }
}
