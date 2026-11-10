// PreToolUse 훅: 5시간 또는 주간 사용량이 기준(SECRETARY_USAGE_GUARD_PCT, 기본 90%) 이상이면 마무리용 도구(읽기·쓰기·기억 저장)만 허용하고
// 나머지는 막아, 하던 단계를 정리하고 멈추게 한다. 초기화 시각이 지나거나 기록이 30분 넘게 오래되면 막지 않는다.
// 사용량은 이 세션 공급자·계정의 파일(usage-file.mjs, subscription-<계정>.json)에서 읽는다. 기록이 5분 넘게 오래되면 usage-query.ps1(/usage, 토큰 0)을
// 뒤에서 띄워 갱신하고, 이번 판정은 있는 기록으로 한다. 원격·백그라운드 세션은 상태줄이 돌지 않아 이 갱신에 기댄다.
// 기능 usage-poll(비서 서버와 같이 뜨는 조회기)이 켜져 있으면 그쪽이 5분마다 조회하며 같은 이름의 .refresh 표시를 남기므로, 이 갱신은 그때 예비다.
// 끄기: ~/.secretary/usage-guard-off 파일을 만든다(2026-11-10 전 자리 ~/.claude/usage-guard-off도 한동안 읽는다, usage-files.ts guardOff).
// 구독 한도만 다루므로, 다른 공급자(Bedrock, Vertex, API 키, 게이트웨이)로 도는 세션은 막지 않는다. 기록이 없으면(조회가 안 되는 로그인 포함) 막지 않는다.
// 조회가 거듭 실패하면(/usage가 사용량을 주지 않는 API 키 로그인 등, <같은 이름>.fail) 다음 갱신을 5분부터 두 배씩 최대 6시간 미룬다(usage-files.ts failureWait).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageDir, readUsage, refreshFile, failureWait, currentProvider, onSubscription, readOverrideUntil, guardOff } from './usage-file.mjs';

// 기준 SECRETARY_USAGE_GUARD_PCT(2026-11-09부터, 옛 이름 USAGE_PAUSE_PCT도 한동안 읽는다).
const limit = Number(process.env.SECRETARY_USAGE_GUARD_PCT ?? process.env.USAGE_PAUSE_PCT ?? 90); // legacy-name: env-usage-guard-pct
const REFRESH_AFTER = 5 * 60 * 1000;
const WRAP_UP_TOOLS = /^(Read|Write|Edit|Glob|Grep|SendMessage|mcp__secretary__(remember|update_task|get_task|set_big_work))$/;

let input = {}, state = null;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
// 새 폴더(~/.secretary/usage)와 옛 폴더(~/.claude/usage, 옛 사본이 아직 쓰는 동안) 가운데 새 기록.
try { state = readUsage(currentProvider()); } catch {}

const now = Date.now();
const subscribed = onSubscription();
if (subscribed) refreshIfStale();

// 사용자가 "90퍼센트를 초과하더라도 진행"이라고 하면 프롬프트 훅(src/usage/usage-guard-override.ts)이 문구에 적힌 계정(없으면 이 대화의 계정)만 초기화 시각까지 풀어 둔다
// (usage-guard-override-subscription-<계정>.json, 2026-11-09까지는 옛 폴더의 guard-override-…json도 초기화 시각까지 읽고 지난 것은 지운다).
// 계정 칸이 없던 옛 guard-override.json은 모든 계정을 함께 풀었으므로 읽지 않는다.
let overrideUntil = 0;
try { overrideUntil = readOverrideUntil(currentProvider(), usageDir, {}, now); } catch {}

// 주간 한도도 같은 기준으로 본다. 풀어 두기(override)는 어느 쪽으로 걸렸든 5시간 창 초기화까지만 간다.
const over = (pct, resetsAt) => pct >= limit && !(resetsAt && now >= Date.parse(resetsAt));
const hit = !subscribed || !state || guardOff()
  || now < overrideUntil || now - Date.parse(state.updated_at) >= 30 * 60 * 1000 ? null
  : over(state.week_pct ?? 0, state.week_resets_at) ? { label: '주간', pct: state.week_pct, resetsAt: state.week_resets_at }
  : over(state.five_hour_pct, state.resets_at) ? { label: '5시간', pct: state.five_hour_pct, resetsAt: state.resets_at }
  : null;

if (hit && !WRAP_UP_TOOLS.test(input.tool_name ?? '')) {
  const reset = hit.resetsAt
    ? new Date(hit.resetsAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '알 수 없음';
  const reason = `[사용량 일시 정지] ${hit.label} 사용량 ${Math.round(hit.pct)}% (기준 ${limit}%). `
    + `새 작업을 시작하지 말고, 하던 단계만 마무리해 진행 상황(끝난 것·남은 것·다음 첫 단계)을 PROGRESS.md 등에 적은 뒤 턴을 끝내라. `
    + `초기화 시각(KST): ${reset}. 그 뒤에 이어서 한다. 읽기·쓰기·수정 도구는 쓸 수 있다.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

// 기록이 오래됐으면 갱신을 뒤에서 띄운다. 여러 세션이 한꺼번에 띄우지 않게 5분에 한 번만.
function refreshIfStale() {
  if (state && now - Date.parse(state.updated_at) < REFRESH_AFTER) return;
  const mark = refreshFile();
  try { if (now - Number(readFileSync(mark, 'utf8')) < REFRESH_AFTER) return; } catch {}
  try { if (failureWait(currentProvider(), usageDir, now) > 0) return; } catch {}
  try {
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(mark, String(now));
    // 시험(test/env.ts의 표시)에서는 표시만 남기고 띄우지 않는다: 따로 띄운 프로세스는 시험 환경을 물려받지 않아 진짜 조회를 한다.
    if (process.env.SECRETARY_NO_MODEL_CALLS) return;
    // 훅이 끝나면 Claude Code가 훅의 자식 프로세스까지 정리하므로, WMI로 부모와 상관없는 프로세스를 만든다.
    // -WindowStyle Hidden만으로는 창이 잠깐 떴다 사라지므로 conhost --headless로 창 없이 띄운다.
    const script = join(dirname(fileURLToPath(import.meta.url)), 'usage-query.ps1');
    const cmd = `conhost.exe --headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}" -Provider ${currentProvider()}`;
    spawn('powershell.exe', ['-NoProfile', '-Command',
      `$null = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replaceAll("'", "''")}' }`],
      { stdio: 'ignore', windowsHide: true });
  } catch {}
}
