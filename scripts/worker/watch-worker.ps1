# 백그라운드 업무 세션이 승인 창에 멈췄는지, 일을 마치고 쉬는지, busy인 채로 멈췄는지 지켜본다. AI를 부르지 않는 단순 반복 확인이라 기다리는 동안 토큰이 들지 않는다.
# 비서가 백그라운드 명령으로 띄워 두면, 멈춤·idle(대기)을 찾거나 세션이 끝나거나 55분이 지났을 때만 이 스크립트가 끝나며 비서를 깨운다.
# 쉬는 상태도 여기서 본다. 업무 세션의 쉼·[질문]·끝남은 공급자·설정 폴더와 상관없이 이 모니터링 하나로만 받는다(SendMessage notify_when_idle을
# 함께 쓰면 같은 설정 폴더의 세션에서 같은 일로 비서를 두 번 깨운다. 다른 설정 폴더의 세션에는 notify_when_idle이 닿지도 않는다).
#
# 판정은 확인마다 node src/cli.ts worker-status(src/workspace/worker-status.ts, worker-lib.ps1 Get-WorkerStatus) 한 번으로 받는다:
# 목록(claude agents --json)에 없음 / 승인 대기 / 쉼(턴 끝) / 일하는 중과, 대화 기록이 지난 확인 뒤 바뀌었는지, 알림에 붙일 마지막 기록.
#   승인 대기: 목록의 status waiting(waitingFor "permission prompt")이 먼저, 작업 상태 파일의 tempo blocked + state working이 보조.
#     목록에 status가 없고 작업 상태 파일도 말해 주지 않을 때만 claude logs 화면 끝(빈 줄 뺀 30줄)에서 승인 창 글을 찾는다.
#   쉼: status가 busy가 아니면 쉼. busy여도 작업 상태 파일에서 모델이 쉬고 결과·질문을 냈으면 쉼이다(뒤에서 도는 명령이 남으면 status가 busy로 남는다).
#   승인 대기는 쉼으로 보지 않는다(예전에는 status가 busy가 아니면 쉼으로 봐서 승인 창에 멈춘 세션을 "턴을 끝냈어요"로 알릴 수 있었다).
# 이 스크립트는 그 결과로 알림을 내고, 이 PC 자식 명령의 CPU·결과 폴더·외부 기기처럼 이 PC에서 재야 하는 것만 직접 본다.
#
# 멈춤 판정: 일하는 중인데 업무 세션의 대화 기록(jsonl과 그 세션의 서브에이전트 기록 <uuid>\subagents\)의 크기·수정 시각이 바뀌지 않으면,
# 다음을 AI 없이 본다(대화 기록을 못 찾으면 worker-status가 claude logs 끝부분에서 시계·경과 시간·사용률 줄을 뺀 글로 비교한다).
#   (a) 업무 세션 프로세스 아래 자식 명령(powershell, ssh, node, python, ffmpeg 등)의 CPU 시간이 늘었는지(이 PC)
#   (b) 그 업무의 결과 폴더(작업 상태 파일의 지시에 적힌 TASK.md 폴더, 못 찾으면 공간 output\records·research 아래 가장 최근 업무 폴더)와
#       시험 폴더(workspaces\_sandbox\<공간 폴더 이름>-*)에 지난 확인 뒤 바뀐 파일이 있는지. 업무 세션이 테스트를 백그라운드 셸로 돌리면
#       (a)에 잡히지 않아, 출력 파일이 몇 분마다 쓰이는데도 멈춤 의심이 떴다.
#   이 PC의 시험·렌더 프로그램 CPU는 보지 않는다: 업무와 상관없는 다른 프로그램으로도 늘 수 있어 멈춘 업무를 놓치기 때문이다(2026-11-11 보류).
# 하나라도 움직이면 일하는 중으로 보고 기다린다.
# 출력 변화도 움직임도 없는 상태가 -StallMinutes(기본 10분) 이어질 때만 "멈춤 의심: ..."과 근거를 내고 끝낸다.
# 작업 멈춤 기록: 확인마다 업무 세션 출력보다 먼저, 작업 도구(외부 기기 작업 등)가 멈춘 작업을 끊고 비서 기록 폴더 job-stalls.jsonl에 남긴 줄을
# 본다(node src/cli.ts job-stall watch, src/workspace/job-stalls.ts). 모니터링을 띄운 뒤 온 줄은 "작업 멈춤 기록: …"으로 출력에 알리고,
# 같은 작업이 연달아 두 번 멈춘 줄이 오면 "같은 작업 연달아 멈춤"으로 끝나 비서를 깨운다(업무 세션이 글을 계속 써도 잡힌다).
# idle(대기)을 알릴 때 업무 세션의 마지막 답이 [질문]이면(worker-status의 asks) 그 업무의 상태를 running에서 asking(질문 대기)으로 바꾼다
# (Set-AskingFromTranscript, 판정은 업무 세션의 대화 기록 jsonl로).
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
# 둘째 줄은 이 프로세스의 시작 시각(UTC, ISO). 모니터링이 끝난 뒤 그 PID를 다른 프로세스가 다시 쓰면 PID만으로는 살아 있다고 잘못 보아
# '모니터링 꺼짐'을 알리지 않으므로, 질문 훅이 PID와 시작 시각을 함께 대조한다(watch-check.ts watcherAlive).
$startedUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
Set-Content -Path (Join-Path $watchDir "$($Id -replace '^bg:', '').pid") -Value @("$PID", $startedUtc) -Encoding ascii

