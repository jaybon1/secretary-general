# 구독 밖 공급자 (`providers`)

업무 세션과 run-job을 Claude 구독이 아닌 곳으로 돌린다: 다른 계정의 Claude API 키, AWS Bedrock의 Claude, Anthropic 호환 게이트웨이, 다른 회사 CLI(GitHub Copilot CLI, Google Antigravity CLI는 run-job에서만). 비서 대화는 언제나 구독으로 돈다. 쓰는 만큼 그 공급자 요금이 든다. 구독이 아닌 세션은 사용량 정지 장치(90%)에 걸리지 않으니, 쓰는 기간·한도는 키를 발급한 쪽(만료일, IAM)에서 건다.

## 켜는 순서

1. 어느 공급자를 쓸지 사용자와 정한다. 비용과, 내용이 그 회사 서버를 거친다는 점(개인정보)을 먼저 말한다.
2. `scripts/lib/providers.json`의 `providers`에 그 항목을 넣는다(아래 예). 비밀값은 넣지 않는다.
3. 사용자가 할 일: 키 폴더(`%USERPROFILE%\.secretary\keys`, `SECRETARY_KEYS_DIR`로 바꿀 수 있음)에 `<공급자 이름>.env`를 만들고 `KEY=VALUE` 줄로 키를 넣는다. 키 값은 대화에 붙이지 않는다.
4. `features.json`의 `providers`를 `"enabled": true`로, 아래 글을 AGENTS.md `### 공급자 (어느 요금으로 돌리나)` 절의 "업무 세션은 Remote Control 목록에" 줄 바로 앞에 넣는다.
5. 기본 공급자로 쓰려면 `"default"`를 그 이름으로(사용자 승인 뒤). 그러면 설치 점검의 `provider-key`가 키 파일이 있는지 본다. 기본으로 두지 않으면 일마다 `-Provider <이름>`을 준다.
6. 확인: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/run-job.ps1 -Provider <이름> -Model sonnet -New -Prompt "확인이라고만 답하라"`. 업무 세션도 한 번 돌려 본 뒤 보고한다.

항목 예(이름은 자유, `type`이 연결 방식, `usage`가 사용량 조회 방법: `"claude-usage"` 구독 /usage, `"agy"` Antigravity, `"none"` 조회 안 됨. 표시 이름을 바꾸려면 `"label"`):

```
"anthropic-key": { "type": "claude-api-key", "usage": "none", "note": "다른 계정의 Claude API 키. 키: <키 폴더>/anthropic-key.env (ANTHROPIC_API_KEY=...)" },
"bedrock": { "type": "claude-bedrock", "usage": "none", "region": "us-east-1", "effort": "high",
  "models": { "main": "<리전에서 쓸 수 있는 모델 id>", "opus": "<…>", "sonnet": "<…>", "haiku": "<…>" },
  "note": "AWS Bedrock의 Claude. 키: <키 폴더>/bedrock.env (AWS_BEARER_TOKEN_BEDROCK=...)" },
"gateway": { "type": "claude-gateway", "usage": "none", "base_url": "https://<게이트웨이 주소>/v1", "effort": "high",
  "note": "Anthropic 호환 게이트웨이. 키: <키 폴더>/gateway.env (ANTHROPIC_AUTH_TOKEN=...). 업무 세션·run-job 프로세스에만 넣고 이 PC의 구독 로그인은 그대로 둔다" },
"copilot": { "type": "copilot-cli", "usage": "none", "models": { "main": "<모델>", "opus": "<…>", "sonnet": "<…>", "haiku": "<…>" },
  "note": "GitHub Copilot CLI(npm @github/copilot, copilot login). Claude Code가 아니라 run-job에서만 쓴다" },
"antigravity": { "type": "antigravity-cli", "usage": "agy", "models": { "main": "<모델>" },
  "note": "Google Antigravity CLI(%LOCALAPPDATA%\\agy\\bin\\agy.exe, 사용자가 직접 로그인). run-job에서만, 샌드박스가 없으면 승인 없이 돈다(켜기 전에 사용자 승인)" }
```

- Bedrock·다른 회사 CLI의 `models`는 역할 정의의 `model: opus|sonnet|haiku`가 그 이름으로 풀리게 한다.
- 게이트웨이가 준 설치 스크립트(사용자 환경변수·`~/.claude/settings.json`을 바꾸는 것)는 쓰지 않는다.
- Codex·Gemini CLI는 연결이 없다(`scripts/lib/providers.ps1`에 연결하고 시험한 뒤에 쓴다).

## AGENTS.md에 넣을 글

```
- 구독이 아닌 공급자(특히 외부 게이트웨이)에게 넘기는 지시·TASK.md에는 그 업무에 필요한 것만 쓴다. 사용자 개인정보(프로필, 다른 업무·일정·사람·계정 이야기)는 넣지 않고, 꼭 필요해 보이면 먼저 묻는다.
- 다른 공급자가 키 만료·권한 거부로 실패하면 구독으로 바꾸기 전에 사용자에게 묻는다. `default`를 바꾸는 것도 사용자 승인 뒤에 하고, 바꾸면 그 공급자로 업무 세션을 한 번 돌려 확인한 뒤 보고한다.
- 업무 계획에는 공급자(`providers.json`의 `default` 또는 추천하는 다른 공급자)를 적는다. 공급자에 따라 쓸 수 있는 모델이 다르다(그 공급자의 `models`). 다른 회사 모델을 쓸 때는 Claude 기준(Sonnet high / Opus medium / Opus high)과 맞먹는 수준의 모델과 생각 깊이를 근거 한 줄과 함께 추천한다.
```

## 끄는 순서

`"default"`가 구독 밖 공급자면 `"subscription"`으로 되돌리고(사용자 승인), `"enabled": false`, AGENTS.md에서 위 글을 뺀다. `providers.json`의 항목과 키 파일은 사용자에게 지울지 묻는다.
