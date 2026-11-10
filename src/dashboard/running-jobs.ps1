# 읽기 전용: 살아 있는 업무 세션(claude.exe --session-id), PowerShell 프로세스(run-job), Secretary* 예약 작업을 JSON 한 덩어리로 낸다.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
function Iso($d) { if ($d -and $d.Year -gt 2001) { $d.ToUniversalTime().ToString('o') } else { $null } }
$sessions = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object {
  # id 뽑기는 collect.ts의 sessionIdOf가 한다(--session-id 외에 --resume으로 재개된 세션도 있어서).
  if ($_.CommandLine -match '--session-id|--resume|--bg-pty-host') { @{ pid = $_.ProcessId; cmd = $_.CommandLine } }
})
# run-job.ps1을 돌리는 PowerShell 프로세스(run-job-active\<PID>.json의 pid)와 시작 시각. collect.ts runJobsActive가 그 기록의 started_at과 견줘
# 꺼진 run-job의 기록(PID가 없거나 뒤에 다른 프로세스가 그 PID를 받음)을 가린다. at은 이 목록을 뜬 시각: 그 뒤에 시작한 run-job은 목록에 없을 수 있다.
$procsAt = [DateTime]::UtcNow.ToString('o')
$procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | ForEach-Object { @{ pid = $_.ProcessId; started = (Iso $_.CreationDate) } })
$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Secretary*' } | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  @{ name = $_.TaskName; state = "$($_.State)"; next = (Iso $i.NextRunTime); last = (Iso $i.LastRunTime); result = [int64]$i.LastTaskResult }
})
@{ sessions = $sessions; procs = @{ at = $procsAt; list = $procs }; tasks = $tasks } | ConvertTo-Json -Depth 4 -Compress
