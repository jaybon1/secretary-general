# 백그라운드 업무 세션(start-worker.ps1로 시작한 것)의 출력을 보여 준다.
# 데스크톱 앱 세션 안에서 바로 "claude logs"를 부르면 앱 전용 환경변수가 따라가므로 지우고 실행한다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker/worker-logs.ps1 -Id <짧은 id>

param(
  [Parameter(Mandatory)] [string]$Id
)
$ErrorActionPreference = 'Stop'

# 실제 일은 worker-lib.ps1에 있다(입구만 이 파일, 권한 허용 목록이 스크립트 이름으로 구분한다).
. "$PSScriptRoot\worker-lib.ps1"
Show-WorkerLogs @PSBoundParameters
