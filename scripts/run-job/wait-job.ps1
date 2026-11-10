# -Detach로 띄운 run-job(scripts/lib/detached-job.ps1)을 기다린다. AI를 부르지 않는 단순 확인이라 기다리는 동안 토큰이 들지 않는다.
# 일이 끝나거나, 끝 기록 없이 프로세스가 사라지거나, -MaxMinutes(기본 55분, common.ps1의 $CacheWakeMinutes)가 지나면 끝나며 비서를 깨운다.
# 55분인 까닭은 업무 세션 감시(watch-worker.ps1)와 같다: 구독 대화 캐시가 1시간이라, 그 안에 깨어 읽으면 캐시가 살아 있고 다시 1시간 늘어난다.
# 비서는 이 명령을 백그라운드 명령(시간제한 3600000ms)으로 띄우고, "아직 도는 중"이 오면 알림 없이 같은 명령을 다시 띄운다.
# 끝나면 그 일의 출력 전부(out.txt, 오류 출력이 있으면 err.txt)를 내고, 그 일의 종료 코드로 끝난다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/wait-job.ps1 -Id <id> [-MaxMinutes 55] [-IntervalSec 15]

param(
  [Parameter(Mandatory)] [string]$Id,
  [int]$MaxMinutes,
  [int]$IntervalSec = 15
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
. "$PSScriptRoot\..\lib\detached-job.ps1"
if (-not $MaxMinutes) { $MaxMinutes = $CacheWakeMinutes }
$dir = Get-BgJobDir $Id
$jobFile = Join-Path $dir 'job.json'
if (-not (Test-Path $jobFile)) { Write-Output "종료: 뒤에서 띄운 일 $Id 의 기록이 없어요($dir)."; exit 0 }
$job = Get-Content -Raw -Encoding UTF8 $jobFile | ConvertFrom-Json
$exitFile = Join-Path $dir 'exit.txt'
$outFile = Join-Path $dir 'out.txt'
$errFile = Join-Path $dir 'err.txt'
$started = Get-Date
$deadline = $started.AddMinutes($MaxMinutes)

function Get-Text([string]$Path) { if (Test-Path $Path) { [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) } else { '' } }
# 숨은 창의 PowerShell은 오류 출력을 CLIXML로 쓰기도 한다. 진행 표시는 버리고 오류 글만 남긴다.
function Get-ErrText([string]$Path) {
  $t = (Get-Text $Path) -replace '#< CLIXML\r?\n?', ''
  $t = [regex]::Replace($t, '(?s)<Objs [^>]*>.*?</Objs>', {
    param($m)
    (([regex]::Matches($m.Value, '<S S="Error">(.*?)</S>') | ForEach-Object { $_.Groups[1].Value }) -join '') -replace '_x000D_', '' -replace '_x000A_', "`n"
  })
  $t.Trim()
}
function Get-Elapsed { [int]([DateTime]::UtcNow - [DateTime]::Parse($job.started_at).ToUniversalTime()).TotalMinutes }

while ($true) {
  if (Test-Path $exitFile) {
    $code = [int]((Get-Content -Raw $exitFile).Trim())
    Write-Output "끝: $($job.script) $($job.label) (종료 코드 $code, $(Get-Elapsed)분)"
    $out = Get-Text $outFile; if ($out.Trim()) { Write-Output $out.TrimEnd() }
    $err = Get-ErrText $errFile; if ($err) { Write-Output '--- 오류 출력 ---'; Write-Output $err.TrimEnd() }
    exit $code
  }
  if (-not (Get-Process -Id $job.pid -ErrorAction SilentlyContinue)) {
    # 프로세스가 끝나면서 exit.txt를 쓰는 사이일 수 있어 한 번 더 본다.
    Start-Sleep -Seconds 2
    if (Test-Path $exitFile) { continue }
    Write-Output "꺼짐: $($job.script) $($job.label) 이(가) 끝 기록 없이 사라졌어요(PID $($job.pid), $(Get-Elapsed)분). 출력 끝부분:"
    Write-Output ((Get-Text $outFile) -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 15)
    $err = Get-ErrText $errFile; if ($err) { Write-Output '--- 오류 출력 ---'; Write-Output ($err -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 15) }
    exit 1
  }
  $left = ($deadline - (Get-Date)).TotalSeconds
  if ($left -le 0) { break }
  Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min($IntervalSec, [int]$left)))
}
$last = (Get-Text $outFile) -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1
Write-Output "아직 도는 중(${MaxMinutes}분 기다림, 시작 뒤 $(Get-Elapsed)분): $($job.script) $($job.label). 알림 없이 같은 명령으로 다시 기다리세요."
if ($last) { Write-Output "출력 마지막 줄: $last" }
