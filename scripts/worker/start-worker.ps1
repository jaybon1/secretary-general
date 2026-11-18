# 업무 세션을 백그라운드 Claude Code 세션(claude --bg)으로 시작한다.
# 데스크톱 앱의 start_session을 쓸 수 없을 때(원격으로 받은 지시, 앱이 아닌 세션) 쓰는 대체 경로.
# 업무 세션은 공급자와 상관없이 Remote Control에 붙이지 않아 다른 기기의 세션 목록에 나타나지 않는다(2026-10-23 결정).
# 진행(쉼·[질문]·끝남)은 비서가 watch-worker.ps1 하나로 받아 전하고, 업무 세션에 보내는 글은 늘 send-worker.ps1로 보낸다.
# 출력 끝의 "backgrounded · <짧은 id> · <이름>"에서 id를 session_ref로 기록한다. 출력 보기: worker-logs.ps1
# 재사용: 같은 공간·공급자의 업무 세션이 업무를 끝낸 지(worker-done.ps1) 55분 안이고 마지막 컨텍스트가 20만 토큰 미만이며
# 모델·추론 수준(effort)·-Chrome·-LockTests가 같으면, 새 세션 대신 그 세션에 새 업무를 보내고 "재사용: <id> · <이름>"을 낸다.
# 조건이 안 맞으면 그 세션을 끄고 새로 띄운다. -New면 무조건 새로 시작. 판단은 이 비서의 기록 폴더(~/.secretary/<비서 번호>/state)의 worker-reuse.jsonl에 쌓는다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker/start-worker.ps1 -Folder <공간 폴더> -Name <업무이름> (-PromptFile <UTF-8 파일> | -Prompt <한 줄 지시>) [-Provider <이름>] [-Effort <low|medium|high|xhigh|max>] [-Chrome] [-LockTests] [-New]
# -PromptFile: 지시를 원문 그대로 메시지 파일(임시 폴더 secretary-worker-messages\)에 옮기고 업무 세션에는 그 파일을 읽으라는 한 줄만 넘긴다.
#   -Prompt는 큰따옴표가 작은따옴표로, 줄바꿈이 공백으로 바뀌므로 짧은 한 줄 지시에만 쓴다.
# 개인정보를 보내지 않는 공급자면 지시와 거기 적힌 TASK.md에 사용자 호칭·기억/대화 번호·다른 작업 공간 이름이 있을 때 띄우지 않고 멈춘다(delegate-check private).
# -Effort: 추론 수준(effort). 안 주면 공간 .claude/settings.json의 effortLevel, 그다음 공급자의 effort, 없으면 Claude Code 기본값.
# -Provider: scripts/lib/providers.json의 공급자 이름. 안 주면 그 파일의 default.
# -Chrome: 브라우저가 필요한 업무만. 이 PC의 크롬(Claude in Chrome)을 연결한다.
# -LockTests: TASK.md에 "테스트 잠금: 예"인 업무만. 테스트 파일 수정을 훅으로 막는다.
# -DryRun: 세션을 띄우지 않고 공급자와 MCP 인자만 찍는다(테스트용).
# 개인정보를 보내도 되는 공급자(providers.json의 personalDataAllowed)면 비서 기억 읽기 도구(recall·search_log)를 붙이고, 아니면 붙이지 않는다.

param(
  [Parameter(Mandatory)] [string]$Folder,
  [Parameter(Mandatory)] [string]$Name,
  [string]$Prompt,
  [string]$PromptFile,
  [string]$Provider,
  [string]$Effort,
  [switch]$Chrome,
  [switch]$LockTests,
  [switch]$New,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

# 실제 일은 worker-lib.ps1에 있다(진입점만 이 파일, 권한 허용 목록이 스크립트 이름으로 구분한다).
. "$PSScriptRoot\worker-lib.ps1"
Start-Worker @PSBoundParameters