# ---- 판정 함수(입력만 보고 답하는 부분) -------------------------------------------------

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

# idle일 때: 업무 세션의 마지막 답이 [질문]이면 그 세션의 업무(tasks.session_ref) 가운데 running인 것을 asking(질문 대기)으로 바꾸고 바꿨다는 줄을 낸다.
# 판정 입력은 업무 세션의 대화 기록(jsonl)이다. claude logs 화면 글은 화면보다 긴 답(선택지가 많은 질문)이
# 위로 밀려나 [질문] 줄이 남지 않아 쓰지 않는다. 기록 찾기·읽기·판정과 DB 쓰기는 node src/cli.ts worker-asking(src/workspace/worker-asking.ts)이
# 하고, 여기서는 이 프로세스의 설정 폴더(Get-ClaudeConfigDir)와 세션 id만 넘긴다.
# 기록을 못 찾거나 명령이 실패하면 아무것도 내지 않는다(전처럼 idle 알림만 남는다).
function Set-AskingFromTranscript([string]$WorkerId, [string]$SessionId) {
  $cliArgs = @('worker-asking', $WorkerId, (Get-ClaudeConfigDir)) + @($SessionId | Where-Object { $_ })
  @((Invoke-SecretaryCli $cliArgs).out) | Where-Object { "$_".Trim() }
}

