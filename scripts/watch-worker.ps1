# 백그라운드 업무 세션이 승인 창에 멈췄는지, 일을 마치고 쉬는지, busy인 채로 멈췄는지 지켜본다. AI를 부르지 않는 단순 반복 확인이라 기다리는 동안 토큰이 들지 않는다.
# 비서가 백그라운드 명령으로 띄워 두면, 멈춤·쉼을 찾거나 세션이 끝났을 때만 이 스크립트가 끝나며 비서를 깨운다.
# SendMessage notify_when_idle이 닿지 않는 경우(ListAgents에 없는 세션)에도 쉬는 상태를 알 수 있게 여기서도 본다.
#
# 멈춤 판정: status가 busy인데 claude logs 끝부분(시계·경과 시간·사용률 줄을 뺀 것)이 바뀌지 않으면, 업무 세션 프로세스 아래
# 자식 명령(powershell, node, python, ffmpeg 등)의 CPU 시간이 늘었는지 AI 없이 본다. 늘었으면 일하는 중으로 보고 기다린다.
# 출력 변화도 움직임도 없는 상태가 -StallMinutes(기본 10분) 이어질 때만 "멈춘 듯: ..."과 근거를 내고 끝낸다.
# 비서의 백그라운드 명령은 최대 2시간(7200000ms)이라 기본 -MaxMinutes는 120이고, 그 전에 끝나도록 마지막 확인 시간(90초)을 남긴다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/watch-worker.ps1 -Id <짧은 id> [-IntervalSec 120] [-MaxMinutes 120] [-StallMinutes 10]

param(
  [Parameter(Mandatory)] [string]$Id,
  [int]$IntervalSec = 120,
  [int]$MaxMinutes = 120,
  [int]$StallMinutes = 10,
  # 이 PC 자식 명령이 확인 간격 동안 이만큼(초) 넘게 CPU를 쓰면 움직임으로 본다.
  [double]$ChildCpuSec = 1
)
$ErrorActionPreference = 'Stop'
$started = Get-Date

# ---- 판정 함수(입력만 보고 답하는 부분) -------------------------------------------------

# 로그 끝부분에서 매번 바뀌는 시계·경과 시간·사용률을 지운 비교용 글. 멈춘 세션도 스피너의 경과 시간은 계속 늘기 때문이다.
# 토큰 수처럼 실제 진행을 뜻하는 숫자는 남긴다.
function Get-LogSignature([string]$Tail) {
  $lines = foreach ($l in ($Tail -split "`n")) {
    if ($l -match '\d+h \d+%|초기화 \d|auto mode|shift\+tab') { continue }
    $l = $l -replace '(오전|오후|AM|PM)\s*\d{1,2}:\d{2}(:\d{2})?', ''
    $l = $l -replace '\b\d+(\.\d+)?\s*(h|m|s|ms|초|분|시간)\b', ''
    $l = $l.Trim()
    if ($l) { $l }
  }
  $lines -join "`n"
}

# 이 PC에서 프로세스 $RootPid 아래 모든 자손의 CPU 시간(초). $Procs는 Win32_Process 목록. 결과: @{ pid = @{ name; cpu } }
function Get-DescendantCpu($Procs, [int]$RootPid) {
  $byParent = @{}
  foreach ($p in $Procs) {
    $k = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }
    $null = $byParent[$k].Add($p)
  }
  $out = @{}
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootPid)
  while ($queue.Count) {
    $parent = [int]$queue.Dequeue()
    if (-not $byParent.ContainsKey($parent)) { continue }
    foreach ($c in $byParent[$parent]) {
      $cpid = [int]$c.ProcessId
      if ($cpid -eq $RootPid -or $out.ContainsKey($cpid)) { continue }
      $out[$cpid] = @{ name = [string]$c.Name; cpu = ([double]$c.KernelModeTime + [double]$c.UserModeTime) / 1e7 }
      $queue.Enqueue($cpid)
    }
  }
  $out
}

