# 백그라운드 업무 세션이 승인 창에 멈췄는지, 일을 마치고 쉬는지, busy인 채로 멈췄는지 지켜본다. AI를 부르지 않는 단순 반복 확인이라 기다리는 동안 토큰이 들지 않는다.
# 비서가 백그라운드 명령으로 띄워 두면, 멈춤·idle(대기)을 찾거나 세션이 끝나거나 55분이 지났을 때만 이 스크립트가 끝나며 비서를 깨운다.
# 다른 설정 폴더(두 번째 구독 등)에서 도는 세션에는 SendMessage notify_when_idle이 닿지 않아서, 쉬는 상태도 여기서 본다.
#
# 멈춤 판정: status가 busy인데 claude logs 끝부분(시계·경과 시간·사용률 줄을 뺀 것)이 바뀌지 않으면, 다음을 AI 없이 본다.
#   (a) 업무 세션 프로세스 아래 자식 명령(powershell, ssh, node, python, ffmpeg 등)의 CPU 시간이 늘었는지(이 PC)
#   (b) 그 업무의 결과 폴더(작업 상태 파일의 지시에 적힌 TASK.md 폴더, 못 찾으면 공간 output\records·research 아래 가장 최근 업무 폴더)와
#       시험 폴더(workspaces\_sandbox\<공간 폴더 이름>-*)에 지난 확인 뒤 바뀐 파일이 있는지. 업무 세션이 테스트를 백그라운드 셸로 돌리면
#       (a)에 잡히지 않아, 출력 파일이 몇 분마다 쓰이는데도 멈춤 의심이 떴다(업무 159).
#   이 PC의 시험·렌더 프로그램 CPU는 보지 않는다: 업무와 상관없는 다른 프로그램으로도 늘 수 있어 멈춘 업무를 놓치기 때문이다(2026-11-11 보류).
# 하나라도 움직이면 일하는 중으로 보고 기다린다.
# 출력 변화도 움직임도 없는 상태가 -StallMinutes(기본 10분) 이어질 때만 "멈춤 의심: ..."과 근거를 내고 끝낸다.
# idle(대기) 판정: 목록의 status가 busy가 아니면 idle. busy여도 작업 상태 파일에서 모델이 쉬고 결과·질문을 냈으면 idle이다
# (뒤에서 도는 명령이 남으면 status가 busy로 남는다, worker-lib.ps1 Get-WorkerRest).
# 기본 -MaxMinutes는 55분이다(common.ps1의 $CacheWakeMinutes). 구독 세션의 대화 캐시는 1시간 유지되고 읽을 때마다 연장되므로, 55분에 끝나 비서를 깨우면
# 캐시가 살아 있는 채로 읽혀 싸고 다시 1시간 늘어난다. 그때 업무가 아직 돌면 "시간 끝(55분) … 아직 일하는 중"을 내고,
# 비서는 알림 없이 모니터링을 다시 띄운다. 비서는 백그라운드 명령의 시간제한을 이보다 조금 긴 3600000ms(60분)로 준다(모니터링이 먼저 끝나야 한다).
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker/watch-worker.ps1 -Id <짧은 id> [-IntervalSec 120] [-MaxMinutes 55] [-StallMinutes 10]

param(
  [Parameter(Mandatory)] [string]$Id,
  [int]$IntervalSec = 120,
  [int]$MaxMinutes,
  [int]$StallMinutes = 10,
  # 이 PC 자식 명령이 확인 간격 동안 이만큼(초) 넘게 CPU를 쓰면 움직임으로 본다.
  [double]$ChildCpuSec = 1
)
$ErrorActionPreference = 'Stop'
$started = Get-Date
. "$PSScriptRoot\..\lib\common.ps1"
if (-not $MaxMinutes) { $MaxMinutes = $CacheWakeMinutes }
# 질문 훅(src/workspace/watch-check.ts)이 이 PID로 모니터링이 살아 있는지 본다. 모니터링이 끝나면 PID가 죽어 '모니터링 꺼짐'으로 보인다.
# 위치는 이 비서의 기록 폴더(common.ps1 Get-SecretaryStateDir)의 watch\.
$watchDir = Join-Path (Get-SecretaryStateDir) 'watch'
New-Item -ItemType Directory -Force $watchDir | Out-Null
Set-Content -Path (Join-Path $watchDir "$($Id -replace '^bg:', '').pid") -Value $PID -Encoding ascii

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

