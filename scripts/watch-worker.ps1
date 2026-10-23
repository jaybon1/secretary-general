# 백그라운드 업무 세션이 승인 창에 멈췄는지, 일을 마치고 쉬는지 지켜본다. AI를 부르지 않는 단순 반복 확인이라 기다리는 동안 토큰이 들지 않는다.
# 비서가 백그라운드 명령으로 띄워 두면, 멈춤·쉼을 찾거나 세션이 끝났을 때만 이 스크립트가 끝나며 비서를 깨운다.
# SendMessage notify_when_idle이 닿지 않는 경우(ListAgents에 없는 세션)에도 쉬는 상태를 알 수 있게 여기서도 본다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/watch-worker.ps1 -Id <짧은 id> [-IntervalSec 120] [-MaxMinutes 240]

param(
  [Parameter(Mandatory)] [string]$Id,
  [int]$IntervalSec = 120,
  [int]$MaxMinutes = 240
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\claude-env.ps1"
$null = Use-Utf8Console
Clear-HostClaudeEnv
$claude = Get-ClaudeExe
$Id = $Id -replace '^bg:', ''
$deadline = (Get-Date).AddMinutes($MaxMinutes)

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $IntervalSec
  $alive = (& $claude agents --json | ConvertFrom-Json) | Where-Object { $_.sessionId -like "$Id*" -or $_.id -like "$Id*" } | Select-Object -First 1
  if (-not $alive) { Write-Output "종료: 업무 세션 $Id 이(가) 목록에 없어요."; exit 0 }
  $tail = (& $claude logs $Id 2>$null | Select-Object -Last 30) -join "`n" -replace '\x1b\[[0-9;?]*[A-Za-z]', ''
  if ($tail -match 'Do you want to proceed|requires approval') {
    Write-Output "승인 대기: 업무 세션 $Id 이(가) 승인 창에 멈췄어요. 마지막 출력:"
    Write-Output ($tail -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 15)
    exit 0
  }
  if ($alive.status -ne 'busy') {
    Write-Output "쉼: 업무 세션 $Id 이(가) 턴을 끝냈어요(status=$($alive.status), state=$($alive.state)). [질문]인지 완료인지 worker-logs.ps1로 확인하세요."
    exit 0
  }
}
Write-Output "시간 초과: $MaxMinutes 분 동안 멈춤이 없었어요. 감시를 끝내요."
