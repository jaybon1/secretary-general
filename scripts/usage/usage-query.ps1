# 구독 공급자의 사용량을 토큰 없이 조회해 공급자·계정별 파일(~/.secretary/usage/subscription-<계정>.json, 이름 규칙은 providers.ps1 Get-UsageKey)에
# 저장하고 한 줄로 보여 준다. 쓴 바로 뒤 옛 이름(<공급자>.json·<공급자>-<계정>.json과 .refresh)은 지운다(Remove-LegacyUsageFiles).
# claude -p "/usage"는 모델을 부르지 않는다(토큰 0). 빈 폴더에서 MCP 없이 돌려 다른 설정이 끼지 않게 한다.
# agy(antigravity)도 /usage로 토큰 없이 조회한다. 나머지는 무료 조회 명령이 없어 건너뛴다(Copilot의 /usage는 -p에서
# 일반 질문으로 처리돼 크레딧을 쓰고, Bedrock은 AWS CLI가 있어야 조회된다).
# 어떻게 조회할지는 providers.json의 공급자마다 "usage" 칸이 정한다: "claude-usage"(구독 /usage), "agy"(Antigravity),
# 없거나 "none"이면 조회 안 됨(src/usage/provider-usage.ts). 공급자가 늘면 그 칸만 채운다.
# 기능 usage-poll(비서 서버와 같이 뜨는 조회기, src/usage/usage-poller.ts)이 설정에서 고른 공급자를 5분마다 이 스크립트로 조회한다.
# usage-guard.mjs도 기록이 5분 넘게 오래되면 이 스크립트를 몰래 띄워 갱신한다(대시보드가 꺼졌을 때의 예비).
# 사용량을 못 읽으면(/usage가 사용량을 주지 않는 API 키 로그인, claude 없음, 시간 초과) <같은 이름>.fail에 실패 횟수를 적고, 읽으면 지운다.
# 정지 훅과 조회기는 그 횟수만큼 다음 조회를 미룬다(5분부터 두 배씩 최대 6시간, src/usage/usage-files.ts failureWait).
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usage/usage-query.ps1 [-Provider <이름>]
#     -Provider를 안 주면 providers.json에서 조회할 수 있는 공급자를 모두 조회한다.
param([string]$Provider)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\lib\common.ps1"
. "$PSScriptRoot\..\lib\providers.ps1"
$null = Use-Utf8Console

$config = Get-ProviderConfig
$names = if ($Provider) { @($Provider) } else {
  @($config.providers.PSObject.Properties | Where-Object { $_.Value.usage -in 'claude-usage', 'agy' } | ForEach-Object Name)
}

$probe = Join-Path $env:TEMP 'secretary-usage-probe'
New-Item -ItemType Directory -Force $probe | Out-Null
$outDir = Get-UsageDir
New-Item -ItemType Directory -Force $outDir | Out-Null
# claude가 없어도(다른 회사 CLI만 쓰는 PC) agy 조회는 하고, claude가 필요한 공급자는 실패로 적는다.
$claudeError = $null
try { $claude = Get-ClaudeExe } catch { $claude = $null; $claudeError = "$_" }
$kst = Get-KstZone

# 실패 기록(<이름>.fail): { at, count, reason }. count는 잇따른 실패 횟수. TS 쪽 짝: src/usage/usage-files.ts recordFailure·failureWait.
function Save-UsageFailure([string]$Key, [string]$Reason) {
  $file = Join-Path $outDir "$Key.fail"
  $count = 0
  try { $count = [int]((Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json).count) } catch {}
  if ($Reason.Length -gt 200) { $Reason = $Reason.Substring(0, 200) }
  Write-Utf8File $file (([ordered]@{ at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); count = $count + 1; reason = $Reason }) | ConvertTo-Json -Compress)
}
function Clear-UsageFailure([string]$Key) { Remove-Item -LiteralPath (Join-Path $outDir "$Key.fail") -ErrorAction SilentlyContinue }

# "resets Oct 22, 6:40am (Asia/Seoul)" → UTC ISO. 연도가 없어서 올해로 보고, 이미 하루 넘게 지났으면 내년으로 본다.
function ConvertTo-ResetIso([string]$text) {
  if ($text -notmatch 'resets\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)') { return $null }
  $month = [array]::IndexOf(@('Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'), $Matches[1]) + 1
  $hour = [int]$Matches[3] % 12; if ($Matches[5] -eq 'pm') { $hour += 12 }
  $minute = if ($Matches[4]) { [int]$Matches[4] } else { 0 }
  $nowKst = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $kst)
  $local = New-Object DateTime $nowKst.Year, $month, ([int]$Matches[2]), $hour, $minute, 0
  if ($local -lt $nowKst.AddDays(-1)) { $local = $local.AddYears(1) }
  [TimeZoneInfo]::ConvertTimeToUtc($local, $kst).ToString('yyyy-MM-ddTHH:mm:ssZ')
}

$fmt = { param($iso) if ($iso) { [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::Parse($iso).ToUniversalTime(), $kst).ToString('M\/d HH:mm') } else { '?' } }

