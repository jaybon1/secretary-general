# 대시보드 (`dashboard`)

비서 서버가 켜질 때 `node bin/dashboard.mjs serve`가 같이 떠서, 브라우저로 여는 읽기 전용 화면을 낸다.

- 첫 화면: 한도(5시간·주간), 돌고 있는 업무 세션·run-job, 업무 칸반, 예약 작업, 최근 run-job. 30초마다 새로 고친다.
- 한도: 설정 화면(`/settings`)에서 체크한 공급자만 보이고, 조회할 수 있는 공급자(`scripts/lib/providers.json`의 `usage` 칸)는 사용량 조회기(기능 `usage-poll`)가 5분마다 하나씩 조회한다(토큰 0). 고른 것은 `this-secretary.local.json`의 `usage-poll` 칸(이 PC 설정, 커밋 안 함)에 저장되고, 없으면 조회할 수 있고 이 PC에 설정된 공급자가 기본으로 체크된다. 대시보드가 쓰는 곳은 이 설정 하나뿐이다.
- 결과물 보기 `/share/<이름>/`: 기본 이름은 `ai-agent`(비서 상위 폴더), `inbox`, `notes`. 폴더는 목록(이름·크기·고친 시각(폴더는 폴더 자체의 시각, 곧 바로 안에 항목을 더하거나 지우거나 이름을 바꾼 때), 위의 "이름"·"날짜" 버튼으로 정렬하고 같은 버튼을 다시 누르면 방향이 바뀐다. 고른 정렬은 그 브라우저에 기억돼 모든 폴더에 같이 쓰인다), 글 파일(`.md`·`.txt`·`.json`·`.csv`·`.log`·`.srt` 등)은 브라우저에서 바로 읽히고 "앱으로 열기"로 같은 파일을 받아 폰의 앱(마크다운 앱 등)으로 연다. 영상·소리는 넘겨 보기가 되고, 이미지는 그대로 보인다.
- 숨김(목록에도 안 보이고 주소로도 열리지 않음): 비서 폴더에서 git이 무시하는 것(기억 DB, 이 PC 설정 등)과 `backups/`, 모든 곳의 `.git`·`.env`·`*.env`, 키 폴더와 키 이름 규칙의 파일. 결과물은 읽기 전용이라 고치거나 지우지 못한다.
- 로그인이 없다. 기본은 이 PC 안(`http://127.0.0.1:8790/`)에서만 열리고, 다른 기기에서는 Tailscale 같은 사설망으로만 연다(인터넷에 바로 열지 않는다).
- "상태"(`server-ops` 스킬의 `bin/dashboard.mjs status --text`)는 이 기능이 꺼져 있어도 돈다.

## 켜기 전에 사용자와 정할 것

1. 다른 기기(폰)에서도 볼지. 보려면 이 PC와 폰에 Tailscale이 깔려 같은 tailnet에 있어야 하고, HTTPS 주소는 Tailscale Serve가 낸다(관리 화면에서 HTTPS 인증서를 켜야 한다).
2. 결과물 보기 이름과 폴더(기본 셋을 그대로 둘지, 빼거나 더할지)와 포트(기본 8790).

## 켜는 순서

1. 기본값을 바꾸면 이 비서 설정 파일 `this-secretary.local.json`(비서 폴더 맨 위, 커밋하지 않음, 예시 `this-secretary.local.example.json`)의 `dashboard` 칸에 쓴다(칸 안의 값은 `src/dashboard/settings.ts` 첫 주석). 예: `"dashboard": { "port": 8790, "publicUrl": "https://<기기 이름>.<tailnet 이름>.ts.net", "share": { "inbox": null } }`. Tailscale 주소로 바로(http) 열려면 `"hosts": ["<이 PC의 Tailscale IP>"]`.
2. `features.json`의 `dashboard`를 `"enabled": true`로, 아래 글을 AGENTS.md `### 경로` 절의 "파일·폴더 경로는 복사하기 쉽게" 줄 바로 아래에 넣는다(폰에서 안 볼 거면 넣지 않는다).
3. 비서 서버를 다시 켠다(`server-ops` 스킬, 서버 안 세션이 끊기니 먼저 묻는다). 켜진 뒤 `node bin/dashboard.mjs urls`의 주소를 이 PC 브라우저로 열어 확인한다.
4. 폰에서 볼 때(정한 경우): 실행할 명령을 보여 주고 사용자 승인 뒤 `tailscale serve --bg http://127.0.0.1:<포트>`(이 PC 설정이 바뀐다). `tailscale serve status`에 나온 `https://…ts.net` 주소를 1번 `publicUrl`에 적고, 폰에서 열어 첫 화면과 `/share/ai-agent/`가 보이는지 사용자에게 봐 달라고 한다.

## AGENTS.md에 넣을 글

```
- 대시보드 결과물 보기를 켜 두었으므로, 위처럼 경로를 붙일 때 그 파일이 결과물 보기 폴더(기본: 비서 상위 폴더) 안이면 경로 코드 블록(다른 PC 경로도 붙이면 경로마다 따로 둔 코드 블록들) 바로 아래(블록 밖)에 폰으로 여는 주소를 누르면 열리는 링크 한 줄(`[https://<대시보드 publicUrl>/share/ai-agent/<상위 폴더 기준 경로>](같은 주소)`, 링크 이름도 주소 그대로, 경로는 `/`로 잇고 공백은 `%20`, 주소 속 괄호는 `%28`·`%29`)을 붙인다(이 주소는 폰·PC 어디서나 열린다). 폰 주소를 코드 줄로 따로 쓰지 않는다(링크 줄과 겹친다).
```
(`<대시보드 publicUrl>`은 1번에 적은 주소로 바꿔 넣는다.)

## 끄는 순서

1. `"enabled": false`, AGENTS.md에서 위 글을 뺀다. 비서 서버를 다시 켜면(묻고 나서) 대시보드가 뜨지 않는다. 지금 떠 있는 것만 끄려면 `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dashboard\.mjs serve' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`.
2. Tailscale Serve를 켰으면 사용자 승인 뒤 `tailscale serve --https=443 off`(그 PC에 다른 Serve 설정이 없을 때만 `tailscale serve reset`).
3. `this-secretary.local.json`의 `dashboard` 칸은 지우지 않는다(기능이 꺼져 있으면 읽지 않는다). 지우려면 따로 묻는다.
