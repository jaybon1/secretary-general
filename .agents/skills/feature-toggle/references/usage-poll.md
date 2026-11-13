# 사용량 뒤에서 조회 (`usage-poll`, 처음부터 켜짐)

비서 서버(`scripts/remote-server/remote-server.ps1`)가 켜질 때 `node src/cli.ts usage-poll`이 창 없이 같이 떠서, 고른 공급자의 사용량을 5분마다 하나씩 조회한다(`scripts/usage/usage-query.ps1`, 모델을 부르지 않아 토큰 0). 결과는 `%USERPROFILE%\.secretary\usage\subscription-<계정>.json`(계정은 그 공급자 로그인의 메일 @ 앞. 로그인 계정을 못 읽거나 계정이 없는 공급자(API 키, 다른 회사 CLI)는 `<공급자>.json`)에 쌓이고, 사용량 정지 장치(5시간·주간 90%)와 상태줄이 이 값을 본다. 비서 서버 창이 꺼지면 따라 꺼지고, 이 PC에서 이미 돌고 있으면(다른 비서 폴더의 것 포함) 새로 뜨지 않는다.

- 고를 공급자: 이 비서 설정 파일 `this-secretary.local.json`(비서 폴더 맨 위, 커밋하지 않음, 예시 `this-secretary.local.example.json`)의 `usage-poll` 칸 `"usage-poll": { "providers": ["subscription"] }`. 없으면 조회할 수 있고(`scripts/lib/providers.json`의 `usage` 칸이 `claude-usage`·`agy`) 이 PC에 설정된 공급자가 모두 조회된다. 처음엔 구독 하나뿐이라 따로 만들 필요가 없다. 대시보드(`dashboard`)를 켰으면 그 `/settings` 화면이 이 칸을 쓴다.
- 조회가 실패하면(API 키 로그인처럼 `/usage`가 사용량을 주지 않을 때) 같은 이름의 `.fail`에 잇따른 실패 횟수를 적고, 다음 조회를 5분부터 두 배씩 최대 6시간 미룬다. 대시보드 한도 칸에는 "조회 실패 N번(이유, 다음 시도 시각)"으로 보인다.
- 꺼 두면 사용량 정지 훅이 기록이 5분 넘게 오래됐을 때만 그 자리에서 갱신한다(대화를 쉬는 동안은 값이 옛것으로 남는다).

## 켜는 순서

1. `features.json`의 `usage-poll`을 `"enabled": true`로.
2. 비서 서버를 다시 켠다(`server-ops` 스킬, 서버 안 세션이 끊기니 먼저 묻는다). 다시 켜기 전에 바로 띄우려면 비서 폴더에서 `Start-Process node -ArgumentList '--no-warnings','src/cli.ts','usage-poll' -WindowStyle Hidden`(비서 서버와 묶이지 않아 PC를 끌 때까지 돈다).
3. 약 15초 뒤 `%USERPROFILE%\.secretary\usage\subscription-<계정>.json`(로그인 계정을 못 읽으면 `subscription.json`)의 `updated_at`이 새로 바뀌었는지 본다.
4. 공급자를 고르라고 하면 `this-secretary.local.json`의 `usage-poll` 키를 위 형식으로 쓴다(다른 키는 그대로 둔다)(이름은 `providers.json`에 있는 것만). 다음 조회부터 바로 따른다.

## AGENTS.md에 넣을 글

없음(규칙 없이 뒤에서 돈다).

## 끄는 순서

1. `"enabled": false`.
2. 지금 떠 있는 것을 끈다: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'cli\.ts.+usage-poll' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`(묻고 나서). 비서 서버를 다시 켜도 뜨지 않는다.
3. `this-secretary.local.json`의 `usage-poll` 칸은 지우지 않는다. 지우려면 따로 묻는다.