# 두 표본을 비교한다. 새로 생긴 자식이 있거나, 있던 자식의 CPU가 $MinSec 넘게 늘었으면 moved. 결과: @{ moved; text }
function Compare-ChildCpu($Prev, $Now, [double]$MinSec) {
  if (-not $Now -or $Now.Count -eq 0) { return @{ moved = $false; text = '자식 명령: 없음' } }
  $parts = @(); $moved = $false
  foreach ($cpid in $Now.Keys) {
    $n = $Now[$cpid]
    if ($null -eq $Prev -or -not $Prev.ContainsKey($cpid)) { $moved = $true; $parts += "$($n.name)($cpid) 새로 뜸"; continue }
    $d = $n.cpu - $Prev[$cpid].cpu
    if ($d -gt $MinSec) { $moved = $true }
    $parts += ('{0}({1}) +{2:N1}초' -f $n.name, $cpid, $d)
  }
  @{ moved = $moved; text = "자식 명령: $(if ($moved) { '움직임' } else { '움직임 없음' }) - $($parts -join ', ')" }
}

# 시간 초과 문구의 길이("2시간", "90분")
function Format-Span([int]$Minutes) {
  if ($Minutes -ge 60 -and $Minutes % 60 -eq 0) { "$($Minutes / 60)시간" } else { "${Minutes}분" }
}

# ---- 바깥과 닿는 부분 -------------------------------------------------------------------

function Get-ChildSample([int]$RootPid) {
  if (-not $RootPid) { return @{} }
  try { Get-DescendantCpu (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, KernelModeTime, UserModeTime) $RootPid } catch { $null }
}

# ---- 감시 -----------------------------------------------------------------------------

. "$PSScriptRoot\claude-env.ps1"
$null = Use-Utf8Console
Clear-HostClaudeEnv
$claude = Get-ClaudeExe
$Id = $Id -replace '^bg:', ''
$first = (& $claude agents --json | ConvertFrom-Json) | Where-Object { $_.sessionId -like "$Id*" -or $_.id -like "$Id*" } | Select-Object -First 1
if (-not $first) { Write-Output "종료: 업무 세션 $Id 이(가) 목록에 없어요."; exit 0 }
# 비서의 백그라운드 명령 시간제한 안에 끝나도록 마지막 확인에 쓸 90초를 남긴다.
$deadline = $started.AddMinutes($MaxMinutes).AddSeconds(-90)

$workerPid = [int]$first.pid
$lastSig = $null
$quietSince = Get-Date
$childPrev = Get-ChildSample $workerPid
$alive = $first
$evidence = @()

while ((Get-Date) -lt $deadline) {
  $left = [int]($deadline - (Get-Date)).TotalSeconds
  Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min($IntervalSec, $left)))
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

  # busy: 출력이 바뀌었으면 일하는 중. 안 바뀌었으면 자식 명령을 본다.
  if ($alive.pid) { $workerPid = [int]$alive.pid }
  $childNow = Get-ChildSample $workerPid
  $sig = Get-LogSignature $tail
  if ($null -eq $lastSig -or $sig -ne $lastSig) {
    $lastSig = $sig
    $quietSince = Get-Date
    $childPrev = $childNow
    continue
  }
  $child = if ($null -eq $childNow) { @{ moved = $false; text = '자식 명령: 모름(프로세스 목록을 못 읽음)' } } else { Compare-ChildCpu $childPrev $childNow $ChildCpuSec }
  $childPrev = $childNow
  $evidence = @($child.text)
  if ($child.moved) { $quietSince = Get-Date; continue }

  $quietMin = ((Get-Date) - $quietSince).TotalMinutes
  if ($quietMin -ge $StallMinutes) {
    Write-Output ("멈춘 듯: 업무 세션 $Id 이(가) busy인데 {0:N0}분 동안 출력 변화도, 움직이는 명령도 없어요. worker-logs.ps1로 확인하고 정말 멈췄으면 알리세요." -f $quietMin)
    Write-Output '확인한 항목:'
    Write-Output ($evidence | ForEach-Object { "- $_" })
    Write-Output '마지막 출력:'
    Write-Output ($tail -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 10)
    exit 0
  }
}
$span = Format-Span $MaxMinutes
if ($alive -and $alive.status -eq 'busy') {
  Write-Output "시간 초과($span): 업무 세션 $Id 은(는) 아직 일하는 중이에요(status=busy). 감시를 끝내요."
  if ($evidence.Count) { Write-Output "마지막 확인: $($evidence -join '; ')" }
} else {
  Write-Output "시간 초과($span): 감시를 끝내요. 업무 세션 $Id 상태: $($alive.status)."
}
