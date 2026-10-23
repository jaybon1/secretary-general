# secretary — 장기 기억 개인 비서 (범용 배포판 v1)

Claude Code를 비서 본체로 쓰고, 기억은 이 폴더의 SQLite 파일 하나(`secretary.db`)에 둔다. Claude 구독 하나만 있으면 된다.
원칙: **저장은 무제한, 읽기는 예산제.** 기억이 몇 년 치 쌓여도 한 턴에 컨텍스트로 들어가는 양은 고정된다.

## 설치 (처음 쓰는 사람)

컴퓨터를 잘 몰라도 아래 순서대로 하면 된다. 처음 켜면 아무 기억도 없는 빈 비서로 시작하고, 비서가 먼저 이름과 부를 호칭, 원하는 말투 등을 물어본다.

1. **Node 설치:** [nodejs.org](https://nodejs.org)에서 24 이상 버전(LTS)을 받아 설치한다. Windows라면 [Git for Windows](https://git-scm.com)도 설치한다(비서의 자동 기억 기능이 이것으로 돈다).
2. **Claude Code 설치:** [Claude Code 안내](https://claude.com/claude-code)대로 설치한다(데스크톱 앱 또는 터미널 버전).
3. **이 폴더 준비:** 받은 zip을 원하는 곳에 풀고, 그 폴더에서 터미널(PowerShell)을 연다. 탐색기에서 폴더를 연 뒤 주소창에 `powershell`이라고 치고 Enter를 누르면 된다.
4. **필요한 부품 받기:** 터미널에 `npm install`을 입력한다. 몇 분 걸릴 수 있다.
5. **로그인:** 터미널에 `claude auth login`을 입력하고, 열리는 브라우저에서 Claude 계정(구독)으로 로그인한다.
6. **비서 켜기:** 같은 폴더에서 `claude`를 입력한다(데스크톱 앱이면 이 폴더를 연다). `secretary` 서버를 쓸지 물으면 허용한다. 이제 대화하면 된다.

문제가 생기면:
- 의미 검색이 켜지지 않는다는 말이 나오면(`onnxruntime_binding.node` 로드 실패) [Visual C++ 재배포 패키지](https://aka.ms/vs/17/release/vc_redist.x64.exe)를 설치한다. 그동안에도 단어 검색으로는 잘 동작한다.
- 비서 폴더는 그대로 두고, 비서가 일을 맡기면 작업 공간 폴더가 이 폴더 **옆**(한 단계 위 폴더 안)에 생긴다.

선택 기능 (안 써도 된다):
- **다른 기기에서 쓰기 (Remote Control):** 아래 "다른 기기에서 쓰기" 참고. 컴퓨터를 켤 때 자동으로 켜지게 하려면 `scripts/install-autostart.ps1`.
- **사용량 일시 정지:** `node scripts/install-usage-guard.mjs` (구독 5시간 사용량이 90%를 넘으면 하던 단계만 마무리하고 멈춘다. 다시 실행해도 안전).
- **브라우저 작업:** 기본은 Ego Lite. Ego Lite가 안 될 때를 위해 크롬에 Claude in Chrome 확장을 설치하고, 비서에게 쓸 크롬 프로필 이름을 알려 주면 기억해 두고 `open-chrome.ps1`로 연다.

핵심(기억 서버·훅·정리·위임·사용량 장치)은 Node와 bash라 모든 OS에서 동작하고, `scripts/`의 PowerShell 파일(원격 서버·자동 시작·백그라운드 업무 세션·크롬 열기)만 Windows 전용이다. 맥·리눅스에서는 Claude Code에게 해당 스크립트를 그 OS용으로 바꿔 달라고 하면 된다.

## 사용

이 폴더에서 Claude Code 세션을 새로 열면 된다.

- 평소엔 그냥 대화. 비서가 기억할 만한 걸 알아서 `remember` 한다.
- `/consolidate` — 쌓인 대화 원문을 기억·프로필로 정리. Haiku 서브에이전트에서 돌아 메인 모델 사용량을 아낀다.
- `/grill` — 계획의 빈틈을 질문으로 파고든다.
- **업무 위임** — 파일이 생기는 일은 크기와 상관없이 맡긴다. 간단한 일은 공용 폴더 `quick-outputs`, 그 밖은 맞는 기존 작업 공간을 추천하거나 새로 만든다. 공간은 비서 폴더 옆에 생기고, 업무마다 결과가 `output/<날짜>-<업무이름>/`(지시서 `TASK.md`, 보고서 `REPORT.md`)에 쌓인다. 계획을 확인받은 뒤 그 공간 폴더에서 새 세션이 일한다. 절차는 `.claude/skills/delegate/SKILL.md`에 있어서 일을 맡길 때만 읽힌다(AGENTS.md는 매 세션 읽히므로 짧게 유지).

모든 세션(비서, 업무 세션, `run-job`)은 이 PC에 로그인된 Claude 구독 하나로 돈다(`scripts/providers.json`의 `subscription`). 비서 대화는 Opus medium(`.claude/settings.json`의 `effortLevel`), 작업 공간은 Sonnet high / Opus medium / 추론이 깊은 일은 Opus high를 기준으로 쓴다.

### 다른 기기에서 쓰기 (Remote Control, 선택)

비서는 이 폴더가 있는 컴퓨터에서만 실행하고, 다른 PC나 폰에서는 Remote Control로 접속한다.

- **열려 있는 세션 이어 쓰기:** 데스크톱 앱 설정 > Claude Code > "Connect new sessions to Remote Control"을 켜면 새 세션이 claude.ai/code와 Claude 앱에 나타난다.
- **원격에서 새 비서 세션 열기:** `scripts/remote-server.ps1`이 이 폴더에서 `claude remote-control`(서버 모드)을 띄우고, 끝나면 다시 띄운다. `scripts/install-autostart.ps1`은 Windows에 로그인할 때 이 스크립트가 자동 실행되도록 작업 스케줄러에 등록한다. 처음 한 번은 이 컴퓨터에서 `claude auth login`으로 로그인하고, 서버 창에 뜨는 `Enable Remote Control? (y/n)`에 `y`로 답해야 한다.
- **원격 지시로 업무 맡기기:** 원격으로 받은 지시에는 앱이 `start_session`을 허용하지 않으므로, 비서는 `scripts/start-worker.ps1`로 업무 세션을 백그라운드(`claude --bg`)에서 시작하고 `SendMessage`의 `notify_when_idle`로 진행을 받는다. 업무 세션은 Remote Control에 붙이지 않아 다른 기기의 세션 목록에 나타나지 않는다.

## 구조

```
                 ┌─ SessionStart 훅 ─→ 핵심 프로필 주입 (상한 ~2,000 토큰, 매 세션 동일 → 캐시 효율)
Claude Code ─────┼─ UserPromptSubmit 훅 ─→ 관련 기억 자동 검색·주입 (상한 ~2,500 토큰, 세션 안에서 같은 기억은 한 번만)
(비서 본체)      ├─ Stop 훅 ─→ 대화 원문을 raw_log에 저장 (LLM 토큰 0)
                 └─ MCP 도구 ─→ remember / recall / forget / update_profile / search_log / …
                                        │
                              secretary.db (단일 파일)
                              ├ profile      핵심 프로필 (버전 관리)
                              ├ memories     기억 (무효화는 valid_to, 덮어쓰지 않음)
                              ├ raw_log      대화 원문 아카이브
                              └ usage_log    주입 토큰 기록
```

검색 파이프라인: `FTS5 후보 (무료)` → `재정렬` → `의미 검색 결과와 합치기` → `토큰 예산 패킹`.
재정렬은 `src/recall.ts`의 `Reranker` 인터페이스 뒤에 있어서, 나중에 임베딩이나 확률 판단 모델로 교체할 수 있다.
한국어는 2글자 단위(bigram)로 색인해서 "서울에서/서울로"처럼 조사가 달라도 찾는다.

**의미 검색:** 단어가 달라도 뜻이 같은 기억을 찾는다("치과 예약" ↔ "이 치료 받으러 가"). 임베딩 모델 bge-m3(약 560MB, 이 PC 안에서만 동작)는 불러오는 데 몇 초 걸려서, 작은 도우미 프로세스(`src/semantic.ts`)가 모델을 띄워 두고 훅과 MCP 서버가 localhost로 묻는다. 첫 질문이 도우미를 백그라운드로 켜고(그 질문은 단어 검색만), 이후 질문부터 의미 검색이 합쳐진다. 도우미는 새로 저장된 기억의 벡터를 알아서 만든다(켜져 있는 동안 메모리 약 1GB). 비서 서버(`remote-server.ps1`)가 떠 있으면 도우미도 서버 창에 묶여 계속 떠 있다가 창이 꺼지면 같이 꺼지고, 서버 없이 쓸 때는 60분 동안 요청이 없으면 스스로 꺼진다. 모델은 처음 켤 때 `models/`에 자동으로 받는다. 도우미가 준비되지 않았거나 느리면 언제나 단어 검색만으로 동작한다.

### scripts/ (Windows PowerShell)

| 파일 | 하는 일 |
|---|---|
| `remote-server.ps1` | 비서 폴더에서 Remote Control 서버를 띄우고, 끝나면 다시 띄움. 서버가 연 세션은 이 PC의 크롬(Claude in Chrome)을 쓴다(`CLAUDE_CODE_ENABLE_CFC=1`). 시작 전에 `bridge-pointer.json`을 지워 보관된 옛 세션을 다시 붙잡지 않게 한다 |
| `install-autostart.ps1` | 로그인할 때 `remote-server.ps1`이 자동 실행되도록 작업 스케줄러에 등록 |
| `start-worker.ps1` | 업무 세션을 백그라운드(`claude --bg`)로 시작. 브라우저가 필요한 업무는 `-Chrome` |
| `watch-worker.ps1` | 백그라운드 업무 세션이 승인 창에 멈췄는지 토큰 없이 지켜보기 |
| `run-job.ps1` | 비싼 작업을 빈 세션(`claude -p`)에서 한 번 돌리고 결과 글만 받기. 모델(`-Model`)은 필수. 사용자 설정의 MCP는 붙이지 않고, 필요한 MCP만 `-McpConfig <파일>`로 붙인다 |
| `worker-logs.ps1` | 백그라운드 업무 세션의 출력 보기 |
| `providers.ps1` | `providers.json`(Claude 구독 설정)을 읽는 공용 함수 |
| `open-chrome.ps1` | 브라우저 작업용 크롬 프로필 창을 이름으로 찾아 열기 (Claude in Chrome이 연결돼 있지 않을 때) |
| `claude-env.ps1` | 위 스크립트들이 쓰는 공용 함수 (앱 환경변수 정리, 로그인 확인) |
| `usage.ps1` | 구독 사용량을 토큰 없이 조회(`claude -p "/usage"`, 5시간·주간)해 `~/.claude/usage/subscription.json`에 저장. 정지 훅이 기록이 5분 넘게 오래되면 뒤에서 띄운다 |
| `install-usage-guard.mjs` | 사용량 일시 정지 장치를 사용자 설정(`~/.claude/settings.json`)에 등록. 5시간 사용량이 90%(`USAGE_PAUSE_PCT`)를 넘으면 비서와 업무 세션이 하던 단계만 마무리하고 멈춘다. 끄기: `~/.claude/usage-guard-off` 파일 생성 |

### 개발

```bash
npm test                    # 테스트
npm run typecheck           # 타입 검사
node src/cli.ts stats       # 현황
node src/cli.ts backup      # backups/ 에 스냅샷 (VACUUM INTO)
```

## 설정 (환경변수)

| 변수 | 기본 | 의미 |
|---|---|---|
| `SECRETARY_DB` | `./secretary.db` | DB 파일 경로 |
| `SECRETARY_WORKSPACE_ROOT` | 비서 폴더의 상위 폴더 | 위임 업무 폴더를 만들 위치 |
| `SECRETARY_PROFILE_MAX_TOKENS` | 2000 | 프로필 상한 |
| `SECRETARY_AUTO_RECALL_TOKENS` | 2500 | 매 턴 자동 주입 상한 |
| `SECRETARY_RECALL_TOKENS` | 4000 | `recall` 도구 기본 예산 |
| `SECRETARY_TZ` | `Asia/Seoul` | 시각을 보여 줄 시간대 (저장은 항상 UTC) |
| `SECRETARY_EMBED` | (켜짐) | `off`면 의미 검색을 끄고 단어 검색만 쓴다 |
| `SECRETARY_EMBED_IDLE_MIN` | 60 | 비서 서버 없이 켜진 의미 검색 도우미가 요청 없이 기다리다 꺼지는 시간(분) |

## 개인 데이터

`secretary.db`(기억·대화 원문)와 `backups/`는 이 PC에만 둔다. 이 폴더를 남에게 줄 때는 이 두 가지를 빼고 준다(`.gitignore`에 들어 있다).

## 다음 단계 후보

- 기억이 수만 개로 늘어 의미 검색이 느려지면 sqlite-vec로 벡터 검색 옮기기
- 확률 판단 재정렬기 (`Reranker` 구현 하나 추가)
