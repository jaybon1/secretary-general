# secretary — 장기 기억 개인 비서 (범용 배포판 v0.11.0)

Claude Code를 비서 본체로 쓰고, 기억은 이 폴더의 SQLite 파일 하나(`secretary.db`)에 둔다. Claude 구독 하나만 있으면 된다.
원칙: **저장은 무제한, 읽기는 예산제.** 기억이 몇 년 치 쌓여도 한 턴에 컨텍스트로 들어가는 양은 고정된다.

버전마다 바뀐 것은 [`CHANGES.md`](CHANGES.md)에 있다. 지금 버전은 폴더 맨 위 `VERSION` 파일이고(v0.9.0부터 0.x 세 자리: 끝자리 고침, 가운데 기능 추가, 앞자리 사용자가 손봐야 하는 변경. 그 전의 v1~v8은 0.1.0~0.8.0으로 본다), 이 버전이 넣은 파일과 내용 해시는 `release-files.json`에 있다(배포판을 만들 때 생긴다. 업데이트·테스트·설치 상태 점검(`setup-check`)이 사용자가 고치거나 만든 파일을 가리는 데 쓰니 고치지 않는다).

## 설치 (처음 쓰는 사람)

컴퓨터를 잘 몰라도 아래 순서대로 하면 된다. 처음 켜면 아무 기억도 없는 빈 비서로 시작하고, 비서가 먼저 이름과 부를 호칭, 원하는 말투 등을 물어본다.

**먼저 알아 둘 것 (폰이나 다른 PC에서 쓸 사람):** 이 비서는 PC가 켜져 있으면 어디서든 일을 돕는 용도다. 그런데 비서가 관리자 권한이 필요한 일(예약 작업 등록 등)을 할 때 PC 화면에 사용자 계정 컨트롤(UAC) 확인 창("이 앱이 디바이스를 변경하도록 허용하시겠어요?")이 뜨면, 밖에 있는 동안에는 눌러 줄 사람이 없어 그 일이 멈춘다. 이를 막으려면 아래 8번(비서 서버 자동 시작)을 꼭 한다. 8번으로 띄운 서버 안의 비서는 처음부터 관리자 권한으로 돌아 UAC 확인 창 없이 일한다. UAC 설정을 낮출 필요는 없다. 설치하는 동안(Node·Git 설치 프로그램, 관리자 터미널 열기)에 뜨는 UAC 창은 PC 앞에서 **예**를 누르면 된다.

