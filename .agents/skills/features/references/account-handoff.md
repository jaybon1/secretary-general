# 두 번째 구독으로 일 넘기기 (`account-handoff`)

Claude 구독이 둘일 때(계정 a = 비서 대화용, 계정 b = 일 맡기기용) 쓴다. 켜면 매 질문에 두 계정의 5시간 사용률과 "넘기는 정도"가 한 줄(`<secretary-usage>`)로 붙고, 비서는 그 단계대로 비싼 일을 run-job·업무 세션으로 계정 b에 넘긴다. 계정 a는 대화용이라 아끼고, b는 다 써도 된다. a가 다 차면 계정 b로 비서 서버를 따로 띄워 대화를 이어 갈 수도 있다. 두 번째 구독 요금이 든다.

## 켜는 순서

1. 사용자가 할 일(두 번째 계정 로그인): 일반 PowerShell에서 `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.claude-b"; claude auth login; Remove-Item env:CLAUDE_CONFIG_DIR` 를 실행하고 열리는 브라우저에서 **두 번째** 계정으로 로그인한다. 그 설정 폴더에는 MCP·스킬을 넣지 않는다(run-job이 필요한 것만 붙인다).
2. 키 폴더(`%USERPROFILE%\.secretary\keys`, 없으면 만든다)에 `subscription-b.env`를 만들고 한 줄 `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-b`를 쓴다(비밀값이 아니라 설정 폴더 위치라 비서가 써도 된다).
3. `scripts/lib/providers.json`의 `providers`에 아래 항목을 넣고 `"default"`를 `"subscription-b"`로 바꾼다(업무 세션·run-job이 b로 돈다. 비서 대화와 쉬는 시간 작업은 그대로 a).
   ```
   "subscription-b": {
     "type": "claude-subscription",
     "usage": "claude-usage",
     "effort": "high",
     "note": "두 번째 Claude 구독. 키: <키 폴더>/subscription-b.env (CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-b)"
   }
   ```
4. 사용량 정지 장치를 b 설정 폴더에도: `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.claude-b"; node scripts/usage/install-usage-guard.mjs; Remove-Item env:CLAUDE_CONFIG_DIR`
5. `features.json`의 `account-handoff`를 `"enabled": true`로, 아래 글을 AGENTS.md `### 공급자 (어느 요금으로 돌리나)`의 "파일이 생기는 일은 어느 경우든 업무 세션으로 따로 띄운다." 줄 바로 앞에 넣는다.
6. 확인: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usage/usage-query.ps1`이 두 계정 사용량을 적는지, `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/run-job.ps1 -Model haiku -New -Prompt "확인이라고만 답하라"`가 계정 b로 도는지(출력과 `~/.claude/usage/subscription-<계정 b 메일의 @ 앞>.json`) 본다.
7. (선택) 계정 a가 다 찼을 때 b로 비서 대화를 열 서버: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/server/server-control.ps1 -Action restart -Provider subscription-b`(서버 이름 '비서-b'). 바탕화면 바로가기로 두려면 대상에 `conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<비서 폴더>\bin\server-control.ps1" -Action restart -Provider subscription-b -Now -Notify`를 쓴다.

## AGENTS.md에 넣을 글

```
- **넘기기 단계:** 매 질문의 `<secretary-usage>`에 계정 a(비서 대화)·b의 5시간 사용률과 넘기는 정도가 붙는다. b는 다 써도 되고, a는 비서 대화가 한도에 막혀 멈추지 않게 여유를 남긴다. 기억·판단 일은 이 단계와 상관없이 비서 쪽에서 한다.
  - b가 a의 2배 미만이면(`b 우선`) 대화·기억과 명령 한 번으로 끝나는 확인만 직접 하고, 나머지는 run-job으로 b에 넘긴다(말하거나 추천하기 전의 확인은 빼고, 정확성 항목대로 직접 한다). 업무 세션도 같은 기준으로 같은 공간의 다음 업무가 이어 쓴다(`delegate` 스킬). 기준값은 `run-job-calls.jsonl` 실측(`scripts/run-job/run-job-stats.ps1`)을 보며 고친다.
  - b가 a의 2배 이상이면 a 기준 단계를 따른다. 1단계(a 20% 미만)는 위 기준대로, 2단계(20~40%)는 도구 2번 이상·웹 조회·파일 읽기도, 3·4단계(40% 이상)는 대화·기억 빼고 전부 넘기고, 4단계(60% 이상)는 답을 짧게 하고 새 세션을 권한다. 경계값은 `src/usage/handoff-level.ts`. 어느 단계든 말하거나 추천하기 전의 확인은 넘기지 않고 직접 한다(정확성 항목).
  - 세션 시작 줄이 `이 세션: 계정 b`면(계정 b로 띄운 서버, a가 차지 않아도 쓸 수 있다) 넘기는 일도 b로 돌리고 단계는 b 사용률로 본다.
  - 계정 b의 5시간·주간 사용량이 90% 이상이면(`scripts/usage/usage-query.ps1 -Provider subscription-b`, 토큰 0) 계정 a로 돌릴지 먼저 묻는다. 자동으로 a로 넘기지 않는다.
```

## 끄는 순서

`"enabled": false`, AGENTS.md에서 위 글을 빼고, `providers.json`의 `"default"`를 `"subscription"`으로 되돌린다(`subscription-b` 항목과 키 파일, 두 번째 계정 로그인은 그대로 둔다). 계정 b 서버를 띄웠다면 그 창을 닫는다.
