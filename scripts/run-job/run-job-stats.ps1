# run-job 호출 기록(이 비서의 기록 폴더 ~/.secretary/<비서 번호>/state의 run-job-calls.jsonl, common.ps1 Get-SecretaryStateDir)의 최근 N개를 이어 부름/새 세션별로 묶어 평균 비용·시간·문맥 크기를 보여준다.
# 이어 부르기 기준값(55분, 문맥 20만 토큰)을 실측으로 고칠 때 본다.
# 업무 세션 재사용 기록(worker-reuse.jsonl, start-worker·worker-done이 남김)이 있으면 그 요약도 덧붙인다.
# 시험이 부른 호출(작업 폴더가 %TEMP% 아래이고 모델이 Haiku)은 뺀다(-WithTests면 넣는다): 2026-11-07까지 npm test의 쉬는 시간
# 시험이 진짜 run-job을 불러 기록에 섞였다. 이제 시험은 부르지 못하고(test/env.ts), 기록 파일은 고치지 않는다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/run-job-stats.ps1 [-Last 50] [-Model <모델>] [-WithTests]

param(
  [int]$Last = 50,
  [string]$Model,
  [switch]$WithTests
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\lib\common.ps1"
$null = Use-Utf8Console

$file = Join-Path (Get-SecretaryStateDir) 'run-job-calls.jsonl'
function Avg($items, [string]$prop, [int]$digits) {
  $vals = @($items | ForEach-Object { $_.$prop } | Where-Object { $null -ne $_ })
  if (-not $vals.Count) { return '-' }
  [math]::Round(($vals | Measure-Object -Average).Average, $digits)
}

if (-not (Test-Path $file)) { '아직 run-job 호출 기록이 없어요.' } else {
$calls = @(Get-Content -Encoding UTF8 $file | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
$testCalls = 0
if (-not $WithTests) {
  $kept = @($calls | Where-Object { -not ("$($_.model)" -match 'haiku' -and "$($_.folder)" -match '\\(Temp|tmp)(\\|$)') })
  $testCalls = $calls.Count - $kept.Count
  $calls = $kept
}
if ($Model) { $calls = $calls | Where-Object { $_.model -eq $Model } }
$calls = @($calls | Select-Object -Last $Last)
"최근 호출 $($calls.Count)개$(if ($Model) { " (모델 $Model)" })$(if ($testCalls) { " · 시험 호출 $($testCalls)개 뺌(%TEMP% 폴더의 Haiku, -WithTests면 넣음)" })"

$calls | Group-Object { if ($_.resumed) { '이어 부름' } else { '새 세션' } } | ForEach-Object {
  [pscustomobject]@{
    구분 = $_.Name
    횟수 = $_.Count
    '평균 비용($)' = Avg $_.Group 'cost_usd' 4
    '평균 전체(초)' = Avg $_.Group 'total_sec' 1
    '평균 API(ms)' = Avg $_.Group 'duration_api_ms' 0
    '평균 문맥' = Avg $_.Group 'context' 0
    '평균 캐시 쓰기' = Avg $_.Group 'cache_creation_input_tokens' 0
    오류 = @($_.Group | Where-Object { $_.is_error }).Count
  }
} | Format-Table -AutoSize | Out-String -Width 200
$reasons = $calls | Where-Object { $_.new_reason } | Group-Object new_reason | ForEach-Object { "$($_.Name) $($_.Count)" }
if ($reasons) { "새로 시작한 이유: $($reasons -join ' · ')" }
}

# 업무 세션 재사용: 시작 판단과 끄기(idle_stop = 55분 동안 다음 업무 없음, done_stop = 문맥이 커서 바로 끔)를 묶는다.
$wfile = Join-Path (Get-SecretaryStateDir) 'worker-reuse.jsonl'
if (Test-Path $wfile) {
  $rows = @(Get-Content -Encoding UTF8 $wfile | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object -Last $Last)
  $starts = @($rows | Where-Object { -not $_.event })
  ''
  "업무 세션 시작 $($starts.Count)개: 재사용 $(@($starts | Where-Object { $_.reused }).Count) · 새 세션 $(@($starts | Where-Object { -not $_.reused }).Count)"
  $starts | Where-Object { $null -ne $_.minutes_since_done } | Group-Object { if ($_.reused) { '재사용' } else { '새 세션' } } | ForEach-Object {
    [pscustomobject]@{ 구분 = $_.Name; 횟수 = $_.Count; '평균 쉰 시간(분)' = Avg $_.Group 'minutes_since_done' 1; '평균 문맥' = Avg $_.Group 'context' 0 }
  } | Format-Table -AutoSize | Out-String -Width 200
  $wreasons = $starts | Where-Object { $_.new_reason } | Group-Object new_reason | ForEach-Object { "$($_.Name) $($_.Count)" }
  if ($wreasons) { "새로 시작한 이유: $($wreasons -join ' · ')" }
  $stops = $rows | Where-Object { $_.event } | Group-Object event | ForEach-Object { "$(if ($_.Name -eq 'idle_stop') { '55분 쉼' } else { '문맥 커서 바로' }) $($_.Count)" }
  if ($stops) { "끈 세션: $($stops -join ' · ')" }
}
