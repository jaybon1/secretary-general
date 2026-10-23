# Claude 구독의 사용량을 토큰 없이 조회해 ~/.claude/usage/<공급자>.json에 저장하고 한 줄로 보여 준다.
# claude -p "/usage"는 모델을 부르지 않는다(토큰 0). 빈 폴더에서 MCP 없이 돌려 다른 설정이 끼지 않게 한다.
# usage-guard.mjs가 기록이 오래되면 이 스크립트를 몰래 띄워 갱신한다.
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usage.ps1 [-Provider <이름>]
#     -Provider를 안 주면 providers.json의 구독을 조회한다.
param([string]$Provider)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\claude-env.ps1"
. "$PSScriptRoot\providers.ps1"
$utf8 = Use-Utf8Console

$config = Get-ProviderConfig
$names = if ($Provider) { @($Provider) } else {
  @($config.providers.PSObject.Properties | Where-Object { $_.Value.type -eq 'claude-subscription' } | ForEach-Object Name)
}

$probe = Join-Path $env:TEMP 'secretary-usage-probe'
New-Item -ItemType Directory -Force $probe | Out-Null
$outDir = Join-Path $env:USERPROFILE '.claude\usage'
New-Item -ItemType Directory -Force $outDir | Out-Null
$claude = Get-ClaudeExe
$kst = [TimeZoneInfo]::FindSystemTimeZoneById('Korea Standard Time')

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

foreach ($name in $names) {
  $p = $config.providers.$name
  if (-not $p) { Write-Output "${name}: providers.json에 없는 공급자"; continue }
  if ($p.type -ne 'claude-subscription') { Write-Output "${name}: 무료 사용량 조회 명령이 없어요"; continue }

  # 환경은 자식 프로세스 안에서만 바꾼다(이 창의 환경변수가 바뀌지 않게).
  $job = Start-Job -ArgumentList $PSScriptRoot, $name, $claude, $probe -ScriptBlock {
    param($scripts, $name, $claude, $probe)
    . "$scripts\claude-env.ps1"
    . "$scripts\providers.ps1"
    Clear-HostClaudeEnv
    $null = Use-Provider $name
    Set-Location $probe
    $OutputEncoding = [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
    & $claude -p '/usage' --model haiku --strict-mcp-config 2>&1 | Out-String
  }
  if (-not (Wait-Job $job -Timeout 90)) { Stop-Job $job; Remove-Job $job -Force; Write-Output "${name}: 조회 시간 초과(90초)"; continue }
  $text = Receive-Job $job | Out-String
  Remove-Job $job -Force

  $session = [regex]::Match($text, 'Current session:\s*(\d+(?:\.\d+)?)%[^\r\n]*')
  $week = [regex]::Match($text, 'Current week[^:]*:\s*(\d+(?:\.\d+)?)%[^\r\n]*')
  if (-not $session.Success) {
    $first = ($text.Trim() -split "`r?`n")[0]
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
  [IO.File]::WriteAllText((Join-Path $outDir "$name.json"), ($state | ConvertTo-Json -Compress), $utf8)

  $line = "${name}: 5시간 $($state.five_hour_pct)% (초기화 $(& $fmt $state.resets_at))"
  if ($state.week_pct -ne $null) { $line += " · 주간 $($state.week_pct)% (초기화 $(& $fmt $state.week_resets_at))" }
  Write-Output $line
}
