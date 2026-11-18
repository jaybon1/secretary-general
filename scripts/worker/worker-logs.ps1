# 백그라운드 업무 세션(start-worker.ps1로 시작한 것)의 마지막 답을 대화 기록(jsonl)에서 원문 그대로 보여 준다.
# -Screen이면 예전처럼 claude logs 화면 출력을 보여 준다(기록을 못 읽을 때도 그렇다고 한 줄 알리고 화면 출력으로 돌아간다).
# 데스크톱 앱 세션 안에서 바로 "claude logs"를 부르면 앱 전용 환경변수가 따라가므로 지우고 실행한다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker/worker-logs.ps1 -Id <짧은 id> [-Screen]

param(
  [Parameter(Mandatory)] [string]$Id,
  [switch]$Screen
)
$ErrorActionPreference = 'Stop'

# 실제 일은 worker-lib.ps1에 있다(진입점만 이 파일, 권한 허용 목록이 스크립트 이름으로 구분한다).
. "$PSScriptRoot\worker-lib.ps1"
Show-WorkerLogs @PSBoundParameters