1. **Node 설치:** [nodejs.org](https://nodejs.org)에서 24 이상 버전(LTS)을 받아 설치한다. Windows라면 [Git for Windows](https://git-scm.com)도 설치한다(비서의 자동 기억 기능이 이것으로 돈다).
2. **Claude Code 설치:** [Claude Code 안내](https://claude.com/claude-code)대로 설치한다(데스크톱 앱 또는 터미널 버전).
3. **이 폴더 준비:** 받은 zip을 원하는 곳에 풀고, 그 폴더에서 터미널(PowerShell)을 연다. 탐색기에서 폴더를 연 뒤 주소창에 `powershell`이라고 치고 Enter를 누르면 된다.
4. **필요한 부품 받기:** 터미널에 `npm install`을 입력한다. 몇 분 걸릴 수 있다.
5. **로그인:** 터미널에 `claude auth login`을 입력하고, 열리는 브라우저에서 Claude 계정(구독)으로 로그인한다.
6. **설치 마무리(Windows, 관리자 권한 필요 없음):** 같은 터미널에 아래 세 줄을 차례로 입력한다.
   1. `node src/cli.ts skill-links` — 비서의 스킬(일 맡기기, 기억 정리, 업데이트 등)은 Codex·Antigravity가 읽는 `.agents/skills/`에 들어 있다. 이 명령은 Claude Code가 읽는 `.claude/skills`를 그리로 가는 링크로 만든다(폴더 바로 가기 같은 Windows 디렉터리 정션이라 관리자 권한이 필요 없다). `만듦: .claude/skills → .agents/skills`가 나오면 된 것이다. zip에는 이 링크를 담을 수 없어 설치마다 한 번 만든다.
   2. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scheduled\install-scheduled-tasks.ps1 -Task idle-jobs` — 쉬는 시간 작업을 등록한다(아래 "사용"). 처음이면 `비서 고유 번호를 새로 만들었어요: A3F9`처럼 이 비서의 고유 번호(짧은 무작위 글자, 폴더의 `.secretary-id`)가 먼저 나오고, `등록됨: Secretary Idle Jobs (A3F9)`가 나오면 된 것이다. 예약 작업 이름 끝 괄호가 이 번호다.
   3. `[Environment]::SetEnvironmentVariable("SECRETARY_$((Get-Content .secretary-id).ToUpper())_DIR", (Get-Location).Path, 'User')` — 비서 폴더 위치를 이 비서 번호가 든 이름(예: `SECRETARY_A3F9_DIR`)으로 Windows에 알려 둔다(비서 폴더 밖의 도구가 이 값으로 비서 스크립트를 찾는다. 한 PC에 비서가 여럿이어도 비서마다 따로다). 폴더를 옮기면 새 위치에서 다시 한다.
7. **비서 켜기:** 같은 폴더에서 `claude`를 입력한다(데스크톱 앱이면 이 폴더를 연다). `secretary` 서버를 쓸지 물으면 허용한다. 이제 대화하면 된다.
8. **(선택) 컴퓨터를 켜면 비서 서버가 자동으로 켜지게:** 폰이나 다른 PC에서 비서를 쓰려는 경우만 한다(아래 "다른 기기에서 쓰기"). 관리자 PowerShell이 필요하다.
   1. 위 3번처럼 이 폴더에서 연 터미널에 `claude remote-control`을 입력하고, `Enable Remote Control? (y/n)`이 나오면 `y`를 누른다. 연결됐다는 글이 나오면 `Ctrl+C`로 끈다. 비서 서버는 창 없이 뜨기 때문에 이 질문을 처음 한 번 여기서 답해 둬야 한다.
   2. 탐색기 주소창의 이 폴더 경로를 복사해 둔다(주소창을 누르면 `C:\Users\...` 형식의 경로가 나온다).
   3. 시작 단추를 오른쪽 클릭하고 **터미널(관리자)**(Windows 10은 **Windows PowerShell(관리자)**)을 누른다. "이 앱이 디바이스를 변경하도록 허용하시겠어요?"가 나오면 **예**.
   4. 열린 창에 `cd "<복사한 경로>"`를 입력한다(따옴표 안에 붙여 넣기).
   5. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scheduled\install-scheduled-tasks.ps1 -Task server`를 입력한다. `등록됨: Secretary Remote Control (번호)`가 나오면 된 것이다(번호는 6번에서 나온 이 비서의 고유 번호).
   6. 지금 바로 켜려면 `Start-ScheduledTask -TaskName "Secretary Remote Control ($(Get-Content .secretary-id))"`을 입력한다(다음부터는 Windows에 로그인할 때 자동으로 켜진다). 서버 창은 보이지 않는 것이 정상이고, 연결되면 화면 오른쪽 아래에 "비서 · 서버가 연결됐어요" 알림이 한 번 뜬다. 관리자 창은 닫는다.

   왜 관리자 권한인가: 비서 서버를 가장 높은 권한으로 띄워야 그 안의 비서가 관리자 권한이 필요한 일(예약 작업 등록·삭제 등)을 UAC 확인 창 없이 할 수 있고, 채팅으로 서버를 다시 켤 때 옛 서버를 끌 수 있다(권한이 낮으면 옛 서버를 못 꺼서 새 서버가 계속 거절된다). 그래서 UAC 설정은 그대로 둬도 된다. 다만 데스크톱 앱이나 일반 터미널에서 연 비서는 관리자 권한이 아니라서, 관리자 일을 하면 UAC 창이 뜰 수 있다.

**설치가 끝났는지 모르겠으면 비서에게 '설치 다 됐어?'라고 물어보세요.**

설치 상태 점검: 비서를 켤 때마다 훅이 설치 항목(기능 목록 `features.json`, 기억 DB, `npm install`, 의미 검색 모델 파일, 스킬 링크 `.claude/skills`·`.agents/skills`, 진입점 폴더 `bin/`, 환경변수 `SECRETARY_<번호>_DIR`, 작업 공간의 비서 위치 파일 `secretary-link.local.json`, 비서 서버 자동 시작 예약 작업과 실행, 매일 백업 예약 작업, 쉬는 시간 작업 예약 작업, 사용자 설정의 사용량 정지 훅·상태줄, 빠진 배포판 파일)을 AI 없이 점검한다. 예약 작업 이름과 비서 폴더 환경변수에는 비서마다의 고유 번호(`.secretary-id`)가 붙어 한 PC에 비서가 여럿이어도 겹치지 않는다. 다른 비서 폴더를 가리키는 훅·상태줄은 그 비서 것으로 보고 바꾸자고 하지 않고, 같은 번호의 다른 폴더(옮기거나 복사하고 남은 사본)를 가리키면 이 비서의 옛 위치로 보고 고치자고 한다. 번호가 붙기 전 이름으로 등록된 이 비서의 예약 작업은 새 이름으로 옮기자고 한다. 다 갖춰졌으면 아무것도 붙지 않아 토큰이 들지 않고, 빠진 것이 있을 때만 비서가 매 답 맨 위에 한 줄로 알린다. "설치 이어서 해 줘"라고 하면 함께 진행한다. 안 쓰는 선택 항목(자동 시작, 매일 백업, 사용량 정지 장치)은 "그건 안 써"라고 하면 비서가 점검에서 빼 둔다(`node src/cli.ts setup-check --skip <id>`). 직접 보기: `node src/cli.ts setup-check`(꺼 둔 기능은 끝에 한 줄로 나온다). 관리자 권한으로 뜬 창의 명령줄을 못 읽거나 예약 작업 조회가 권한 때문에 막히는 등 확인할 수 없는 항목은 "빠짐"이 아니라 "확인 못 함"으로 두고, 그것만으로는 알리지 않는다.

문제가 생기면:
- 비서 서버가 켜졌는지 모르겠으면 비서에게 "서버 기록 보여줘"라고 하거나 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\remote-server\server-control.ps1 -Action log`를 실행한다(기록: `%USERPROFILE%\.secretary\<번호>\logs\server-a`, 번호는 비서 폴더 `.secretary-id`).
- 의미 검색이 켜지지 않는다는 말이 나오면(`onnxruntime_binding.node` 로드 실패) [Visual C++ 재배포 패키지](https://aka.ms/vs/17/release/vc_redist.x64.exe)를 설치한다. 그동안에도 단어 검색으로는 잘 동작한다.
- 비서가 "의미 검색 서버가 꺼져 있어 다시 띄우는 중이에요"라고 하면 의미 검색 서버가 모델을 못 불러왔거나 비정상으로 꺼진 것이다. 비서가 살아날 때까지 지켜보고 알려 준다. 원인은 비서에게 물으면 이 폴더의 `secretary.db.semantic-search-server-failures.log`를 읽어 알려 준다.
- 비서 폴더는 그대로 두고, 비서가 일을 맡기면 작업 공간 폴더가 이 폴더 옆의 **`workspaces` 폴더** 안에 생긴다(없으면 만든다).

핵심(기억 서버·훅·정리·위임·사용량 장치)은 Node와 bash라 모든 OS에서 동작하고, `scripts/`의 PowerShell 파일(원격 서버·예약 작업·백그라운드 업무 세션·크롬 열기)만 Windows 전용이다. 맥·리눅스에서는 Claude Code에게 해당 스크립트를 그 OS용으로 바꿔 달라고 하면 된다.

## 기능 켜고 끄기

기능 목록은 폴더 맨 위 `features.json`이다. 기본 기능(기억, 설치 상태 점검, 업데이트, 상황판, 정리, 위임, 비서 서버, 매일 백업, 사용량 정지 장치)은 언제나 켜져 있고, 아래 선택 기능은 비서에게 말하면 켜고 끈다(예: "일정 기능 켜 줘", "무슨 기능이 꺼져 있어?"). 비서가 무엇이 생기는지(폴더, 예약 작업, 비용, 바깥 서비스)를 먼저 알리고 승인받아 `features.json`과 규칙(AGENTS.md)을 함께 고친다(`feature-toggle` 스킬, 기능마다 `.agents/skills/feature-toggle/references/<id>.md`).

| 기능 | 처음 | 무엇 |
|---|---|---|
| 사용량 뒤에서 조회 (`usage-poll`) | 켜짐 | 비서 서버가 켜져 있는 동안 구독 사용량을 5분마다 토큰 없이 새로 읽어 정지 장치가 늘 새 값을 본다 |
| 쉬는 시간 작업 (`idle-jobs`) | 켜짐 | 대화가 멈추면 상황판을 미리 고쳐 쓰고 쌓인 대화를 기억으로 정리 |
| 브라우저 작업 (`browser`) | 켜짐 | Ego Lite가 설치돼 있으면 로그인된 사이트·클릭·입력, 없으면 Claude in Chrome |
| 일정 (`calendar`) | 꺼짐 | 날짜가 있는 일을 Google Calendar에 바로 기록(claude.ai 커넥터) |
| 메모 볼트 (`notes`) | 꺼짐 | 말한 내용을 비서 폴더 옆 `notes`에 옵시디언 노트로 정리 |
| 받은 파일 (`inbox`) | 꺼짐 | 비서에게 넘기는 파일을 두는 비서 폴더 옆 `inbox` |
| 네트워크 공유 (`network-share`) | 꺼짐 | 다른 PC에서 비서 상위 폴더를 읽기 전용으로 보기(`notes`·`inbox`만 쓰기) |
| 다중 구독 (`multi-subscription`) | 꺼짐 | 구독이 둘 이상이면 사용률에 따라 일을 가장 여유 있는 다른 계정으로 자동으로 넘김 |
| 구독 밖 공급자 (`external-providers`) | 꺼짐 | 업무 세션·run-job을 API 키, Bedrock, 게이트웨이, 다른 회사 CLI로 |
| 실수 막기 장치 (`mistake-guards`) | 켜짐 | 영어로 샌 답·빠진 경로 줄·추천 근거를 되돌려 고쳐 쓰게 하고, 폴더 위치 막기·되풀이 알림·위임 앞뒤 대조·실수 기록 |
| 대시보드 (`dashboard`) | 꺼짐 | 한도·돌고 있는 일·업무 칸반을 보는 웹 화면, 결과물 폴더를 폰 브라우저로 읽기 전용으로 보기 |
| 끝 알림 (`phone-push`) | 꺼짐 | 답이 끝날 때마다 첫 줄을 이 PC의 ntfy 서버로 보내 폰 앱(원하면 PC 브라우저 웹 푸시)에 띄우기 |

꺼진 기능은 파일은 있지만 설치 상태 점검·알림·예약 작업을 건너뛰고 규칙도 없어 비서가 쓰지 않는다. 켜고 끈 것은 사용자 수정으로 남아, 업데이트 때 지켜진다.

## 사용

이 폴더에서 Claude Code 세션을 새로 열면 된다.

- 평소엔 그냥 대화. 비서가 기억할 만한 걸 알아서 `remember` 한다. 거의 같은 기억이 이미 있으면(의미 유사도 0.85 이상) 저장 전에 비교해 건너뛰거나 바꾼다.
- **쉬는 시간 작업** — 예약 작업 'Secretary Idle Jobs (번호)'가 5분마다 `node src/cli.ts idle-jobs`를 돌린다. 대화가 10분 멈추면 상황판을 미리 고쳐 쓰고, 정리 안 된 대화가 60건 넘고 30분 멈추면 기억 정리를 돌린다(둘 다 같은 구독의 Haiku라 그만큼 사용량을 쓴다). 정리가 끝나면 다음 답 끝에 안내가 붙고, **"기억 정리 확인"**만 보내면 비서가 결과와 핵심 프로필·주요 현안을 함께 본다. 기록은 `%USERPROFILE%\.secretary\<번호>\logs\idle-jobs.log`(번호는 비서 폴더 `.secretary-id`).
- `/consolidate` — 쌓인 대화 원문을 기억·프로필로 바로 정리(자동 정리가 안 돌았을 때). 쉬는 시간 정리와 같은 정리 담당(`src/staff/memory-consolidation.json`, Haiku)을 비서 대화 밖(`workspaces/_staff/memory-consolidation`)에서 띄우고 바로 끝나 메인 모델 사용량을 아낀다. 결과는 다음 답의 안내 뒤 "기억 정리 확인"으로 본다. 이미 도는 정리가 있으면 새로 띄우지 않는다.
- `/plan-grill` — 계획의 빈틈을 질문으로 파고든다.
- **업데이트** — "업데이트 확인해 줘"라고 하면 비서가 [GitHub 저장소](https://github.com/jaybon1/secretary-general)의 최신판을 임시 폴더에 받아, 먼저 DB와 비서 폴더를 `backups/`에 백업하고, 받았던 버전을 알아낸 뒤 사용자가 고친 파일은 지키면서 새 버전을 얹는다. 사용자도 새 버전도 고친 파일은 깨끗이 합쳐지더라도 파일마다 유지·덮어쓰기·섞기를 묻고, 많으면 "나머지는 추천대로"를 함께 묻는다. 버전 사이에 옮겨진 파일도 따라가 옛 위치의 수정을 새 위치로 합친다. 기억 DB·모델·`node_modules`·`*.local.json`·작업 공간은 건드리지 않는다(`secretary-update` 스킬, `scripts/update.mjs`). 이미 최신이면 그렇게 말하고 끝낸다.
- `/session-handoff` — 지금 세션을 새 비서 세션으로 넘기고, 새 세션이 옛 세션을 보관한다. **Remote Control(폰·다른 PC에서 비서 쓰기)이나 데스크톱 앱으로 비서를 쓰는 사람용**이다(세션을 만들고 보관하는 도구가 그 세션에만 있다). 터미널에서만 쓰면 필요 없다: 그냥 새 세션을 열면 아래 "상황판"이 이어 준다.
- **상황판 (새 세션이 이어받기)** — 지난 상황판과 그 뒤 대화를 같은 구독의 Haiku가 고쳐 쓴다(쉬는 시간과 새 세션을 열 때). 새 세션(`/clear`와 대화 압축 뒤도)의 첫 질문에 상황판과 아직 판에 안 들어간 대화가 붙어, 비서가 "지금 무슨 일이 어디까지 됐는지" 알고 첫 답 맨 위에 `> 이어서: …` 한 줄을 적는다. 답을 못 받은 질문(A, B…)도 새 세션에서 A부터 다시 붙여 넘어온다. 지금 판은 `node src/cli.ts situation-board-show`.
- **주요 현안** — 몇 달 가는 안건(프로젝트 단위의 일)의 상태(진행 중 / 사용자 차례 / 보류 / 운영 중)를 DB에 한 줄씩 둔다. 세션을 열 때 붙고, 상태가 바뀌면 비서가 그 줄만 고친다(이력이 남는다).
- **대화 지우기** — `비서 대화 삭제 2턴`(최근 두 턴), `비서 대화 삭제 #120`, `비서 대화 삭제 #120-#135`처럼 그 글만 보내면, 지울 대화를 단어 첫 글자로만 보여 주고 승인 코드를 준다. 30분 안에 그 코드만 보내면 AI를 거치지 않고 지우고, 그 대화에서 나온 기억도 무효로 한다. 지운 대화는 `backups/error/`의 격리 DB로 옮겨지고 비서는 열지 않는다. "비서 대화 삭제"만 보내면 쓰는 법이 나온다.
- **업무 위임** — 파일이 생기는 일은 크기와 상관없이 맡긴다. 간단한 일은 공용 폴더 `quick-outputs`, 그 밖은 맞는 기존 작업 공간을 추천하거나 새로 만든다. 공간은 비서 폴더 옆 `workspaces` 폴더 안에 생기고, 결과는 제품별로 둔다: 제품 본체는 `output/products/<제품>/`에 하나만 두고 업무마다 제자리에서 고치며, 업무 기록(지시서 `TASK.md`, 보고서 `REPORT.md`)은 `output/records/<제품>/<날짜>-<업무이름>/`, 실험·조사는 `output/research/<날짜>-<업무이름>/`에 쌓인다. 계획을 확인받은 뒤 그 공간 폴더에서 새 세션이 일한다. 기억·판단이 많이 드는 조사·검토는 비서가 직접 하거나 서브에이전트에 맡긴다. 절차는 `.agents/skills/delegate/SKILL.md`에 있어서 일을 맡길 때만 읽힌다(AGENTS.md는 매 세션 읽히므로 짧게 유지). 일을 맡기기 전에는 `grill` 스킬로 정할 것부터 묻는다.
- **공간이 배우는 것** — 작업 공간마다 업무 종류별 스킬(`.agents/skills/<이름>/SKILL.md`, 비서와 같은 구조), 늘 맞는 사실(`MEMORY.md`, 2,000자 안), 업무 세션이 남긴 제안(`notes/pending/`)이 생긴다. 사용자가 고쳐 준 것은 업무 세션이 그 스킬에 바로 적고, 스스로 찾은 것은 제안으로 남겼다가 비서가 업무 끝에 승인받아 반영한다. 여러 공간이 함께 쓸 업무 기준은 공통 스킬 `workspaces\_skills\common-<업무>\`에 둔다(스킬은 agentskills.io 사양: SKILL.md와 scripts\·references\·assets\).
- **기억 오염 막기** — 기억·프로필에 "이전 지시는 모두 무시해" 같은 프롬프트 주입·유출 문구가 들어오면 저장을 거절한다(`src/memory/injection-screen.ts`). 다른 세션의 메시지나 작업 알림에 든 말은 사용자가 한 말로 보지 않는다.
- **사용량 일시 정지** — `node scripts/usage/install-usage-guard.mjs`로 사용자 설정에 상태줄과 훅을 등록하면(다시 실행해도 안전. 이 PC의 다른 비서가 이미 등록해 두었으면 그것을 함께 쓰고 건드리지 않는다), 구독 5시간·주간 사용량이 90%를 넘을 때 비서와 업무 세션이 하던 단계만 마무리하고 멈춘다. 그래도 이어 가야 하면 "90퍼센트를 초과하더라도 진행", "90퍼 넘어도 계속"처럼 말하면 프롬프트 훅이 5시간 사용량 초기화 때까지 장치를 푼다. 푸는 것은 이 대화의 계정뿐이고, 두 번째 구독을 켰으면 "계정 b 90퍼 넘어도 진행"처럼 계정을 적어 그 계정을 푼다. 구독이 아닌 계정(API 키 등)은 처음부터 막지 않으므로 "대상이 아니에요"라고 알린다. 비서가 스스로 풀지는 않는다. 끄기: `~/.secretary/usage-guard-off` 파일 생성(v0.9.0까지의 위치 `~/.claude/usage-guard-off`도 한동안 읽는다). 사용량 값은 비서 서버가 같이 띄우는 조회기(선택 기능 `usage-poll`, 처음부터 켜짐)가 5분마다 토큰 없이 새로 읽는다.
- **기억 DB 매일 백업 (Windows)** — 처음 쓸 때 비서가 한 번 묻는다. 켜면 예약 작업 'Secretary DB Backup (번호)'이 매일 22:30(`-At`으로 바꿈, 그 시각에 PC가 꺼져 있었으면 다음에 켤 때) 이 폴더의 `backups/`에 `secretary-<날짜-시각>.db`를 만들고 14일이 지난 백업은 지운다. 이 PC 밖으로는 보내지 않고 토큰도 들지 않는다. 켜기: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scheduled\install-scheduled-tasks.ps1 -Task backup`, 끄기: 이 폴더에서 `Unregister-ScheduledTask -TaskName "Secretary DB Backup ($(Get-Content .secretary-id))" -Confirm:$false`(만든 백업은 남는다).

모든 세션(비서, 업무 세션, `run-job`)은 기본으로 이 PC에 로그인된 Claude 구독 하나로 돈다(`scripts/lib/providers.json`의 `subscription`). 비서 대화는 Opus medium(`.claude/settings.json`의 `effortLevel`), 작업 공간은 Sonnet high / Opus medium / 추론이 깊은 일은 Opus high를 기준으로 쓴다.

### 다른 기기에서 쓰기 (Remote Control, 선택)

비서는 이 폴더가 있는 컴퓨터에서만 실행하고, 다른 PC나 폰에서는 Remote Control로 접속한다.

- **열려 있는 세션 이어 쓰기:** 데스크톱 앱 설정 > Claude Code > "Connect new sessions to Remote Control"을 켜면 새 세션이 claude.ai/code와 Claude 앱에 나타난다.
- **원격에서 새 비서 세션 열기:** `scripts/remote-server/remote-server.ps1`이 이 폴더에서 `claude remote-control`(서버 모드)을 띄우고, 끝나면 다시 띄운다. `scripts/scheduled/install-scheduled-tasks.ps1 -Task server`는 Windows에 로그인할 때 이 서버가 가장 높은 권한으로 자동 실행되도록 작업 스케줄러에 등록한다(관리자 PowerShell에서, 위 설치 8번). 서버 창은 숨겨 뜨고, 처음 연결될 때 Windows 알림이 한 번 뜬다. 서버 출력은 `%USERPROFILE%\.secretary\<번호>\logs\server-a`에 날짜별로 14일 치 남는다. 처음 한 번은 이 컴퓨터에서 `claude auth login`으로 로그인하고, 이 폴더에서 `claude remote-control`을 직접 한 번 실행해 `Enable Remote Control? (y/n)`에 `y`로 답해야 한다(서버 창에서는 이 질문이 보이지 않는다).
- **채팅으로 서버 다루기:** 비서에게 "서버 다시 켜줘"(원하면 "창이 보이게"), "서버 창 보여줘/숨겨줘", "서버 기록 보여줘"라고 하면 `scripts/remote-server/server-control.ps1`로 한다. 다시 켜면 그 서버 안의 비서 대화가 끊기고(끊기기 전 대화는 저장한다), 클라우드가 옛 서버 등록을 3분쯤 잡고 있어 4분쯤 뒤에 연결된다. 채팅으로 서버를 끄는 기능은 없다.
- **원격 지시로 업무 맡기기:** 원격으로 받은 지시에는 앱이 `start_session`을 허용하지 않으므로, 비서는 `scripts/worker/start-worker.ps1`로 업무 세션을 백그라운드(`claude --bg`)에서 시작하고 `SendMessage`의 `notify_when_idle`로 진행을 받는다. 업무 세션은 Remote Control에 붙이지 않아 다른 기기의 세션 목록에 나타나지 않는다.

## 구조

```
                 ┌─ SessionStart 훅 ─→ 핵심 프로필·주요 현안 주입 (프로필 상한 ~2,000 토큰, 매 세션 동일 → 캐시 효율)
Claude Code ─────┼─ UserPromptSubmit 훅 ─→ 관련 기억 자동 검색·주입 (상한 ~2,500 토큰, 세션 안에서 같은 기억은 한 번만) · 새 세션의 첫 질문엔 상황판 · 기능별 알림
(비서 본체)      ├─ Stop 훅 ─→ 대화 원문을 raw_log에 저장 (LLM 토큰 0) · 남은 질문 목록 갱신
                 └─ MCP 도구 ─→ remember / recall / forget / update_profile / set_main_agenda / search_log / …
                                        │
                              secretary.db (단일 파일)
                              ├ profile      핵심 프로필 (버전 관리)
                              ├ main_agenda     주요 현안 (줄마다 이력)
                              ├ memories     기억 (무효화는 valid_to, 덮어쓰지 않음)
                              ├ raw_log      대화 원문 아카이브
                              ├ memory_vectors 의미 검색용 기억 벡터
                              ├ usage_log    주입 토큰 기록
                              └ meta         상황판·남은 질문 등 설정 키·값
```

검색 파이프라인: `FTS5 후보 (무료)` → `재정렬` → `의미 검색 결과와 합치기` → `토큰 예산 패킹`.
재정렬은 `src/memory/recall.ts`의 `Reranker` 인터페이스 뒤에 있어서 확률 판단 모델 같은 다른 재정렬기로 바꿀 수 있다. 의미 검색(아래)은 재정렬과 따로 돌아 결과만 합쳐진다.
한국어는 2글자 단위(bigram)로 색인해서 "서울에서/서울로"처럼 조사가 달라도 찾는다.

**의미 검색:** 단어가 달라도 뜻이 같은 기억을 찾는다("치과 예약" ↔ "이 치료 받으러 가"). 임베딩 모델 BGE-m3-ko(bge-m3를 한국어로 다듬은 모델, 허깅페이스 `jaybon1840/BGE-m3-ko-onnx`, 약 570MB, 이 PC 안에서만 동작)는 불러오는 데 몇 초 걸려서, 작은 의미 검색 서버 프로세스(`src/semantic-search/semantic-search-server.ts`, 띄우기·묻기는 `src/semantic-search/client.ts`)가 모델을 띄워 두고 훅과 MCP 서버가 localhost로 묻는다. 첫 질문이 의미 검색 서버를 백그라운드로 켜고(그 질문은 단어 검색만), 이후 질문부터 의미 검색이 합쳐진다. 자동 주입은 질문만으로 한 검색과, 기록 파일 끝에서 읽은 직전 비서 답을 압축(첫 줄 결론, 질문·선택지 줄, 굵은 소제목. 질문이 없으면 끝 600자)해 질문에 붙인 검색을 함께 보내 합친다("1번으로"처럼 짧은 답도 무엇에 대한 답인지 찾게. 두 번째는 0.02 감점, 5초 넘으면 질문만의 결과, 직전 답은 저장하지 않음). MCP `recall` 도구는 질문만으로 찾는다. 질문 때 의미 검색 서버가 꺼져 있으면 훅이 바로 다시 띄운다(이미 뜨는 중이면 또 띄우지 않는다). 오래 안 써서 스스로 꺼진 것은 조용히 다시 띄우고, 실제 실패(모델을 못 불러옴, 비정상 종료)일 때만 `<secretary-semantic-search-server>` 한 줄로 비서에게 알린다(장애 한 번에 세션마다 한 번). 비서는 사용자에게 알리고 `scripts/semantic-search/watch-semantic-search-server.mjs`로 살아났는지 지켜본다. 장애 중에는 DB 옆 `secretary.db.semantic-search-server-down.json`이 있고, 실패와 회복은 `secretary.db.semantic-search-server-failures.log`에 한 줄씩(시각, 연속 횟수, 원인 단서, 남은 메모리, 오류 첫 줄, 마지막 500줄까지) 남는다. 의미 검색 서버는 새로 저장된 기억의 벡터를 알아서 만든다(켜져 있는 동안 메모리 최대 약 1.5GB). 비서 서버(`remote-server.ps1`)가 떠 있으면 의미 검색 서버도 서버 창에 묶여 계속 떠 있다가 창이 꺼지면 같이 꺼지고, 서버 없이 쓸 때는 60분 동안 요청이 없으면 스스로 꺼진다. 모델은 처음 켤 때 `models/`에 자동으로 받는다(토큰·계정 없이, 1분 남짓). 실패 원인이 모델 파일 없음·깨짐이면 다음 재기동 때 의미 검색 서버가 같은 저장소에서 다시 받아(옆 `.download` 폴더에 받고 허깅페이스의 크기·해시를 확인한 뒤 바꿔 넣음, 장애 한 번에 한 번) 띄운다. 그래도 실패하면 다시 띄우지 않고 "다시 받았는데도 실패, 사용자 확인 필요"를 알리며, 모델 파일이 바뀌거나 `watch-semantic-search-server.mjs --retry`로 다시 시도할 때까지 단어 검색만 쓴다. 원인이 메모리 부족이면 다시 띄우지 않고 멈춰, 의미 검색 서버에 필요한 메모리와 지금 남은 메모리를 알리며 다시 켤지 묻는다. 벡터는 모델 이름별로 저장돼서, 모델이 바뀌면 의미 검색 서버가 켜질 때 옛 벡터를 지우고 기억 전체를 한 번 다시 색인한다. 의미 검색 서버가 준비되지 않았거나 느리면 언제나 단어 검색만으로 동작한다.

### 바깥에서 부르기 (bin/)

비서 폴더 밖(공간 도구·공간 규칙, 사용자 설정의 훅·상태줄, 예약 작업, 바로가기)은 비서 스크립트를 `bin/`의 고정 이름으로만 부른다. 스크립트를 다른 폴더로 옮겨도 바깥은 그대로 두고 `src/core/paths.ts`의 `SCRIPTS`와 그 `bin/` 파일 한 줄만 고친다(`test/entry-points.test.ts`가 둘이 맞는지 본다). 진입점은 받은 인자를 그대로 넘기고 그 종료 코드로 끝난다.

| 진입점 | 실제 스크립트 | 부르는 곳 |
|---|---|---|
| `bin/run-job.ps1` | `scripts/run-job/run-job.ps1` | 공간 도구 |
| `bin/ego-grab.mjs` | `scripts/browser/ego-grab.mjs` | 공간 AGENTS.md, 업무의 grab 스크립트 |
| `bin/usage-guard.mjs`, `bin/usage-statusline.mjs` | `scripts/usage/` | 사용자 설정의 훅·상태줄(`install-usage-guard.mjs`가 적는다) |
| `bin/server-control.ps1`, `bin/backup-db.ps1`, `bin/idle-jobs.ps1` | `scripts/remote-server/`, `scripts/scheduled/` | 예약 작업(`install-scheduled-tasks.ps1`이 등록), 바탕화면 바로가기 |

작업 공간 도구는 비서 진입점 폴더를 공간 맨 위 `secretary-link.local.json`의 `bin`으로 찾는다. 비서가 공간을 만들 때 써 두고(비서의 `bin` 폴더와 비서 고유 번호만 적고 비서 폴더 자체는 적지 않는다. PC마다 달라 공간 git에는 넣지 않는다, `.gitignore`), 업무를 맡길 때마다 맞는지 보고 고친다. 설치 상태 점검이 없거나 어긋난 공간을 알리고 `node src/cli.ts workspace-links`가 한꺼번에 고친다. 그 파일이 없으면 그 비서의 환경변수 `SECRETARY_<번호>_DIR`(번호는 비서 폴더 `.secretary-id`, 대문자, 설치 6번) 아래 `bin`이다(v0.9.0까지의 공간 규칙은 그다음 옛 `SECRETARY_DIR`도 읽었다. `workspace-links`가 새 글로 고친다). 도구에서 찾는 함수(Python·PowerShell·Node)는 비서가 만드는 공간 규칙(`AGENTS.md`)에 들어 있다(원본은 `src/workspace/rules-text.ts`). 업무 세션의 셸 명령은 비서 폴더를 `bin\<이름>` 부르기로만 쓸 수 있다(다른 파일을 열거나 실행하거나 쓰는 명령은 훅이 막는다, `scripts/worker/worker-folder-guard.mjs`). 공간 밖 도구는 환경변수로 찾는다. 예: 번호가 `A3F9`면 PowerShell `& "$env:SECRETARY_A3F9_DIR\bin\run-job.ps1" -Model sonnet …`. 비서 스크립트가 띄우는 것(비서 서버와 그 세션, run-job, 업무 세션)에는 스크립트가 지금 비서 폴더로 넣어 준다(`scripts/lib/common.ps1`). Ego Lite 안의 node(`ego-browser nodejs`)는 환경변수를 받지 못하므로 grab 스크립트에는 `bin/ego-grab.mjs`의 전체 경로를 적는다(공간 AGENTS.md에 적혀 있다).

### 스킬 (.agents/skills/)

비서의 스킬(`delegate`, `consolidate`, `secretary-update`, `feature-toggle` 등)은 맨 위 `.agents/skills/<이름>/SKILL.md`에 실제 폴더로 한 벌만 둔다. Codex와 Antigravity는 이 위치에서 스킬을 찾고, Claude Code가 읽는 `.claude/skills`는 `.agents/skills`로 가는 링크(Windows 디렉터리 정션, 관리자 권한 필요 없음) 하나다. 링크는 `node src/cli.ts skill-links`가 만들고 고친다(`--dry-run`은 보기만, `src/setup/skill-links.ts`). zip·git에는 링크가 들어가지 않아(`.gitignore`) 설치·폴더 옮기기 뒤 한 번 돌린다. 옛 구조(v8까지의 `skills/<이름>/`과 스킬마다의 링크)도 이 명령이 `.agents/skills/`로 옮긴다. 같은 이름이 이미 있으면 명령은 지우거나 합치지 않고 알리기만 한다. 설치 상태 점검의 '스킬' 항목이 빠지거나 어긋난 것을 알린다. 사용자가 직접 만드는 스킬도 `.agents/skills/<이름>/`에 둔다. 작업 공간도 같은 구조이고, 공간의 링크는 `node src/cli.ts workspace-links`가 만든다.

### scripts/

영역별 폴더로 나뉜다. `scripts/update.mjs`와 `scripts/update-moves.json`은 옛 버전의 업데이트가 받은 저장소에서 이 위치를 부르므로 맨 위에 둔다.

| 파일 | 하는 일 |
|---|---|
| `update.mjs` | 업데이트 도우미(`secretary-update` 스킬이 받은 최신판에서 부른다). 폴더 사본 백업, 받았던 버전 판별(`VERSION`, 없으면 파일 목록 `release-files.json`. v7부터 올린다. tag는 번호로 줄 세우고 옛 v1~v8은 0.1.0~0.8.0으로 본다), 사용자가 고친 파일 찾기(받았던 버전 tag와 비교, 파일 목록이 있으면 그 해시로도), 옮겨진 파일 따라가기, `git merge-file` 3방향 합친 안 만들기. 둘 다 고친 파일은 사용자 파일을 그대로 두고 유지·덮어쓰기·섞기 후보를 `backups/update-<날짜>/`에 둔다(`resolve`로 정함, `--rest`면 남은 것을 추천대로). 기억 DB·모델·`node_modules`·`*.local.*`·`backups`는 건드리지 않는다 |
| `update-moves.json` | 버전마다 옮겨진 파일(옛 위치 → 새 위치). `update.mjs`가 읽는다 |
| `lib/common.ps1` | 다른 스크립트가 dot-source 하는 공용 함수 (비서 폴더 위치, 앱 환경변수 정리, 로그인 확인, `~/.secretary`·비서 기록 폴더(`<번호>/state`)·사용량 폴더, 한국시간·UTF-8 쓰기, 캐시 기준 55분, 세션 재사용(resume) 기준 55분·20만 토큰) |
| `lib/providers.ps1`, `lib/providers.json` | 공급자를 골라 환경을 넣는 공용 함수와 공급자 목록(처음엔 이 PC의 구독 `subscription` 하나, 다른 공급자는 기능을 켤 때 넣는다) |
| `lib/memory-mcp.ps1` | 업무 세션·`run-job.ps1`에 비서 기억 MCP(구독이면 읽기 전용)를 붙이는 공용 함수 |
| `lib/detached-job.ps1` | 오래 걸릴 수 있는 `run-job`을 `-Detach`로 따로 띄우는 공용 함수(기다리기는 `run-job/wait-job.ps1`) |
| `remote-server/remote-server.ps1` | 비서 폴더에서 Remote Control 서버를 띄우고, 끝나면 다시 띄움. 서버가 연 세션은 이 PC의 크롬(Claude in Chrome)을 쓴다(`CLAUDE_CODE_ENABLE_CFC=1`). 시작 전에 `bridge-pointer.json`을 지워 보관된 옛 세션을 다시 붙잡지 않게 한다 |
| `remote-server/server-control.ps1` | 비서 서버 다시 켜기(`-Action restart`, 일회용 예약 작업이 몇 초 뒤 실행, `-Visible`이면 창이 보이게), 창 보이기·숨기기(`show`/`hide`), 기록 끝부분 보기(`log`) |
| `remote-server/server-lib.ps1`, `remote-server/windows-toast.ps1` | 서버 스크립트의 공용 함수(서버 창 찾기, 기록 폴더), Windows 알림 띄우기 |
| `scheduled/install-scheduled-tasks.ps1` | 예약 작업 등록(`-Task`로 고름, 안 주면 셋 다, 작업 이름은 `features.json`): `server` 로그인할 때 비서 서버를 숨긴 창으로(관리자), `backup` 매일 22:30(`-At`) `backup-db.ps1`, `idle-jobs` 5분마다(`-EveryMinutes`) `idle-jobs.ps1`. 꺼진 기능의 작업은 건너뜀. 같은 이름의 작업이 이 PC의 다른 비서 것이면 덮어쓰지 않고 건너뜀(`-TakeOver`로만 가져옴). `-DryRun`은 등록 없이 내용만 찍음 |
| `scheduled/idle-jobs.ps1` | 쉬는 시간 작업을 한 번 돌리고 출력 한 줄을 `idle-jobs.log`에 붙인다 |
| `scheduled/backup-db.ps1` | 기억 DB를 `backups/`에 백업하고 14일 지난 것을 지운다 |
| `worker/start-worker.ps1` | 업무 세션을 백그라운드(`claude --bg`)로 시작. 브라우저가 필요한 업무는 `-Chrome`, 테스트 잠금 업무는 `-LockTests`. 같은 공간의 idle(대기) 세션이 55분 안·컨텍스트 20만 토큰 미만이면 새 업무를 그 세션에 보내 재사용한다(`-New`면 새로 시작) |
| `worker/worker-done.ps1` | 업무가 끝난 업무 세션을 바로 끄지 않고 쉬는 세션으로 적어 둔다. 55분 안에 재사용되지 않으면 뒤에서 끈다(`-Stop`이면 바로 끔) |
| `worker/watch-worker.ps1` | 백그라운드 업무 세션이 승인 창에 멈췄는지, 쉬는지, busy인 채 멈췄는지(출력 변화도 자식 명령의 CPU 움직임도 없이 10분) 토큰 없이 지켜보다가 그때만 끝나며 비서를 깨운다. 55분이면 끝나고 비서가 다시 띄운다 |
| `worker/worker-lib.ps1` | 업무 세션 다루기(시작·메시지·출력·끝내기, 재사용 상태)의 실제 코드. `start-worker`·`send-worker`·`worker-logs`·`worker-done`은 이름·인자를 그대로 둔 진입점이다 |
| `worker/worker-folder-guard.mjs` | 업무 세션 훅: 공간 폴더 밖 쓰기, `git push`, 게시·업로드, 폴더 통째 삭제(테스트 잠금이면 테스트 파일 수정도)를 막는다 |
| `worker/worker-permissions.json`, `worker/trust-folder.mjs`, `worker/worker-logs.ps1`, `worker/send-worker.ps1` | 업무 세션 허용 목록, 공간 폴더를 '신뢰함'으로 적기, 업무 세션 출력 보기, 다른 설정 폴더의 업무 세션에 메시지 넣기 |
| `run-job/run-job.ps1` | 비싼 작업을 빈 세션(`claude -p`)에서 한 번 돌리고 결과 글만 받기. 모델(`-Model`)은 필수. `-Folder`가 없으면 비서 폴더 옆 `workspaces\_run-job-home`에서 돈다. 같은 폴더·모델의 마지막 세션을 55분 안·컨텍스트 20만 토큰 미만이면 재사용한다(resume, `-New`/`-Resume <id>`). 사용자 설정의 MCP는 붙이지 않고, 필요한 MCP만 `-McpConfig <파일>`로 붙인다. `-Staff <담당자>`는 반복 일 담당자(`memory-consolidation` 기억 정리, `situation-board` 상황판)로 돌린다: 공급자·모델·추론 수준(effort)·허용 도구를 `src/staff/<담당자>.json` 한 곳에서 읽고 `workspaces\_staff\<담당자>`에서 돌며, 같은 값을 따로 주면 오류다 |
| `run-job/wait-job.ps1`, `run-job/run-job-stats.ps1`, `run-job/run-job-other-cli.ps1` | `-Detach`로 띄운 일 55분씩 기다리기, 호출 기록 요약, 다른 회사 CLI 실행(기능 `external-providers`) |
| `usage/usage-query.ps1` | 구독 사용량을 토큰 없이 조회(`claude -p "/usage"`, 5시간·주간)해 `~/.secretary/usage/subscription-<계정>.json`(계정은 그 공급자 로그인의 메일 @ 앞, 공급자가 달라도 계정이 같으면 같은 파일, 계정이 없는 공급자는 `<공급자>.json`)에 저장. 사용량 조회기(기능 `usage-poll`, `node src/cli.ts usage-poll`, 비서 서버가 같이 띄움)가 5분마다 부르고, 정지 훅은 기록이 5분 넘게 오래되면 예비로 뒤에서 띄운다. 사용량을 못 읽으면(API 키 로그인처럼 `/usage`가 사용량을 주지 않을 때, claude가 없을 때) `<같은 이름>.fail`에 잇따른 실패 횟수를 적고, 조회기·정지 훅은 다음 조회를 5분부터 두 배씩 최대 6시간 미룬다(읽히면 지운다). |
| `usage/install-usage-guard.mjs`, `usage/usage-guard.mjs`, `usage/usage-statusline.mjs`, `usage/usage-file.mjs` | 사용량 일시 정지 장치를 사용자 설정에 등록, 정지 PreToolUse 훅, 상태줄 프로그램, 사용량 기록 파일 위치 |
| `browser/ego-grab.mjs`, `browser/open-chrome.ps1` | (Ego Lite가 있을 때) 연 웹 페이지 본문을 근거 txt로 저장, 브라우저 작업용 크롬 프로필 창을 이름으로 열기 |
| `semantic-search/watch-semantic-search-server.mjs` | 의미 검색 서버가 살아났는지 AI 없이 지켜보다가 살아나면 끝나며 비서를 깨운다. `--retry`는 멈춘 것을 한 번 더 시도한다 |

### src/

영역별 폴더로 나뉜다. 진입점은 `cli.ts`(훅·명령줄)와 `mcp/server.ts`(기억 MCP 서버)다.

| 폴더 | 하는 일 |
|---|---|
| `core/` | 바탕: 폴더·DB 위치와 예산(`config.ts`), 스크립트 경로표와 `~/.secretary`(비서 번호별 기록 `<번호>/logs`·`<번호>/state`)·`~/.secretary/usage`(계정별 사용량)(`paths.ts`), 옛 공용 기록 옮기기(`state-dir-migrate.ts`), JSON 읽기, 프로세스, 토큰 어림, 한국시간 표시, 키 가리기, 계정 설정 폴더 |
| `store/` | 기억 DB: 스키마·이전(`schema.ts`), 진입점 `Store`(`store.ts`)와 갈래별 읽기·쓰기(기억, 대화 기록, 주요 현안, 공간·업무, meta·사용량) |
| `memory/` | 기억 찾기와 지키기: 검색(`recall.ts`), 한국어 검색어, 중복 확인, 주입 문구 거르기, 앞 답을 더한 검색, 정리 결과 알림 |
| `log/` | 대화 기록: 대화 파일 저장, 놓친 대화 따라잡기, "비서 대화 삭제"(`purge.ts`), 되감기 정리(`rewind.ts`) |
| `semantic-search/` | 의미 검색: 띄우기·묻기(`client.ts`), 이름·파일 위치, 장애 기록·알림, 의미 검색 서버 프로세스 |
| `mcp/` | 기억 MCP 서버와 도구(기억, 주요 현안, 위임) |
| `hooks/` | 훅: 훅 실행(`run-hook.ts`), 세션 시작 글, 질문마다 붙는 알림 목록(`prompt-notices.ts`)과 기억 주입·보낸 쪽 구분·컨텍스트 크기 알림 |
| `board/` | 상황판, 새 세션에 주는 글, 세션 이관, 남은 질문 |
| `idle/` | 쉬는 시간 작업, 뒤에서 도는 일 기록, run-job 부르기 |
| `usage/` | 사용량 파일, 사용량 조회기와 조회할 공급자 고르기(기능 `usage-poll`, `this-secretary.local.json`의 `usage-poll` 키), 일을 보낼 구독 고르기와 질문마다 붙는 사용량 줄(기능 `multi-subscription`), "90% 넘어도 진행" 풀기 |
| `workspace/` | 작업 공간 폴더·규칙 글, 돌고 있는 업무의 모니터링 확인 |
| `setup/` | 설치 상태 점검(`setup-check.ts`, 항목 `check-items.ts`, Windows 조회), 기능 목록(`features.ts`), 한 PC의 다른 비서 설정 가리기(`other-secretaries.ts`), 배포판 파일 목록 `release-files.json` 읽기(`release-files.ts`), 스킬 링크(`skill-links.ts`) |
| `upgrade/` | 버전을 올릴 때 한 번 하는 옮기기(v7에서: 프로필의 큰 일 항목 → 주요 현안, `node src/cli.ts main-agenda-from-profile`) |

### 개발

```bash
npm test                    # 테스트
npm run typecheck           # 타입 검사
node src/cli.ts memory-stats # 현황
node src/cli.ts setup-check # 설치 상태 점검 (세션 시작 안내와 같은 결과, 안 쓸 항목은 --skip <id>)
node src/cli.ts skill-links # 스킬 위치 고치기 (.claude/skills → .agents/skills 링크, 옛 skills/ 옮기기, --dry-run은 보기만)
node src/cli.ts db-backup   # backups/ 에 스냅샷 (VACUUM INTO)
```

## 설정 (환경변수)

| 변수 | 기본 | 의미 |
|---|---|---|
| `SECRETARY_<번호>_DIR` | (설치 6번에서 등록) | 비서 폴더. 번호는 이 비서의 고유 번호(`.secretary-id`, 대문자). 비서 폴더 밖 도구가 `bin/`을 찾는 데 쓴다(작업 공간 도구는 공간의 `secretary-link.local.json`을 먼저 본다). 번호 없는 옛 `SECRETARY_DIR`은 v7에서 올라온 PC에서 바깥 도구를 옮기는 동안만 남긴다 |
| `SECRETARY_DB` | `./secretary.db` | DB 파일 경로 |
| `SECRETARY_WORKSPACE_ROOT` | 비서 폴더 옆 `workspaces` | 위임 업무 폴더를 만들 위치 |
| `SECRETARY_KEYS_DIR` | `%USERPROFILE%\.secretary\keys` | 키 파일 폴더(다른 공급자를 켤 때) |
| `SECRETARY_PROFILE_MAX_TOKENS` | 2000 | 프로필 상한 |
| `SECRETARY_AUTO_RECALL_TOKENS` | 2500 | 매 턴 자동 주입 상한 |
| `SECRETARY_RECALL_TOKENS` | 4000 | `recall` 도구 기본 예산 |
| `SECRETARY_TZ` | `Asia/Seoul` | 시각을 보여 줄 시간대 (저장은 항상 UTC) |
| `SECRETARY_SEMANTIC_SEARCH` | (켜짐) | `off`면 의미 검색을 끄고 단어 검색만 쓴다 |
| `SECRETARY_SETUP_CHECK` | (켜짐) | `off`면 세션 시작 설치 상태 점검과 질문마다의 알림을 끈다 |
| `SECRETARY_SEMANTIC_SEARCH_IDLE_MIN`(옛 이름 `SECRETARY_EMBED_IDLE_MIN`도 읽음) | 60 | 비서 서버가 꺼져 있을 때 켜진 의미 검색 서버가 요청 없이 기다리다 꺼지는 시간(분). 비서 서버가 떠 있으면 의미 검색 서버는 비서 서버와 함께 계속 떠 있다가 서버가 꺼지면 따라 꺼진다(이 값은 쓰이지 않는다) |
| `SECRETARY_SEMANTIC_SEARCH_MODEL_DIR`(옛 이름 `SECRETARY_EMBED_MODEL_DIR`도 읽음) | `./models` | 임베딩 모델 파일을 받아 두고 찾는 폴더 |
| `SECRETARY_SEMANTIC_SEARCH_MODEL_REPO`(옛 이름 `SECRETARY_EMBED_MODEL_REPO`도 읽음) | `jaybon1840/BGE-m3-ko-onnx` | 모델 파일이 없거나 깨졌을 때 다시 받는 허깅페이스 저장소 |

## 옛 버전에서 갈아타기

기억(`secretary.db`), 검색 모델, 작업 공간은 그대로 이어 쓴다. 버전마다 바뀐 것과 올린 뒤 할 일은 [`CHANGES.md`](CHANGES.md)에 있다(v0.10.0에서 v0.11.0으로 올리면 기억 정리 판정을 프로그램이 실행하고 보고 개수를 프로그램이 세기, 결정 기억의 원문 발췌, 상황판의 미정 줄에 결정 대조, 답변 검사 새 항목(근거 출처·보고 전달·지어낸 말·딸린 질문), 훅 안내문 글 파일(`.agents/hook-notices/`), 의미 검색 기다리기와 실패 기록, 주요 현안·상황판 칸 이름 정리, 규칙(`AGENTS.md`) 다시 쓰기, 업무 검수 대기 없앰, 공급자 개인정보 값(`personalDataAllowed`)과 그 값이 빠진 공급자를 알리는 설치 상태 점검, 작업 공간 규칙의 비서 관리 부분 표시가 들어온다. 업데이트 끝에 프로그램이 작업 공간 규칙 옮기기(`workspace-links`)와 Claude 구독 공급자의 개인정보 값 넣기를 하고, features.json에서 사용자가 켜고 끈 기능은 업데이트 뒤에도 그대로다. 올린 뒤 할 일은 구독이 아닌 공급자의 개인정보 값 정하기와 프로그램이 못 고친 작업 공간 정하기(둘 다 해당 있을 때만), 마지막으로 새 세션 열기다. v0.9.0에서 v0.10.0으로 올리면 반복 일 담당자(기억 정리·상황판), 호칭 설정, 이 비서 설정 한 파일(`this-secretary.local.json`), 스킬 사양(agentskills.io)과 공통 스킬 이름 `common-<이름>`, 보조 폴더 이름(`_run-job-home`·`_archived`·`_staff`), 스킬·기능·명령·폴더 이름 정리가 들어온다. 옮겨진 파일과 이 PC 파일·기능 이름은 업데이트가 따라가고, 올린 뒤 할 일은 보조 폴더 옮기기, 공통 스킬 이름 맞추기, ntfy 서버 예약 작업 이름 옮기기(끝 알림을 켠 사용자만), 이 비서 설정 옮기기 확인, 남은 옛 이름 파일을 지울지 묻기 다섯 가지다. v8에서 v0.9.0으로 올리면 다중 구독(일을 보낼 구독 여럿), 지시서 대조가 공간 스킬 규칙·관련 높은 기억 위 10개를 보여 줌, 질문 알파벳 세기 고침, 새 작업 공간 `.gitignore`의 큰 영상·소리 파일 줄이 들어오고 작업 공간 zip 묶기는 빠진다. 올린 뒤 할 일은 영상·소리를 다루는 기존 공간의 `.gitignore`에 같은 줄을 넣을지 묻는 것 하나다. v7에서 v8로 올리면 예약 작업을 번호 붙은 새 이름으로 다시 등록, 사용량 정지 장치 다시 등록, `SECRETARY_<번호>_DIR` 등록, 주요 현안 옮기기, 스킬 위치 확인이 있다. 스킬은 업데이트가 `.claude/skills/`에서 `.agents/skills/`로 옮기고 `.claude/skills`를 그리로 가는 링크로 만든다).

- **v7 이상:** 비서에게 "업데이트 확인해 줘"라고 한다(업데이트는 v7부터 올린다. v7·v8·v0.9.0·v0.10.0에서 v0.11.0으로 바로 올라간다). 비서가 백업하고 최신판을 받아 사용자가 고친 파일을 지키며 얹고, 둘 다 고친 파일은 파일마다 묻고, `CHANGES.md`의 "올린 뒤 할 일"을 함께 한다.
- **최신판 받기가 막히면:** Claude Code 자동 모드에서는 비서의 저장소 받기(`git clone`)가 막힐 수 있다(v7의 업데이트에서 실제로 막혔다). 같은 명령을 다시 시키지 말고 PowerShell 창에서 직접 `git clone https://github.com/jaybon1/secretary-general "$env:TEMP\secretary-update"`로 받은 뒤(이미 있는 폴더면 이름 끝을 바꾼다), 비서에게 받은 폴더의 실제 경로와 함께 "최신판을 이 폴더에 받아 뒀어. 그걸로 업데이트해 줘"라고 한다.
- **사용자가 직접 바꾸기(고친 곳이 없을 때만):** 비서 세션과 비서 서버를 모두 끄고(자동 시작을 쓰면 작업 스케줄러에서 'Secretary Remote Control'로 시작하는 작업을 **사용 안 함**으로 두고 PC를 다시 켠다), `secretary.db`와 `backups/`를 안전한 곳에 한 부 복사한 뒤, 옛 폴더에서 `secretary.db`·`backups/`·`node_modules/`·`models/`만 남기고 나머지를 새 zip의 파일로 바꾼다. 그 폴더에서 `npm install`과 `node src/cli.ts skill-links`(스킬 링크, 옛 버전의 `.claude/skills/`에 사용자가 고치거나 만든 스킬이 있었으면 먼저 `skills/`로 옮긴다) 뒤 `CHANGES.md`의 "올린 뒤 할 일"을 한다. 고친 파일은 새 파일로 덮이므로 고친 곳은 직접 다시 넣는다.

## 개인 데이터

`secretary.db`(기억·대화 원문)와 `backups/`는 이 PC에만 둔다. 이 폴더를 남에게 줄 때는 이 두 가지와 이 비서의 고유 번호 파일 `.secretary-id`를 빼고 준다(`.gitignore`에 들어 있다. 번호 파일을 함께 주면 받은 쪽 비서가 같은 번호가 되어, 한 PC에 둘 다 있을 때 이 비서의 옛 사본으로 보인다).
