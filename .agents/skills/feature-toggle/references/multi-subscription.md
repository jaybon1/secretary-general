# 다중 구독으로 일 보내기 (`multi-subscription`)

Claude 구독이 둘 이상일 때(계정 a = 비서 대화용, 계정 b·c… = 일 맡기기용) 쓴다. 켜면 매 질문에 모든 구독의 5시간 사용률과 일을 보낼 계정이 한 줄(`<secretary-usage>`)로 붙고, run-job·업무 세션이 그 계정으로 돈다(보낼 구독이 모두 90% 이상이면 그 줄이 다른 계정·공급자로 돌릴지 먼저 묻게 한다). 보낼 계정은 계정 a 밖의 구독 중 5시간 사용률이 가장 낮은 것이다(5시간·주간 사용량이 90%를 넘은 계정은 빼고, 아직 조회 기록이 없는 계정은 다른 계정에 기록이 없을 때만). 계정 a는 대화용이라 아끼고, 보낼 계정은 다 써도 된다. a가 다 차면 보낼 계정으로 비서 서버를 따로 띄워 대화를 이어 갈 수도 있다. 구독마다 요금이 든다.

## 켜는 순서

보낼 계정마다 1·2·3·4를 한다. 둘째 계정은 이름 끝이 `b`(`subscription-b`, 설정 폴더 `.claude-b`), 셋째는 `c`(`subscription-c`, `.claude-c`), 넷째는 `d`처럼 이어 간다. 아래 예는 둘째 계정(b)이다.

1. 사용자가 할 일(그 계정 로그인): 일반 PowerShell에서 `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.claude-b"; claude auth login; Remove-Item env:CLAUDE_CONFIG_DIR` 를 실행하고 열리는 브라우저에서 **그** 계정으로 로그인한다(셋째는 `.claude-c`로 바꿔 실행하고 셋째 계정으로). 그 설정 폴더에는 MCP·스킬을 넣지 않는다(run-job이 필요한 것만 붙인다).
2. 키 폴더(`%USERPROFILE%\.secretary\keys`, 없으면 만든다)에 `subscription-b.env`를 만들고 한 줄 `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-b`를 쓴다(비밀값이 아니라 설정 폴더 위치라 비서가 써도 된다). 셋째는 `subscription-c.env`에 `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-c`.
3. `scripts/lib/providers.json`의 `providers`에 아래 항목을 넣는다(셋째는 이름·폴더의 `b`를 `c`로). 화면에는 `subscription-b`가 "계정 b", `subscription-c`가 "계정 c"로 보인다.
   ```
   "subscription-b": {
     "type": "claude-subscription",
     "personalDataAllowed": true,
     "usage": "claude-usage",
     "effort": "high",
     "note": "Claude 구독(계정 b). 키: <키 폴더>/subscription-b.env (CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-b)"
   }
   ```
   그리고 `"default"`를 바꾼다(업무 세션·run-job이 그 공급자로 돈다. 비서 대화와 쉬는 시간 작업은 그대로 a):
   - 보낼 계정이 하나(b)면 `"subscription-b"`.
   - 둘 이상이면 `"auto"`: 업무 세션·run-job을 시작할 때마다 위 규칙으로 가장 여유 있는 계정을 골라 그 계정으로 돈다(`<secretary-usage>` 줄과 같은 규칙, `node src/cli.ts subscription-pick`가 지금 고를 계정을 알려 준다). 보낼 계정으로 띄운 비서 대화(아래 7)에서 맡기면 그 계정으로 돈다. 특정 계정으로 돌리려면 `-Provider subscription-c`처럼 준다. `"auto"` 대신 한 계정 이름을 두면 그 계정으로만 돌고, 다른 계정이 더 여유 있으면 `<secretary-usage>` 줄이 `-Provider`를 주라고 알린다.
4. 사용량 정지 장치를 그 계정의 설정 폴더에도: `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.claude-b"; node scripts/usage/install-usage-guard.mjs; Remove-Item env:CLAUDE_CONFIG_DIR`
5. `features.json`의 `multi-subscription`를 `"enabled": true`로. AGENTS.md는 그대로 둔다(무엇을 run-job으로 넘길지는 `### 공급자`의 "비싼 작업은 run-job으로" 줄이 사용량과 상관없이 정한다).
6. 확인: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usage/usage-query.ps1`이 모든 계정 사용량을 적는지, `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/run-job.ps1 -Model haiku -New -Prompt "확인이라고만 답하라"`가 보낼 계정으로 도는지(출력 첫 줄의 공급자와 `~/.secretary/usage/subscription-<그 계정 메일의 @ 앞>.json`) 본다.
7. (선택) 계정 a가 다 찼을 때 보낼 계정으로 비서 대화를 열 서버: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/remote-server/server-control.ps1 -Action restart -Provider subscription-b`(서버 이름 '비서-b', 셋째 계정이면 `-Provider subscription-c`로 '비서-c'). 바탕화면 바로가기로 두려면 대상에 `conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<비서 폴더>\bin\server-control.ps1" -Action restart -Provider subscription-b -Now -Notify`를 쓴다.

## 끄는 순서

`"enabled": false`로 하고, `providers.json`의 `"default"`를 `"subscription"`으로 되돌린다(`subscription-b`·`subscription-c` 같은 항목과 키 파일, 그 계정들의 로그인은 그대로 둔다). 보낼 계정으로 띄운 서버가 있으면 그 창을 닫는다.