# 작업 멈춤 기록(비서 기록 폴더 job-stalls.jsonl, src/workspace/job-stalls.ts): 작업 도구(외부 기기 작업 등)가 멈춘 작업을 끊고 남긴 줄.
# 판정은 node src/cli.ts job-stall watch가 한다. $From이 없으면 지금 파일 끝(그 뒤에 온 줄만 알린다), 있으면 그 뒤 줄과
# 그 가운데 같은 작업이 연달아 두 번 멈춘 줄(repeat). 결과: @{ offset; lines; repeat }, 명령이 실패하면 $null(다음 확인에서 다시 본다).
function Get-JobStalls($From) {
  $cliArgs = @('job-stall', 'watch') + $(if ($null -ne $From) { @('--from', "$From") } else { @() })
  $out = @((Invoke-SecretaryCli $cliArgs).out) | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1
  if (-not $out) { return $null }
  try { "$out" | ConvertFrom-Json } catch { $null }
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
$st = $null
$evidence = @()
$failures = 0
# 작업 멈춤 기록은 모니터링을 띄운 뒤에 온 줄만 알린다.
$stallFrom = (Get-JobStalls $null).offset

while ((Get-Date) -lt $deadline) {
  $left = [int]($deadline - (Get-Date)).TotalSeconds
  Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min($IntervalSec, $left)))
  # 작업 멈춤 기록을 업무 세션 출력보다 먼저 본다: 업무 세션이 기다리며 글을 쓰면 아래 멈춤 의심의 시계가 다시 시작돼,
  # 외부 기기 작업이 멈춘 것을 한 시간 가까이 몰랐던 일이 있었다. 새 줄은 출력에 알리고, 같은 작업이 연달아 두 번 멈췄으면 끝내 비서를 깨운다.
  # 시작 때 파일 끝을 못 읽었으면(명령 실패) 이번에 읽고, 그 뒤 줄부터 알린다.
  $js = Get-JobStalls $stallFrom
  if ($js -and $null -eq $stallFrom) { $stallFrom = $js.offset; $js = $null }
  if ($js) {
    $stallFrom = $js.offset
    foreach ($l in @($js.lines)) { Write-Output "작업 멈춤 기록: $l" }
    if (@($js.repeat).Count) {
      Write-Output "같은 작업 연달아 멈춤: 작업 도구가 같은 작업을 연달아 멈춤으로 끊었어요(어느 업무의 작업인지는 줄 끝의 폴더로 본다). 업무 세션 $Id 이(가) 다시 돌리려 할 수 있으니 worker-logs.ps1로 확인하고 사용자에게 알리세요."
      Write-Output ($js.repeat | ForEach-Object { "- $_" })
      exit 0
    }
  }
  # 목록·작업 상태 파일·대화 기록(모를 때만 화면 끝)을 한 번에 읽은 판정(worker-lib.ps1 Get-WorkerStatus, src/workspace/worker-status.ts).
  $st = Get-WorkerStatus $claude $Id $lastSig
  if ($st.verdict -eq 'error') {
    # 목록을 못 읽는 등 판정 명령이 실패하면 다음 확인에서 다시 본다. 세 번 이어지면 알리고 끝낸다.
    $failures++
    if ($failures -ge 3) {
      Write-Output "모니터링 오류: 업무 세션 $Id 의 상태를 세 번 이어 읽지 못했어요(node src/cli.ts worker-status). 업무 세션은 worker-logs.ps1로 확인하고 모니터링을 다시 띄우세요."
      if ($st.error) { Write-Output "마지막 오류: $($st.error)" }
      exit 0
    }
    continue
  }
  $failures = 0
  $notes = @($st.notes | Where-Object { $_ })
  if ($st.verdict -eq 'gone') { Write-Output "종료: 업무 세션 $Id 이(가) 목록에 없어요."; exit 0 }
  if ($st.verdict -eq 'approval') {
    $what = if ($st.waitingFor -and $st.waitingFor -ne 'permission prompt') { "사람의 입력을 기다리며 멈췄어요(waitingFor=$($st.waitingFor))" } else { '승인 창에 멈췄어요' }
    Write-Output "승인 대기: 업무 세션 $Id 이(가) $what.$(if ($st.approvalNeeds) { " 기다리는 것: $($st.approvalNeeds)" }) 마지막 출력:"
    Write-Output ($st.summary | ForEach-Object { "- $_" })
    if ($notes.Count) { Write-Output "참고: $($notes -join '; ')" }
    exit 0
  }
  if ($st.verdict -eq 'rest') {
    Write-Output "idle(대기): 업무 세션 $Id 이(가) 턴을 끝냈어요(status=$(if ($st.status) { $st.status } else { '없음' }), state=$($st.restState)). [질문]인지 완료인지 worker-logs.ps1로 확인하세요."
    if ($st.asks) { Set-AskingFromTranscript $Id "$($st.sessionId)" }
    if ($st.leftover.Count) {
      Write-Output "뒤에서 도는 명령이 $($st.leftover.Count)개 남아 있어 목록에는 busy로 보여요. 업무를 끝내면 worker-done.ps1이 세션과 함께 꺼요:"
      Write-Output ($st.leftover | ForEach-Object { "- $_" })
    }
    if ($notes.Count) { Write-Output "참고: $($notes -join '; ')" }
    exit 0
  }

  # busy: 출력이 바뀌었으면 일하는 중. 안 바뀌었으면 자식 명령·결과 폴더를 본다.
  if ($st.pid) { $workerPid = [int]$st.pid }
  $childNow = Get-ChildSample $workerPid
  $probeSince = $lastProbe; $lastProbe = Get-Date
  # 출력: 대화 기록(jsonl과 서브에이전트 기록)의 크기·수정 시각. 기록을 못 찾으면 worker-status가 claude logs 화면 끝으로 대신한다(source).
  if ($st.progressed) {
    $lastSig = $st.signature
    $quietSince = Get-Date
    $childPrev = $childNow
    $evidence = @(switch ($st.source) {
        'jsonl' { '업무 세션 대화 기록: 바뀜' }
        'screen' { '업무 세션 출력(화면, 대화 기록 못 찾음): 바뀜' }
        default { '업무 세션 출력: 모름(대화 기록도 화면도 못 읽음)' }
      })
    continue
  }
  $child = if ($null -eq $childNow) { @{ moved = $false; text = '자식 명령: 모름(프로세스 목록을 못 읽음)' } } else { Compare-ChildCpu $childPrev $childNow $ChildCpuSec }
  $childPrev = $childNow
  $files = if ($child.moved) { @{ moved = $false; text = '결과·시험 폴더: 확인 안 함(자식 명령이 움직임)' } } else { Find-RecentFile (Get-WatchFolders "$($st.cwd)" "$($st.intent)") $probeSince }
  $here = $child.moved -or $files.moved
  $evidence = @($child.text, $files.text)
  if ($here) { $quietSince = Get-Date; continue }

  $quietMin = ((Get-Date) - $quietSince).TotalMinutes
  if ($quietMin -ge $StallMinutes) {
    Write-Output ("멈춤 의심: 업무 세션 $Id 이(가) busy인데 {0:N0}분 동안 출력 변화도, 움직이는 명령·바뀐 결과 파일도 없어요. worker-logs.ps1 -Screen으로 지금 화면을 확인하고 정말 멈췄으면 알리세요." -f $quietMin)
    Write-Output '확인한 항목:'
    Write-Output ($evidence | ForEach-Object { "- $_" })
    if ($st.source -eq 'jsonl') { Write-Output '마지막 기록(대화 기록 jsonl):' }
    elseif ($st.source -eq 'screen') { Write-Output '마지막 출력(claude logs 화면, 대화 기록을 못 읽음):' }
    else { Write-Output '마지막 출력: 대화 기록도 화면도 못 읽었어요.' }
    Write-Output ($st.summary | ForEach-Object { "- $_" })
    if ($notes.Count) { Write-Output "참고: $($notes -join '; ')" }
    exit 0
  }
}
# 여기까지 오면 마지막 확인에서 업무 세션이 아직 일하고 있었다(idle·멈춤 의심·승인 대기·목록에 없음은 위에서 끝난다).
$span = Format-Span $MaxMinutes
Write-Output "시간 끝($span): 업무 세션 $Id 은(는) 아직 일하는 중이에요(status=$(if ($st.status) { $st.status } else { $first.status })). 알림 없이 모니터링을 다시 띄우세요."
if ($evidence.Count) { Write-Output "마지막 확인: $($evidence -join '; ')" }
