// PreToolUse 훅: 5시간 사용량이 기준(USAGE_PAUSE_PCT, 기본 90%) 이상이면 마무리용 도구(읽기·쓰기·기억 저장)만 허용하고
// 나머지는 막아, 하던 단계를 정리하고 멈추게 한다. 초기화 시각이 지나거나 기록이 30분 넘게 오래되면 막지 않는다.
// 사용량은 기록 파일(usage-file.mjs)에서 읽는다. 기록이 5분 넘게 오래되면 usage.ps1(/usage, 토큰 0)을
// 뒤에서 띄워 갱신하고, 이번 판정은 있는 기록으로 한다. 원격·백그라운드 세션은 상태줄이 돌지 않아 이 갱신에 기댄다.
// 끄기: ~/.claude/usage-guard-off 파일을 만든다.
// 구독 한도만 다루므로, API 키 환경변수로 도는 세션은 막지 않는다.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageDir, usageFile } from './usage-file.mjs';

const limit = Number(process.env.USAGE_PAUSE_PCT ?? 90);
const REFRESH_AFTER = 5 * 60 * 1000;
const WRAP_UP_TOOLS = /^(Read|Write|Edit|Glob|Grep|SendMessage|mcp__secretary__(remember|update_task|get_task))$/;

let input = {}, state = null;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
try { state = JSON.parse(readFileSync(usageFile(), 'utf8')); } catch {}

const now = Date.now();
const onSubscription = !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
if (onSubscription) refreshIfStale();

// 사용자가 "90퍼센트를 초과하더라도 진행"이라고 하면 프롬프트 훅(src/usage.ts)이 초기화 시각까지 풀어 둔다.
let overrideUntil = 0;
try { overrideUntil = Date.parse(JSON.parse(readFileSync(join(usageDir, 'guard-override.json'), 'utf8')).until); } catch {}

const paused = onSubscription && state && !existsSync(join(homedir(), '.claude', 'usage-guard-off'))
  && !(now < overrideUntil)
  && state.five_hour_pct >= limit
  && now - Date.parse(state.updated_at) < 30 * 60 * 1000
  && !(state.resets_at && now >= Date.parse(state.resets_at));

if (paused && !WRAP_UP_TOOLS.test(input.tool_name ?? '')) {
  const reset = state.resets_at
    ? new Date(state.resets_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '알 수 없음';
  const reason = `[사용량 일시 정지] 5시간 사용량 ${Math.round(state.five_hour_pct)}% (기준 ${limit}%). `
    + `새 작업을 시작하지 말고, 하던 단계만 마무리해 진행 상황(끝난 것·남은 것·다음 첫 단계)을 PROGRESS.md 등에 적은 뒤 턴을 끝내라. `
    + `초기화 시각(KST): ${reset}. 그 뒤에 이어서 한다. 읽기·쓰기·수정 도구는 쓸 수 있다.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

// 기록이 오래됐으면 갱신을 뒤에서 띄운다. 여러 세션이 한꺼번에 띄우지 않게 5분에 한 번만.
function refreshIfStale() {
  if (state && now - Date.parse(state.updated_at) < REFRESH_AFTER) return;
  const mark = usageFile().replace(/\.json$/, '.refresh');
  try { if (now - Number(readFileSync(mark, 'utf8')) < REFRESH_AFTER) return; } catch {}
  try {
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(mark, String(now));
    // 훅이 끝나면 Claude Code가 훅의 자식 프로세스까지 정리하므로, WMI로 부모와 상관없는 프로세스를 만든다.
    const script = join(dirname(fileURLToPath(import.meta.url)), 'usage.ps1');
    const cmd = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`;
    spawn('powershell.exe', ['-NoProfile', '-Command',
      `$null = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replaceAll("'", "''")}' }`],
      { stdio: 'ignore', windowsHide: true });
  } catch {}
}