# agy의 /usage(/quota)도 모델을 부르지 않는다(토큰 0). 주간 한도만 있고, 모델 묶음(Gemini, Claude·GPT)마다 따로다.
function Save-AntigravityUsage([string]$name) {
  Push-Location $probe
  try { $raw = & (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe') --output-format json '-p=/usage' 2>&1 | Out-String } finally { Pop-Location }
  try { $groups = ($raw | ConvertFrom-Json).command.data.groups } catch { $groups = $null }
  if (-not $groups) {
    $first = ($raw.Trim() -split "`r?`n")[0]
    Save-UsageFailure (Get-UsageKey $name) $first
    Write-Output "${name}: 사용량을 읽지 못했어요 — $first"; return
  }
  $list = foreach ($g in $groups) {
    $b = $g.buckets | Select-Object -First 1
    [ordered]@{ name = $g.name; window = $b.window; used_pct = [math]::Round((1 - $b.remaining_fraction) * 100, 1); resets_at = $b.reset_time }
  }
  $state = [ordered]@{ groups = @($list); updated_at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); source = 'agy-usage' }
  Write-Utf8File (Get-UsageFile $name) ($state | ConvertTo-Json -Compress -Depth 4)
  Clear-UsageFailure (Get-UsageKey $name)
  Remove-LegacyUsageFiles $name (Get-UsageKey $name)
  Write-Output ("${name}: " + (($list | ForEach-Object { "$($_.name) 주간 $($_.used_pct)% (초기화 $(& $fmt $_.resets_at))" }) -join ' · '))
}

foreach ($name in $names) {
  $p = $config.providers.$name
  if (-not $p) { Write-Output "${name}: providers.json에 없는 공급자"; continue }
  if ($p.usage -eq 'agy') { Save-AntigravityUsage $name; continue }
  if ($p.usage -ne 'claude-usage') { Write-Output "${name}: 조회 안 됨(providers.json의 usage 칸)"; continue }
  if (-not $claude) { Save-UsageFailure (Get-UsageKey $name -Clean) "claude 없음: $claudeError"; Write-Output "${name}: 사용량을 읽지 못했어요 — $claudeError"; continue }

  # 공급자 환경은 자식 프로세스 안에서만 바꾼다(다른 계정의 설정 폴더·토큰이 이 창에 남지 않게).
  # 기록 이름(계정)도 그 안에서 정한다: 조회한 claude와 같은 환경(Use-Provider 뒤)에서 읽어야 실제로 조회한 계정이다.
  $job = Start-Job -ArgumentList $ScriptsDir, $name, $claude, $probe -ScriptBlock {
    param($scripts, $name, $claude, $probe)
    . "$scripts\lib\common.ps1"
    . "$scripts\lib\providers.ps1"
    Clear-HostClaudeEnv
    $null = Use-Provider $name
    Set-Location $probe
    $OutputEncoding = [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
    $key = Get-UsageKey $name
    [pscustomobject]@{ Key = $key; Text = (& $claude -p '/usage' --model haiku --strict-mcp-config 2>&1 | Out-String) }
  }
  if (-not (Wait-Job $job -Timeout 90)) { Stop-Job $job; Remove-Job $job -Force; Save-UsageFailure (Get-UsageKey $name -Clean) '조회 시간 초과(90초)'; Write-Output "${name}: 조회 시간 초과(90초)"; continue }
  $result = Receive-Job $job | Select-Object -Last 1
  Remove-Job $job -Force
  $text = "$($result.Text)"
  $key = if ($result.Key) { "$($result.Key)" } else { Get-UsageKey $name -Clean }

  $session = [regex]::Match($text, 'Current session:\s*(\d+(?:\.\d+)?)%[^\r\n]*')
  $week = [regex]::Match($text, 'Current week[^:]*:\s*(\d+(?:\.\d+)?)%[^\r\n]*')
  if (-not $session.Success) {
    # API 키 로그인 등 구독이 아니면 /usage에 "Current session"이 없다(무엇을 돌려주는지는 확인 안 됨). 첫 줄을 실패 이유로 남긴다.
    $first = ($text.Trim() -split "`r?`n")[0]
    Save-UsageFailure $key $first
    Write-Output "${name}: 사용량을 읽지 못했어요 — $first"
    continue
  }
  $state = [ordered]@{
    five_hour_pct = [double]$session.Groups[1].Value
    resets_at = ConvertTo-ResetIso $session.Value
    week_pct = if ($week.Success) { [double]$week.Groups[1].Value } else { $null }
    week_resets_at = if ($week.Success) { ConvertTo-ResetIso $week.Value } else { $null }
    updated_at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    source = 'usage-command'
  }
  Write-Utf8File (Join-Path $outDir "$key.json") ($state | ConvertTo-Json -Compress)
  Clear-UsageFailure $key
  Remove-LegacyUsageFiles $name $key

  $line = "${name}: 5시간 $($state.five_hour_pct)% (초기화 $(& $fmt $state.resets_at))"
  if ($state.week_pct -ne $null) { $line += " · 주간 $($state.week_pct)% (초기화 $(& $fmt $state.week_resets_at))" }
  Write-Output $line
}
