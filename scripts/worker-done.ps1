# 업무 세션이 업무를 끝냈다고 상태 파일(~/.claude/usage/worker-sessions.json)에 적는다. 세션은 바로 끄지 않고 쉬게 둔다.
# 55분 안에 같은 공간의 다음 업무가 오면 start-worker.ps1이 그 세션을 이어 쓴다. 안 오면 뒤에서 띄운 이 스크립트가
# 55분 뒤 그동안 재사용되지 않았는지(업무 끝난 시각이 그대로인지) 보고 claude stop으로 끈다. AI를 부르지 않아 토큰이 들지 않는다.
# 상태 파일에 없는 세션(start-worker.ps1 밖에서 띄운 세션)과 -Stop을 주면 바로 끈다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker-done.ps1 -Id <짧은 id> [-Stop]
# (-StopAfter <업무 끝난 시각>은 스스로를 뒤에서 띄울 때만 쓴다.)

param(
  [Parameter(Mandatory)] [string]$Id,
  [switch]$Stop,
  [string]$StopAfter,
  [int]$IdleMinutes = 55
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\claude-env.ps1"
. "$PSScriptRoot\providers.ps1"
$null = Use-Utf8Console
Clear-HostClaudeEnv
$claude = Get-ClaudeExe
$Id = $Id -replace '^bg:', ''

function Stop-Worker([string]$WorkerId) {
  try { & $claude stop $WorkerId *> $null } catch {}
}

$state = Read-WorkerState
$entry = $state.PSObject.Properties[$Id].Value

# 뒤에서 띄운 끄기 대기: 정해진 시간 뒤 업무 끝난 시각이 그대로면(재사용되지 않았으면) 끈다.
if ($StopAfter) {
  Start-Sleep -Seconds ($IdleMinutes * 60)
  $state = Read-WorkerState
  $entry = $state.PSObject.Properties[$Id].Value
  if (-not $entry -or "$($entry.done_at)" -ne $StopAfter) { exit 0 }
  Stop-Worker $Id
  $state.PSObject.Properties.Remove($Id)
  Save-WorkerState $state
  Add-WorkerReuseLog ([ordered]@{ at = [DateTime]::UtcNow.ToString('o'); event = 'idle_stop'; folder = $entry.folder; name = $entry.name; id = $Id; tasks = $entry.tasks })
  exit 0
}

if (-not $entry -or $Stop) {
  Stop-Worker $Id
  if ($entry) { $state.PSObject.Properties.Remove($Id); Save-WorkerState $state }
  Write-Output "껐어요: $Id$(if (-not $Stop) { ' (상태 파일에 없는 세션이라 바로 껐어요)' })"
  exit 0
}

$alive = (& $claude agents --json | ConvertFrom-Json) | Where-Object { $_.id -eq $Id } | Select-Object -First 1
if (-not $alive) {
  $state.PSObject.Properties.Remove($Id)
  Save-WorkerState $state
  Write-Output "업무 세션 $Id 이(가) 이미 목록에 없어요. 상태 파일에서 지웠어요."
  exit 0
}
$now = [DateTime]::UtcNow
$doneAt = $now.ToString('o')
$context = Get-SessionContext (Get-ClaudeConfigDir) $alive.sessionId
# 이어 쓸 수 없는 세션(문맥 8만 토큰 이상이거나 기록을 못 찾음)은 기다리지 않고 바로 끈다.
if ($null -eq $context -or $context -ge 80000) {
  Stop-Worker $Id
  $state.PSObject.Properties.Remove($Id)
  Save-WorkerState $state
  Add-WorkerReuseLog ([ordered]@{ at = $doneAt; event = 'done_stop'; folder = $entry.folder; name = $entry.name; id = $Id; tasks = $entry.tasks; context = $context })
  Write-Output "껐어요: $Id (문맥 $(if ($null -eq $context) { '모름' } else { "$context 토큰" })이라 이어 쓰지 않아요)."
  exit 0
}
$entry.done_at = $doneAt
$entry | Add-Member -NotePropertyName context -NotePropertyValue $context -Force
Save-WorkerState $state

# 이 스크립트를 부른 쪽(비서의 명령)이 끝나면 자식 프로세스도 정리되므로, WMI로 부모와 상관없는 프로세스를 만든다.
$cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Id $Id -StopAfter $doneAt -IdleMinutes $IdleMinutes"
$null = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
$kst = [TimeZoneInfo]::FindSystemTimeZoneById('Korea Standard Time')
$stopAt = [TimeZoneInfo]::ConvertTimeFromUtc($now.AddMinutes($IdleMinutes), $kst).ToString('HH:mm')
Write-Output "업무 끝 표시: $Id (문맥 $context 토큰). ${IdleMinutes}분 안에 같은 공간의 다음 업무가 오면 이어 쓰고, 아니면 $stopAt(KST)에 꺼져요."
