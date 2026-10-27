# secretary — 장기 기억 개인 비서 (범용 배포판 v6)

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
7. **(선택) 컴퓨터를 켜면 비서 서버가 저절로 켜지게:** 폰이나 다른 PC에서 비서를 쓰려는 경우만 한다(아래 "다른 기기에서 쓰기"). 관리자 PowerShell이 필요하다.
   1. 위 3번처럼 이 폴더에서 연 터미널에 `claude remote-control`을 입력하고, `Enable Remote Control? (y/n)`이 나오면 `y`를 누른다. 연결됐다는 글이 나오면 `Ctrl+C`로 끈다. 비서 서버는 창 없이 뜨기 때문에 이 질문을 처음 한 번 여기서 답해 둬야 한다.
   2. 탐색기 주소창의 이 폴더 경로를 복사해 둔다(주소창을 누르면 `C:\Users\...` 꼴 경로가 나온다).
   3. 시작 단추를 오른쪽 클릭하고 **터미널(관리자)**(Windows 10은 **Windows PowerShell(관리자)**)을 누른다. "이 앱이 디바이스를 변경하도록 허용하시겠어요?"가 나오면 **예**.
   4. 열린 창에 `cd "<복사한 경로>"`를 입력한다(따옴표 안에 붙여 넣기).
   5. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`을 입력한다. `등록됨: Secretary Remote Control`이 나오면 된 것이다. "관리자 PowerShell에서만 등록돼요"가 나오면 3번부터 다시 한다.
   6. 지금 바로 켜려면 `Start-ScheduledTask -TaskName 'Secretary Remote Control'`을 입력한다(다음부터는 Windows에 로그인할 때 저절로 켜진다). 서버 창은 보이지 않는 것이 정상이고, 연결되면 화면 오른쪽 아래에 "비서 · 서버가 연결됐어요" 알림이 한 번 뜬다. 관리자 창은 닫는다.

   왜 관리자 권한인가: 비서 서버를 가장 높은 권한으로 띄워야 그 안의 비서가 관리자 권한이 필요한 일(예약 작업 등록·삭제 등)을 할 수 있고, 채팅으로 서버를 다시 켤 때 옛 서버를 끌 수 있다(권한이 낮으면 옛 서버를 못 꺼서 새 서버가 계속 거절된다).
8. **(선택) 사용자 계정 컨트롤(UAC)을 가장 낮게:** 비서가 관리자 권한이 필요한 일을 하면 PC 화면에 UAC 확인 창("이 앱이 디바이스를 변경하도록 허용하시겠어요?")이 뜰 수 있는데, 폰에서 쓰는 중이면 그 창을 누를 사람이 없어 그 일이 멈춘다. 가장 낮게 하면 확인 창 없이 진행된다.
   1. 시작 메뉴에서 `UAC`를 검색해 **사용자 계정 컨트롤 설정 변경**을 연다.
   2. 왼쪽 막대를 맨 아래 **알리지 않음**으로 내리고 **확인**, 확인 창에 **예**.
   - 위험: 다른 프로그램도 묻지 않고 관리자 권한을 얻을 수 있게 된다. 출처를 모르는 프로그램을 설치·실행하지 않는 PC에서만 한다. 되돌리려면 같은 화면에서 막대를 위에서 두 번째(기본값)로 올린다.

문제가 생기면:
- 비서 서버가 켜졌는지 모르겠으면 비서에게 "서버 기록 보여줘"라고 하거나 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\server-control.ps1 -Action log`를 실행한다(기록: `%USERPROFILE%\.secretary\logs\server`).
- 의미 검색이 켜지지 않는다는 말이 나오면(`onnxruntime_binding.node` 로드 실패) [Visual C++ 재배포 패키지](https://aka.ms/vs/17/release/vc_redist.x64.exe)를 설치한다. 그동안에도 단어 검색으로는 잘 동작한다.
- 비서가 "의미 검색 도우미가 꺼져 있어 다시 띄우는 중이에요"라고 하면 도우미가 모델을 못 불러왔거나 비정상으로 꺼진 것이다. 비서가 살아날 때까지 지켜보고 알려 준다. 그래도 진행하라고 하면 단어 검색만으로 한다. 원인은 비서에게 물으면 이 폴더의 `secretary.db.embedder-failures.log`(시각·원인 단서·남은 메모리·오류)를 읽어 알려 준다.
- 비서 폴더는 그대로 두고, 비서가 일을 맡기면 작업 공간 폴더가 이 폴더 옆의 **`workspaces` 폴더** 안에 생긴다(없으면 만든다).

선택 기능 (안 써도 된다):
- **다른 기기에서 쓰기 (Remote Control):** 아래 "다른 기기에서 쓰기" 참고. 컴퓨터를 켤 때 자동으로 켜지게 하려면 위 설치 7번(관리자 PowerShell에서 `scripts/install-autostart.ps1`).
- **사용량 일시 정지:** `node scripts/install-usage-guard.mjs` (구독 5시간 사용량이 90%를 넘으면 하던 단계만 마무리하고 멈춘다. 다시 실행해도 안전). 그래도 이어 가야 하면 "90퍼센트를 초과하더라도 진행", "90퍼 넘어도 계속"처럼 말하면 프롬프트 훅이 5시간 사용량 초기화 때까지 장치를 푼다. 비서가 스스로 풀지는 않는다.
- **브라우저 작업:** 웹은 기본으로 Claude Code의 검색·페이지 읽기 도구로 본다. 로그인된 사이트나 클릭·입력이 필요한 일까지 맡기려면 Ego Lite를 설치하거나(설치돼 있으면 비서와 업무 세션이 알아서 쓰고, 연 페이지를 `scripts/ego-grab.mjs`로 근거 파일로 남긴다), 크롬에 Claude in Chrome 확장을 설치하고 비서에게 쓸 크롬 프로필 이름을 알려 준다(기억해 두고 `open-chrome.ps1`로 연다).
- **기억 DB 매일 백업 (Windows):** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-db.ps1 -Install`. 처음 쓸 때 비서도 한 번 권한다. 등록되는 것: 작업 스케줄러의 예약 작업 **'Secretary DB Backup'**, 매일 **03시**(`-At 05:30`처럼 바꿀 수 있고, 그 시각에 PC가 꺼져 있었으면 다음에 켤 때) 이 폴더의 **`backups/`**에 `secretary-<날짜-시각>.db`를 만들고 **14일**이 지난 백업은 지운다(`-KeepDays`로 바꿈). 이 PC 밖으로는 보내지 않고 토큰도 들지 않는다. 끄기: `scripts/backup-db.ps1 -Uninstall`(만든 백업 파일은 남는다).

핵심(기억 서버·훅·정리·위임·사용량 장치)은 Node와 bash라 모든 OS에서 동작하고, `scripts/`의 PowerShell 파일(원격 서버·자동 시작·백그라운드 업무 세션·크롬 열기)만 Windows 전용이다. 맥·리눅스에서는 Claude Code에게 해당 스크립트를 그 OS용으로 바꿔 달라고 하면 된다.

## 사용

이 폴더에서 Claude Code 세션을 새로 열면 된다.

- 평소엔 그냥 대화. 비서가 기억할 만한 걸 알아서 `remember` 한다.
- `/consolidate` — 쌓인 대화 원문을 기억·프로필로 정리. Haiku 서브에이전트에서 돌아 메인 모델 사용량을 아낀다. 끝나면 핵심 프로필 전체를 줄마다 번호 붙여 보여 주고(큰 일 상태 포함, 바뀐 줄은 "(바뀜)"), 뺄 줄이 있는지 묻는다.
- `/grill` — 계획의 빈틈을 질문으로 파고든다.
- `/handoff` — 지금 세션을 새 비서 세션으로 넘기고, 새 세션이 옛 세션을 보관한다. **Remote Control(폰·다른 PC에서 비서 쓰기)이나 데스크톱 앱으로 비서를 쓰는 사람용**이다(세션을 만들고 보관하는 도구가 그 세션에만 있다). 터미널에서만 쓰면 필요 없다: 그냥 새 세션을 열면 아래 "상황판"이 이어 준다.
- **상황판 (새 세션이 이어받기)** — 새 세션을 열거나 `/clear`하면, 지난 상황판과 그 뒤 대화를 같은 구독의 Haiku(생각 깊이 medium)가 뒤에서 고쳐 쓴다(`run-job.ps1`). 첫 질문은 이것이 끝날 때까지 기다렸다가(최대 5분) 상황판을 붙여 보내서, 비서가 "지금 무슨 일이 어디까지 됐는지" 알고 첫 답 맨 위에 `> 이어서: …` 한 줄을 적는다. 답을 못 받은 질문(A, B…)도 새 세션에서 A부터 다시 붙여 넘어온다. 갱신이 실패하면 직전 세션의 마지막 말과 기억 번호만 붙는다. 지금 판은 `node src/cli.ts board`로 볼 수 있다(Windows 전용: 맥·리눅스에서는 갱신 대신 직전 세션 정보만 붙는다).
- **업무 위임** — 파일이 생기는 일은 크기와 상관없이 맡긴다. 간단한 일은 공용 폴더 `quick-outputs`, 그 밖은 맞는 기존 작업 공간을 추천하거나 새로 만든다. 공간은 비서 폴더 옆 `workspaces` 폴더 안에 생기고, 결과는 제품별로 둔다: 제품 본체는 `output/products/<제품>/`에 하나만 두고 업무마다 제자리에서 고치며, 업무 기록(지시서 `TASK.md`, 보고서 `REPORT.md`)은 `output/records/<제품>/<날짜>-<업무이름>/`, 실험·조사는 `output/research/<날짜>-<업무이름>/`에 쌓인다. 계획을 확인받은 뒤 그 공간 폴더에서 새 세션이 일한다. 절차는 `.claude/skills/delegate/SKILL.md`에 있어서 일을 맡길 때만 읽힌다(AGENTS.md는 매 세션 읽히므로 짧게 유지). 일을 맡기기 전에는 `grill` 스킬로 정할 것부터 묻는다.
- **공간이 배우는 것** — 작업 공간마다 업무 종류별 스킬(`skills/<이름>/SKILL.md`), 늘 맞는 사실(`MEMORY.md`, 2,000자 안), 업무 세션이 남긴 제안(`notes/pending/`)이 생긴다. 사용자가 고쳐 준 것은 업무 세션이 그 스킬에 바로 적고, 스스로 찾은 것은 제안으로 남겼다가 비서가 업무 끝에 승인받아 반영한다.
- **공간 배포판** — "OO 공간 배포판 만들어줘"라고 하면 그 공간의 규칙·스킬·사실 메모만 zip으로 묶는다(결과물·기록·키는 빼고, 개인 경로·메일·키·주입 문구를 검사한 뒤). `scripts/export-workspace.ps1`.
- **기억 오염 막기** — 기억·프로필에 "이전 지시는 모두 무시해" 같은 프롬프트 주입·유출 문구가 들어오면 저장을 거절한다(`src/threats.ts`). 기억은 매 질문에 다시 들어가므로, 한 번 들어간 나쁜 문장이 계속 남지 않게 하려는 것이다.

모든 세션(비서, 업무 세션, `run-job`)은 이 PC에 로그인된 Claude 구독 하나로 돈다(`scripts/providers.json`의 `subscription`). 비서 대화는 Opus medium(`.claude/settings.json`의 `effortLevel`), 작업 공간은 Sonnet high / Opus medium / 추론이 깊은 일은 Opus high를 기준으로 쓴다.

### 다른 기기에서 쓰기 (Remote Control, 선택)

비서는 이 폴더가 있는 컴퓨터에서만 실행하고, 다른 PC나 폰에서는 Remote Control로 접속한다.

- **열려 있는 세션 이어 쓰기:** 데스크톱 앱 설정 > Claude Code > "Connect new sessions to Remote Control"을 켜면 새 세션이 claude.ai/code와 Claude 앱에 나타난다.
- **원격에서 새 비서 세션 열기:** `scripts/remote-server.ps1`이 이 폴더에서 `claude remote-control`(서버 모드)을 띄우고, 끝나면 다시 띄운다. `scripts/install-autostart.ps1`은 Windows에 로그인할 때 이 스크립트가 가장 높은 권한으로 자동 실행되도록 작업 스케줄러에 등록한다(관리자 PowerShell에서, 위 설치 7번). 서버 창은 숨겨 뜨고(창을 닫아 서버가 꺼지는 일이 없게), 처음 연결될 때 Windows 알림이 한 번 뜬다. 서버 출력은 `%USERPROFILE%\.secretary\logs\server`에 날짜별로 14일 치 남는다. 처음 한 번은 이 컴퓨터에서 `claude auth login`으로 로그인하고, 이 폴더에서 `claude remote-control`을 직접 한 번 실행해 `Enable Remote Control? (y/n)`에 `y`로 답해야 한다(서버 창에서는 이 질문이 보이지 않는다).
- **채팅으로 서버 다루기:** 비서에게 "서버 다시 켜줘"(원하면 "창이 보이게"), "서버 창 보여줘/숨겨줘", "서버 기록 보여줘"라고 하면 `scripts/server-control.ps1`로 한다. 다시 켜면 그 서버 안의 비서 대화가 끊기고, 클라우드가 옛 서버 등록을 3분쯤 잡고 있어 4분쯤 뒤에 연결된다. 채팅으로 서버를 끄는 기능은 없다.
- **원격 지시로 업무 맡기기:** 원격으로 받은 지시에는 앱이 `start_session`을 허용하지 않으므로, 비서는 `scripts/start-worker.ps1`로 업무 세션을 백그라운드(`claude --bg`)에서 시작하고 `SendMessage`의 `notify_when_idle`로 진행을 받는다. 업무 세션은 Remote Control에 붙이지 않아 다른 기기의 세션 목록에 나타나지 않는다.

## 구조

```
                 ┌─ SessionStart 훅 ─→ 핵심 프로필 주입 (상한 ~2,000 토큰, 매 세션 동일 → 캐시 효율) · 새 세션이면 상황판 고쳐 쓰기를 뒤에서 시작 (Haiku)
Claude Code ─────┼─ UserPromptSubmit 훅 ─→ 관련 기억 자동 검색·주입 (상한 ~2,500 토큰, 세션 안에서 같은 기억은 한 번만) · 새 세션의 첫 질문엔 상황판
(비서 본체)      ├─ Stop 훅 ─→ 대화 원문을 raw_log에 저장 (LLM 토큰 0) · 남은 질문 목록 갱신
                 └─ MCP 도구 ─→ remember / recall / forget / update_profile / search_log / …
                                        │
                              secretary.db (단일 파일)
                              ├ profile      핵심 프로필 (버전 관리)
                              ├ memories     기억 (무효화는 valid_to, 덮어쓰지 않음)
                              ├ raw_log      대화 원문 아카이브
                              ├ memory_vectors 의미 검색용 기억 벡터
                              ├ usage_log    주입 토큰 기록
                              └ meta         상황판·남은 질문 등 설정 칸
```

검색 파이프라인: `FTS5 후보 (무료)` → `재정렬` → `의미 검색 결과와 합치기` → `토큰 예산 패킹`.
재정렬은 `src/recall.ts`의 `Reranker` 인터페이스 뒤에 있어서 확률 판단 모델 같은 다른 재정렬기로 바꿀 수 있다. 의미 검색(아래)은 재정렬과 따로 돌아 결과만 합쳐진다.
한국어는 2글자 단위(bigram)로 색인해서 "서울에서/서울로"처럼 조사가 달라도 찾는다.

**의미 검색:** 단어가 달라도 뜻이 같은 기억을 찾는다("치과 예약" ↔ "이 치료 받으러 가"). 임베딩 모델 BGE-m3-ko(bge-m3를 한국어로 다듬은 모델, 허깅페이스 `jaybon1840/BGE-m3-ko-onnx`, 약 570MB, 이 PC 안에서만 동작)는 불러오는 데 몇 초 걸려서, 작은 도우미 프로세스(`src/semantic.ts`)가 모델을 띄워 두고 훅과 MCP 서버가 localhost로 묻는다. 첫 질문이 도우미를 백그라운드로 켜고(그 질문은 단어 검색만), 이후 질문부터 의미 검색이 합쳐진다. 질문 때 도우미가 꺼져 있으면 훅이 바로 다시 띄운다(이미 뜨는 중이면 또 띄우지 않는다). 오래 안 써서 스스로 꺼진 것은 조용히 다시 띄우고, 실제 실패(모델을 못 불러옴, 비정상 종료)일 때만 `<secretary-embedder>` 한 줄로 비서에게 알린다(장애 한 번에 세션마다 한 번). 비서는 사용자에게 알리고 `scripts/watch-embedder.mjs`로 살아났는지 지켜본다. 장애 중에는 DB 옆 `secretary.db.embedder-down.json`이 있고, 실패와 회복은 `secretary.db.embedder-failures.log`에 한 줄씩(시각, 연속 횟수, 원인 단서, 남은 메모리, 오류 첫 줄, 마지막 500줄까지) 남는다. 도우미는 새로 저장된 기억의 벡터를 알아서 만든다(켜져 있는 동안 메모리 최대 약 1.5GB). 비서 서버(`remote-server.ps1`)가 떠 있으면 도우미도 서버 창에 묶여 계속 떠 있다가 창이 꺼지면 같이 꺼지고, 서버 없이 쓸 때는 60분 동안 요청이 없으면 스스로 꺼진다. 모델은 처음 켤 때 `models/`에 자동으로 받는다(토큰·계정 없이, 1분 남짓). 실패 원인이 모델 파일 없음·깨짐이면 다음 재기동 때 도우미가 같은 저장소에서 다시 받아(옆 `.download` 폴더에 받고 허깅페이스의 크기·해시를 확인한 뒤 바꿔 넣음, 장애 한 번에 한 번) 띄운다. 그래도 실패하면 다시 띄우지 않고 "다시 받았는데도 실패, 사용자 확인 필요"를 알리며, 모델 파일이 바뀌거나 `watch-embedder.mjs --retry`로 다시 시도할 때까지 단어 검색만 쓴다. 원인이 메모리 부족(남은 메모리가 도우미에 필요한 양보다 적을 때의 비정상 종료·원인 미상 포함)이면 다시 띄우지 않고 멈춰, 도우미에 필요한 메모리와 지금 남은 메모리를 알리며 다시 켤지 묻는다. 켜라고 하면 `watch-embedder.mjs --retry`로 한 번 더 띄우고, 또 부족하면 같은 안내가 다시 온다. 필요한 메모리는 도우미가 떠 있는 동안의 최대 사용량을 도우미가 스스로 `secretary.db.embedder-memory.json`에 적은 값이고, 아직 없으면 실측값 1500MB(약 1.5GB)를 쓴다. 벡터는 모델 이름별로 저장돼서, 모델이 바뀌면 도우미가 켜질 때 옛 벡터를 지우고 기억 전체를 한 번 다시 색인한다. 도우미가 준비되지 않았거나 느리면 언제나 단어 검색만으로 동작한다.

### scripts/

| 파일 | 하는 일 |
|---|---|
| `remote-server.ps1` | 비서 폴더에서 Remote Control 서버를 띄우고, 끝나면 다시 띄움. 서버가 연 세션은 이 PC의 크롬(Claude in Chrome)을 쓴다(`CLAUDE_CODE_ENABLE_CFC=1`). 시작 전에 `bridge-pointer.json`을 지워 보관된 옛 세션을 다시 붙잡지 않게 한다 |
| `install-autostart.ps1` | 로그인할 때 `remote-server.ps1`이 숨긴 창·가장 높은 권한으로 자동 실행되도록 작업 스케줄러에 등록(관리자 PowerShell에서 실행) |
| `server-control.ps1` | 비서 서버 다시 켜기(`-Action restart`, 일회용 예약 작업이 몇 초 뒤 실행, `-Visible`이면 창이 보이게), 창 보이기·숨기기(`show`/`hide`), 기록 끝부분 보기(`log`) |
| `notify.ps1` | 화면 오른쪽 아래 Windows 알림 띄우기(서버 창이 처음 연결될 때 `remote-server.ps1`이 부른다) |
| `start-worker.ps1` | 업무 세션을 백그라운드(`claude --bg`)로 공간 폴더 제자리에서 시작. 브라우저가 필요한 업무는 `-Chrome`, 테스트 잠금 업무는 `-LockTests`. 같은 공간의 쉬는 세션이 55분 안·문맥 8만 토큰 미만이면 새 업무를 그 세션에 보내 이어 쓴다(`-New`면 새로 시작) |
| `worker-done.ps1` | 업무가 끝난 업무 세션을 바로 끄지 않고 쉬는 세션으로 적어 둔다. 55분 안에 재사용되지 않으면 뒤에서 끈다(`-Stop`이면 바로 끔) |
| `worker-guard.mjs` | 업무 세션 훅: 공간 폴더 밖 쓰기, git push, 게시·업로드, 폴더 통째 삭제(테스트 잠금이면 테스트 파일 수정도)를 막는다 |
| `trust-folder.mjs` | 신뢰된 상위 폴더 아래 공간 폴더를 Claude Code 설정에 '신뢰함'으로 적는다(업무 세션이 승인 창에 멈추지 않게) |
| `export-workspace.ps1` | 작업 공간의 넘길 것(AGENTS.md, CLAUDE.md, MEMORY.md, skills/, .claude/)만 복사해 zip으로 묶는다. 이 PC 사용자 경로·메일·키처럼 보이는 문자열·주입 문구·`-Names`로 준 이름이 걸리면 묶지 않고 걸린 줄을 보여 준다(종료 코드 3, `-Force`면 그래도 묶음) |
| `scan-threats.mjs` | `export-workspace.ps1`이 부르는 주입 문구 검사(`src/threats.ts`와 같은 패턴) |
| `watch-worker.ps1` | 백그라운드 업무 세션이 승인 창에 멈췄는지 토큰 없이 지켜보기 |
| `run-job.ps1` | 비싼 작업을 빈 세션(`claude -p`)에서 한 번 돌리고 결과 글만 받기. 모델(`-Model`)은 필수. `-Folder`가 없으면 비서 폴더 옆 `run-job-home`(없으면 만든다)에서 돈다. 같은 폴더·모델의 마지막 세션을 55분 안·문맥 8만 토큰 미만이면 이어 부른다(`-New`/`-Resume <id>`). 사용자 설정의 MCP는 붙이지 않고, 필요한 MCP만 `-McpConfig <파일>`로 붙인다 |
| `run-job-stats.ps1` | run-job 호출·업무 세션 재사용 기록(`~/.claude/usage/`)을 묶어 평균 비용·시간·문맥을 보여준다(이어 부르기 기준값을 고칠 때) |
| `backup-db.ps1` | 기억 DB를 `backups/`에 백업하고 14일 지난 것을 지운다. `-Install`/`-Uninstall`로 매일 실행 등록·해제 |
| `ego-grab.mjs` | (Ego Lite가 있을 때) 연 웹 페이지 본문을 근거 txt로 저장 |
| `worker-logs.ps1` | 백그라운드 업무 세션의 출력 보기 |
| `providers.ps1` | `providers.json`(Claude 구독 설정)을 읽는 공용 함수 |
| `open-chrome.ps1` | 브라우저 작업용 크롬 프로필 창을 이름으로 찾아 열기 (Claude in Chrome이 연결돼 있지 않을 때) |
| `claude-env.ps1` | 위 스크립트들이 쓰는 공용 함수 (앱 환경변수 정리, 로그인 확인) |
| `usage.ps1` | 구독 사용량을 토큰 없이 조회(`claude -p "/usage"`, 5시간·주간)해 `~/.claude/usage/subscription.json`에 저장. 정지 훅이 기록이 5분 넘게 오래되면 뒤에서 띄운다 |
| `install-usage-guard.mjs` | 사용량 일시 정지 장치를 사용자 설정(`~/.claude/settings.json`)에 등록. 5시간 사용량이 90%(`USAGE_PAUSE_PCT`)를 넘으면 비서와 업무 세션이 하던 단계만 마무리하고 멈춘다. 끄기: `~/.claude/usage-guard-off` 파일 생성 |
| `usage-guard.mjs` | 사용량 일시 정지 PreToolUse 훅. 기준을 넘으면 마무리용 도구만 허용한다. 기록이 5분 넘게 오래되면 `usage.ps1`을 뒤에서(창 없이) 띄운다 |
| `usage-statusline.mjs` | 상태줄 프로그램. 5시간·주간 사용량을 기록 파일에 적고 "5h 93% · 초기화 14:00" 같은 한 줄로 보여 준다 |
| `usage-file.mjs` | 위 두 파일이 쓰는 사용량 기록 파일 위치(`~/.claude/usage/subscription.json`) |
| `providers.json` | Claude 구독 설정(`subscription` 하나) |
| `watch-embedder.mjs` | 의미 검색 도우미가 살아났는지 AI 없이 지켜보다가 살아나면 끝나며 비서를 깨운다(비서가 백그라운드 명령으로 띄움). 확인할 때 꺼져 있으면 바로 다시 띄운다(이미 뜨는 중·모델을 다시 받는 중이면 두고 본다). 다시 받아도 실패해 멈췄거나 메모리 부족으로 멈췄으면 그렇다고 찍고 끝난다. `--retry`는 멈춘 것을 한 번 더 시도한다. `--interval-sec 5`, `--max-minutes 240` |

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
| `SECRETARY_WORKSPACE_ROOT` | 비서 폴더 옆 `workspaces` | 위임 업무 폴더를 만들 위치 |
| `SECRETARY_PROFILE_MAX_TOKENS` | 2000 | 프로필 상한 |
| `SECRETARY_AUTO_RECALL_TOKENS` | 2500 | 매 턴 자동 주입 상한 |
| `SECRETARY_RECALL_TOKENS` | 4000 | `recall` 도구 기본 예산 |
| `SECRETARY_TZ` | `Asia/Seoul` | 시각을 보여 줄 시간대 (저장은 항상 UTC) |
| `SECRETARY_EMBED` | (켜짐) | `off`면 의미 검색을 끄고 단어 검색만 쓴다 |
| `SECRETARY_EMBED_IDLE_MIN` | 60 | 비서 서버 없이 켜진 의미 검색 도우미가 요청 없이 기다리다 꺼지는 시간(분) |
| `SECRETARY_EMBED_MODEL_DIR` | `./models` | 임베딩 모델 파일을 받아 두고 찾는 폴더 |
| `SECRETARY_EMBED_MODEL_REPO` | `jaybon1840/BGE-m3-ko-onnx` | 모델 파일이 없거나 깨졌을 때 다시 받는 허깅페이스 저장소 |

## v5에서 v6로 갈아타기

기억(`secretary.db`), 검색 모델, 작업 공간은 그대로 이어 쓴다. DB 형식·검색 모델·공간 위치가 v5와 같아서 다시 받거나 다시 색인하거나 옮기지 않는다. 바뀐 것:
- **의미 검색 도우미 스스로 고치기:** 모델 파일이 없거나 깨져서 실패하면 같은 허깅페이스 저장소에서 한 번 다시 받아 띄운다. 그래도 실패하면 다시 띄우지 않고 "사용자 확인 필요"를 알린다. 메모리가 부족해 꺼졌으면 다시 띄우지 않고, 필요한 메모리와 남은 메모리를 알리며 다시 켤지 묻는다. 켜라고 하면 비서가 `watch-embedder.mjs --retry`로 한 번 더 띄운다.
- **사용량 정지 풀기:** "90퍼 넘어도 계속"처럼 비슷한 말도 알아듣는다.
- **답 방식:** 비서가 묻는 질문은 보고 글 속에 섞지 않고 답 끝에 따로 둔다.
- **`/consolidate`:** 끝나면 핵심 프로필 전체를 번호 붙여 보여 주고 뺄 줄이 있는지 묻는다.

1. v5 비서 세션을 모두 끈다. 자동 시작으로 비서 서버를 쓰고 있었다면 작업 스케줄러에서 `Secretary Remote Control` 작업을 오른쪽 클릭해 **사용 안 함**으로 두고 PC를 다시 켠다.
2. v5 폴더의 `secretary.db`(있으면 `backups/`도)를 안전한 곳에 한 부 복사해 둔다.
3. v5 폴더에서 `secretary.db`·`backups/`·`node_modules/`·`models/`만 남기고 나머지를 v6 zip의 파일로 바꾼다. 작업 공간은 비서 폴더 밖(`workspaces`)에 있으므로 건드리지 않는다.
4. 그 폴더에서 `npm install`.
5. 1번에서 작업을 사용 안 함으로 두었다면 다시 **사용**으로 바꾸고 PC를 다시 켠다. 폴더 자리가 같으므로 `install-autostart.ps1`·`backup-db.ps1 -Install`은 다시 하지 않아도 된다.
6. `claude`로 비서를 켠다. 상황판은 v5에서 이어진다.

v4 이하에서 오는 경우는 아래 "v4에서 v5로 갈아타기"를 v6 zip으로 따라 하면 된다.

## v4에서 v5로 갈아타기

기억(`secretary.db`)과 검색 모델은 그대로 이어 쓴다. DB 형식과 검색 모델이 v4와 같아서 다시 받거나 다시 색인하지 않는다. 바뀐 것:
- **작업 공간 위치:** 새 작업 공간이 비서 폴더 바로 옆이 아니라 비서 폴더 옆의 `workspaces` 폴더 안에 생긴다. 맡길 일이 많아도 비서 폴더 옆이 공간 폴더로 어지러워지지 않게 하려는 것이다.
- **`/consolidate`:** 긴 메시지를 자르지 않고 다 읽고(2만 자가 넘는 메시지만 나눠 받는다), 정리 대기 대화가 0이 될 때까지 이어서 정리한다.
- **상황판:** Haiku가 생각 깊이 medium으로 고쳐 쓴다(v4는 low).
- **의미 검색 도우미 복구:** 도우미가 실패하면 질문 때 바로 다시 띄우고, 실제 실패일 때만 비서가 한 번 알리고 살아날 때까지 지켜본다(`scripts/watch-embedder.mjs`). 실패와 회복은 `secretary.db.embedder-failures.log`에 남는다.
- **고친 것:** 공간 폴더를 옮긴 뒤에도 맡긴 업무의 보고서를 찾는다. 세션 시작 때 대화 기록 파일 하나가 읽히지 않아도 프로필이 빠지지 않는다. 사용량 갱신·쉬는 업무 세션 끄기가 창을 잠깐 띄우지 않는다.
- **run-job:** 기본 폴더 `run-job-home`에서 일마다 `output/research/<날짜-일>/`을 쓴다(v4는 `work/`).

1. v4 비서 세션을 모두 끈다. 자동 시작으로 비서 서버를 쓰고 있었다면, 서버가 켜진 채로 DB를 옮기지 않도록 먼저 작업 스케줄러에서 `Secretary Remote Control` 작업을 오른쪽 클릭해 **사용 안 함**으로 두고 PC를 다시 켠다(7번에서 다시 등록하면 새 작업으로 바뀌어 다시 켜진다).
2. v4 폴더의 `secretary.db`(있으면 `backups/`도)를 안전한 곳에 한 부 복사해 둔다.
3. v5 zip을 새 폴더에 풀고, v4 폴더에서 `secretary.db`·`backups/`·`models/`를 그 폴더로 옮긴다(`models/`를 옮기면 검색 모델 약 570MB를 다시 받지 않는다). v4 폴더 자리에 그대로 쓰고 싶으면, v4 폴더에서 `secretary.db`·`backups/`·`node_modules/`·`models/`만 남기고 나머지를 v5 파일로 바꿔도 된다.
4. v5 폴더에서 `npm install`.
5. **지금까지 만든 작업 공간 옮기기:** 비서 폴더 옆에 있던 공간 폴더(`quick-outputs`, `<공간이름>-<날짜>` 꼴 폴더)를 비서 폴더 옆에 새로 만든 `workspaces` 폴더 안으로 옮긴다. 이름은 바꾸지 않는다(비서는 옛 위치에 없으면 `workspaces` 안의 같은 이름 폴더를 찾는다). `run-job-home`은 옮기지 않는다. 옮기기 싫으면 옮기지 말고, 대신 환경변수 `SECRETARY_WORKSPACE_ROOT`를 공간들이 있는 폴더(비서 폴더를 담고 있는 폴더)로 정해 두면 v4처럼 그 자리에 생긴다.
6. v5 폴더에서 `claude`로 비서를 켠다. 상황판은 v4에서 이어진다.
7. 폴더가 바뀌었다면: 자동 시작을 쓰고 있었으면 위 "설치" 7번의 3~6단계대로 관리자 PowerShell에서 `install-autostart.ps1`을 다시 실행하고(같은 이름의 작업은 덮어쓴다, 7번의 1단계는 건너뛴다), 매일 백업(`backup-db.ps1 -Install`)을 등록해 두었으면 v5 폴더에서 다시 실행한다. 같은 폴더 자리에 바꿔 넣었으면 다시 하지 않아도 된다.

v3에서 오는 경우도 같지만, 비서 서버가 창 없이 뜨고 자동 시작이 가장 높은 권한으로 바뀌었으므로 7번의 `install-autostart.ps1`을 꼭 관리자 PowerShell에서 다시 실행한다(v3 때 최소화돼 있던 PowerShell 서버 창은 1번에서 끈다). 원하면 설치 8번(UAC)도 한다. v2 이하에서 오는 경우도 같지만, 6번에서 처음 켤 때 지금까지의 대화 전체로 상황판을 처음 만드느라 첫 답이 늦을 수 있다(대화가 많으면 몇 분, 첫 질문은 최대 5분 기다린 뒤 못 끝내면 직전 세션 정보만 붙여 보낸다). 비서가 그때 만든 작업 공간에는 스킬·`MEMORY.md`가 없으니, 그 공간에 일을 맡겨 끝나면 비서가 첫 회고 때 옮길지 물어본다. v1에서 오면 검색 모델도 바뀌어(bge-m3 → BGE-m3-ko) 새 모델을 받고 기억 전체를 한 번 다시 색인한다(기억 수에 따라 몇 분). 옛 모델 폴더 `models/Xenova`는 지워도 된다.

## 개인 데이터

`secretary.db`(기억·대화 원문)와 `backups/`는 이 PC에만 둔다. 이 폴더를 남에게 줄 때는 이 두 가지를 빼고 준다(`.gitignore`에 들어 있다).

## 다음 단계 후보

- 기억이 수만 개로 늘어 의미 검색이 느려지면 sqlite-vec로 벡터 검색 옮기기
- 확률 판단 재정렬기 (`Reranker` 구현 하나 추가)