# 시간 끝 문구의 길이("55분", "2시간")
function Format-Span([int]$Minutes) {
  if ($Minutes -ge 60 -and $Minutes % 60 -eq 0) { "$($Minutes / 60)시간" } else { "${Minutes}분" }
}

# ---- 바깥과 닿는 부분 -------------------------------------------------------------------

function Get-ChildSample([int]$RootPid) {
  if (-not $RootPid) { return @{} }
  try { Get-DescendantCpu (Get-WinProcess -Property ProcessId, ParentProcessId, Name, KernelModeTime, UserModeTime) $RootPid } catch { $null }
}

# 결과 폴더를 볼 곳: 작업 상태 파일 지시(intent)에 적힌 TASK.md의 폴더, 못 찾으면 공간 output\records\<제품>\<업무>·output\research\<업무> 중
# 가장 최근에 만든 폴더, 그리고 시험 폴더 <workspaces>\_sandbox\<공간 폴더 이름>-*. $Cwd는 업무 세션의 공간 폴더.
function Get-WatchFolders([string]$Cwd, [string]$Intent) {
  if (-not $Cwd -or -not (Test-Path -LiteralPath $Cwd -PathType Container)) { return @() }
  $out = @()
  $m = [regex]::Match("$Intent", '(output[\\/][^\s"''`]+?)[\\/]TASK\.md')
  $task = if ($m.Success) { Join-Path $Cwd ($m.Groups[1].Value -replace '/', '\') }
  if ($task -and (Test-Path -LiteralPath $task -PathType Container)) { $out += $task }
  else {
    $dirs = @(Get-ChildItem -LiteralPath (Join-Path $Cwd 'output\records') -Directory -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue }) +
      @(Get-ChildItem -LiteralPath (Join-Path $Cwd 'output\research') -Directory -ErrorAction SilentlyContinue)
    $newest = $dirs | Where-Object { $_ } | Sort-Object CreationTime -Descending | Select-Object -First 1
    if ($newest) { $out += $newest.FullName }
  }
  $sandbox = Join-Path (Split-Path -Parent $Cwd) '_sandbox'
  $out += @(Get-ChildItem -LiteralPath $sandbox -Directory -Filter "$(Split-Path -Leaf $Cwd)-*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  $out
}

# $Folders 아래(하위 폴더 포함, node_modules·.git은 빼고)에 $Since 뒤에 바뀐 파일이 있는지. 하나 찾으면 멈추고, 파일 $MaxFiles개까지만 본다.
# 결과: @{ moved; text }
function Find-RecentFile([string[]]$Folders, [datetime]$Since, [int]$MaxFiles = 20000) {
  $list = @($Folders | Where-Object { $_ })
  if (-not $list.Count) { return @{ moved = $false; text = '결과·시험 폴더: 모름(못 찾음)' } }
  $seen = 0
  foreach ($root in $list) {
    $stack = New-Object System.Collections.Stack
    $stack.Push($root)
    while ($stack.Count -and $seen -lt $MaxFiles) {
      $dir = $stack.Pop()
      foreach ($e in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
        if ($e.PSIsContainer) { if ($e.Name -notin 'node_modules', '.git') { $stack.Push($e.FullName) }; continue }
        $seen++
        if ($e.LastWriteTime -gt $Since) {
          return @{ moved = $true; text = "결과·시험 폴더: 바뀐 파일 있음 - $($e.FullName) ($($e.LastWriteTime.ToString('HH:mm:ss')))" }
        }
      }
    }
  }
  $names = ($list | ForEach-Object { Split-Path -Leaf $_ }) -join ', '
  @{ moved = $false; text = "결과·시험 폴더: $($Since.ToString('HH:mm:ss')) 뒤 바뀐 파일 없음($names, 파일 $seen개 봄)" }
}

# ---- 모니터링 -------------------------------------------------------------------------

. "$PSScriptRoot\worker-lib.ps1"
$claude = Initialize-ClaudeScript
$Id = ConvertTo-WorkerId $Id
# 세션이 보이는 설정 폴더를 한 번 찾아 두고(이 프로세스의 CLAUDE_CONFIG_DIR) 그 뒤로는 그 폴더만 본다.
$first = Find-WorkerSession $claude $Id
if (-not $first) { Write-Output "종료: 업무 세션 $Id 이(가) 어느 계정의 목록에도 없어요."; exit 0 }
# 마지막 확인이 길어도 55분 안에 끝나도록 90초를 남긴다.
$deadline = $started.AddMinutes($MaxMinutes).AddSeconds(-90)

$workerPid = [int]$first.pid
$lastSig = $null
$quietSince = Get-Date
$childPrev = Get-ChildSample $workerPid
$lastProbe = Get-Date
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
  $job = Read-WorkerJob (Get-ClaudeConfigDir) $(if ($alive.id) { $alive.id } else { $Id })
  $rest = Get-WorkerRest $alive $job
  if ($rest) {
    Write-Output "idle(대기): 업무 세션 $Id 이(가) 턴을 끝냈어요(status=$($rest.status), state=$($rest.state)). [질문]인지 완료인지 worker-logs.ps1로 확인하세요."
    if ($rest.leftover.Count) {
      Write-Output "뒤에서 도는 명령이 $($rest.leftover.Count)개 남아 있어 목록에는 busy로 보여요. 업무를 끝내면 worker-done.ps1이 세션과 함께 꺼요:"
      Write-Output ($rest.leftover | ForEach-Object { "- $_" })
    }
    exit 0
  }

  # busy: 출력이 바뀌었으면 일하는 중. 안 바뀌었으면 자식 명령·결과 폴더를 본다.
  if ($alive.pid) { $workerPid = [int]$alive.pid }
  $childNow = Get-ChildSample $workerPid
  $probeSince = $lastProbe; $lastProbe = Get-Date
  $sig = Get-LogSignature $tail
  if ($null -eq $lastSig -or $sig -ne $lastSig) {
    $lastSig = $sig
    $quietSince = Get-Date
    $childPrev = $childNow
    $evidence = @('업무 세션 출력: 바뀜')
    continue
  }
  $child = if ($null -eq $childNow) { @{ moved = $false; text = '자식 명령: 모름(프로세스 목록을 못 읽음)' } } else { Compare-ChildCpu $childPrev $childNow $ChildCpuSec }
  $childPrev = $childNow
  $cwd = if ($alive.cwd) { "$($alive.cwd)" } elseif ($job) { "$($job.cwd)" } else { '' }
  $files = if ($child.moved) { @{ moved = $false; text = '결과·시험 폴더: 확인 안 함(자식 명령이 움직임)' } } else { Find-RecentFile (Get-WatchFolders $cwd "$($job.intent)") $probeSince }
  $here = $child.moved -or $files.moved
  $evidence = @($child.text, $files.text)
  if ($here) { $quietSince = Get-Date; continue }

  $quietMin = ((Get-Date) - $quietSince).TotalMinutes
  if ($quietMin -ge $StallMinutes) {
    Write-Output ("멈춤 의심: 업무 세션 $Id 이(가) busy인데 {0:N0}분 동안 출력 변화도, 움직이는 명령·바뀐 결과 파일도 없어요. worker-logs.ps1로 확인하고 정말 멈췄으면 알리세요." -f $quietMin)
    Write-Output '확인한 항목:'
    Write-Output ($evidence | ForEach-Object { "- $_" })
    Write-Output '마지막 출력:'
    Write-Output ($tail -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 10)
    exit 0
  }
}
# 여기까지 오면 마지막 확인에서 업무 세션이 아직 일하고 있었다(idle·멈춤 의심·승인 대기·목록에 없음은 위에서 끝난다).
$span = Format-Span $MaxMinutes
Write-Output "시간 끝($span): 업무 세션 $Id 은(는) 아직 일하는 중이에요(status=$($alive.status)). 알림 없이 모니터링을 다시 띄우세요."
if ($evidence.Count) { Write-Output "마지막 확인: $($evidence -join '; ')" }
