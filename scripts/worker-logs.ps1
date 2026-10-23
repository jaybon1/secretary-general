# 백그라운드 업무 세션(start-worker.ps1로 시작한 것)의 출력을 보여 준다.
# 데스크톱 앱 세션 안에서 바로 "claude logs"를 부르면 앱 전용 환경변수가 따라가므로 지우고 실행한다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker-logs.ps1 -Id <짧은 id>

param(
  [Parameter(Mandatory)] [string]$Id
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\claude-env.ps1"
$null = Use-Utf8Console
Clear-HostClaudeEnv
$claude = Get-ClaudeExe

& $claude logs ($Id -replace '^bg:', '')
exit $LASTEXITCODE
