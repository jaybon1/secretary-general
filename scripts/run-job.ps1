# 비서가 직접 하더라도 비용이 큰 작업을 별도 claude -p 프로세스로 한 번 돌리고 결과 글만 돌려받는다(Claude 구독).
# 빈 세션에서 돌아 비서 대화의 긴 문맥을 매번 다시 읽지 않는다. 긴 지시는 -PromptFile로.
# 작업 폴더(-Folder)를 안 주면 비서 폴더 옆 run-job-home에서 돈다(없으면 만든다). 일마다 그 output/research/<날짜-일이름>/를 쓰고,
# 보고서는 남기고 받아 온 큰 재료만 다 쓰면 비서가 지운다. 비서 폴더에는 업무 파일을 만들지 않는다.
#
# 사용자 설정의 MCP(계정 커넥터 포함)는 붙이지 않는다(도구 설명이 매 턴 문맥을 키우므로).
# 그 일에 MCP가 필요하면 -McpConfig <MCP 설정 JSON 파일>로 그것만 붙인다.
# 결과 끝에 '(이어 부름|새 세션) 세션: <id>'를 찍는다. -Resume을 안 주면 같은 작업 폴더·모델의
# 마지막 세션을 55분 안·문맥 8만 토큰 미만일 때 자동으로 이어 부른다(상태: ~/.claude/usage/run-job-sessions.json).
# 앞 일과 섞이면 안 되면 -New, 특정 세션을 이어 쓰려면 -Resume <id>(같은 -Folder에서).
# 호출마다 토큰·비용·시간을 ~/.claude/usage/run-job-calls.jsonl에 한 줄씩 남긴다(요약: scripts/run-job-stats.ps1).
# -RawJson <파일>을 주면 claude -p의 json 출력(토큰·비용 포함)을 그 파일에 남긴다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job.ps1 -Model <opus|sonnet|haiku> [-Effort <low|medium|high|xhigh|max>] [-Folder <폴더>] [-McpConfig <파일>] [-Resume <세션 id> | -New] [-RawJson <파일>] (-Prompt <지시> | -PromptFile <파일>)

param(
  [string]$Model,
  [string]$Effort,
  [string]$Folder = "$PSScriptRoot\..\..\run-job-home",
  [string]$McpConfig,
  [string]$Resume,
  [switch]$New,
  [string]$RawJson,
  [string]$Prompt,
  [string]$PromptFile
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\claude-env.ps1"
# 한글 지시·결과·오류 문구가 깨지지 않게, 무엇이든 내보내기 전에 표준입출력을 UTF-8로 맞춘다.
$utf8 = Use-Utf8Console
. "$PSScriptRoot\providers.ps1"
Clear-HostClaudeEnv
$claude = Get-ClaudeExe
$info = Use-Subscription
if ($PromptFile) { $Prompt = Get-Content -Raw -Encoding UTF8 $PromptFile }
if (-not $Prompt) { throw '-Prompt나 -PromptFile이 필요해요.' }
# 기본 모델로 조용히 돌지 않게, 비서가 일에 맞는 모델을 늘 직접 정한다.
if (-not $Model) { throw '-Model이 필요해요. 일에 맞는 모델(opus|sonnet|haiku)을 정해 넘겨요.' }
if (-not (Test-ClaudeLogin $claude)) {
  throw 'Claude Code 터미널 버전에 로그인돼 있지 않아요. 이 PC에서 "claude auth login"을 먼저 실행해야 해요.'
}
if ($Resume -and $New) { throw '-Resume과 -New는 함께 줄 수 없어요.' }
if ($RawJson) { $RawJson = [IO.Path]::GetFullPath($RawJson) }
if (-not $PSBoundParameters.ContainsKey('Folder')) { New-Item -ItemType Directory -Force (Join-Path $Folder 'output\research') | Out-Null }
if (-not (Test-Path $Folder -PathType Container)) { throw "작업 폴더가 없어요: $Folder" }
# 작업 폴더로 옮겨 가기 전에 절대 경로로 바꿔 둔다.
if ($McpConfig) {
  if (-not (Test-Path $McpConfig -PathType Leaf)) { throw "MCP 설정 파일이 없어요: $McpConfig" }
  $McpConfig = (Resolve-Path $McpConfig).Path
}

# 지시는 인자 대신 표준입력으로 넘겨 따옴표 문제를 피한다.

Set-Location $Folder
$modelArg = @('--model', $Model)
# -Effort를 안 주면: 공간에서 돌 때는 그 공간의 effortLevel, 비서 자신의 일(-Folder 없음)은 비서와 같은 effortLevel, 그다음 공급자의 effort.
if (-not $Effort) {
  $settings = if ($PSBoundParameters.ContainsKey('Folder')) { Join-Path $PWD '.claude\settings.json' } else { "$PSScriptRoot\..\.claude\settings.json" }
  if (Test-Path $settings) { $Effort = (Get-Content -Raw -Encoding UTF8 $settings | ConvertFrom-Json).effortLevel }
}
if (-not $Effort) { $Effort = $info.Effort }
$effortArg = if ($Effort) { @('--effort', $Effort) } else { @() }
# claude -p는 마지막 턴 뒤 10분이 지나면 뒤에서 도는 보조 에이전트를 멈춘다. 끝날 때까지 기다리게 한다.
$env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'
$mcpArg = @('--strict-mcp-config')
if ($McpConfig) { $mcpArg += @('--mcp-config', $McpConfig) }
# 자동 이어 부르기: 같은 키(작업 폴더+모델)의 마지막 호출이 55분 안이고 문맥이 8만 토큰 미만이면 그 세션을 이어 부른다.
# 캐시(구독 claude -p는 1시간, 읽을 때마다 연장)를 다시 쓰므로 새 세션보다 회당 비용이 적다.
$usageDir = Join-Path $env:USERPROFILE '.claude\usage'
$stateFile = Join-Path $usageDir 'run-job-sessions.json'
$callsFile = Join-Path $usageDir 'run-job-calls.jsonl'
$folderFull = (Resolve-Path $Folder).Path.TrimEnd('\')
$key = "$folderFull|$Model"
try { $state = Get-Content -Raw -Encoding UTF8 $stateFile | ConvertFrom-Json } catch { $state = $null }
if (-not $state) { $state = [pscustomobject]@{} }
$last = $state.PSObject.Properties[$key].Value
$now = [DateTime]::UtcNow
$sinceMin = if ($last) { [math]::Round(($now - [DateTime]::Parse($last.at).ToUniversalTime()).TotalMinutes, 1) } else { $null }
$newReason = $null
if ($New) { $newReason = '-New' }
elseif (-not $Resume) {
  if (-not $last) { $newReason = '첫 호출' }
  elseif ($sinceMin -ge 55) { $newReason = '55분 초과' }
  elseif ($last.context -ge 80000) { $newReason = '문맥 초과' }
  else { $Resume = $last.session_id; $autoResume = $true }
}

function Invoke-Claude([string]$sessionId) {
  $resumeArg = if ($sessionId) { @('--resume', $sessionId) } else { @() }
  # 세션 id를 얻으려고 json으로 받되, 화면에는 결과 글만 내고 끝에 세션 id 한 줄을 붙인다.
  $out = ($Prompt | & $claude -p --permission-mode auto @modelArg @effortArg @mcpArg @resumeArg --output-format json) -join "`n"
  $script:code = $LASTEXITCODE
  $out
}
$clock = [Diagnostics.Stopwatch]::StartNew()
$raw = Invoke-Claude $Resume
try { $res = $raw | ConvertFrom-Json } catch { $res = $null }
# 이어 부르기가 실패하면(세션 없음 등은 json 대신 오류 글만 나온다) 새로 시작해서 한 번 다시 돌린다.
if ($autoResume -and -not ($res -and $res.session_id)) {
  [Console]::Error.WriteLine("이어 부르기 실패, 새 세션으로 다시 돌려요: $raw")
  $Resume = $null; $newReason = '이어 부르기 실패'
  $raw = Invoke-Claude $null
  try { $res = $raw | ConvertFrom-Json } catch { $res = $null }
}
$clock.Stop()
if ($RawJson) { [IO.File]::WriteAllText($RawJson, $raw, $utf8) }

if ($res -and $res.session_id) {
  # 이어 부르면 total_cost_usd가 세션 누적값이므로, 같은 세션의 이전 누적값을 빼서 이번 호출 비용을 낸다.
  $prev = $state.PSObject.Properties.Value | Where-Object { $_.session_id -eq $res.session_id } | Select-Object -First 1
  $cost = if ($Resume -and $prev) { [math]::Round($res.total_cost_usd - $prev.total_cost_usd, 6) } elseif ($Resume) { $null } else { $res.total_cost_usd }
  $u = $res.usage
  $context = [int]$u.input_tokens + [int]$u.cache_read_input_tokens + [int]$u.cache_creation_input_tokens
  $entry = [pscustomobject]@{ session_id = $res.session_id; at = $now.ToString('o'); context = $context; total_cost_usd = $res.total_cost_usd }
  if ($state.PSObject.Properties[$key]) { $state.$key = $entry } else { $state | Add-Member -NotePropertyName $key -NotePropertyValue $entry }
  $call = [ordered]@{
    at = $now.ToString('o'); model = $Model; folder = $folderFull; session_id = $res.session_id
    resumed = [bool]$Resume; new_reason = $newReason; minutes_since_last = $sinceMin
    total_sec = [math]::Round($clock.Elapsed.TotalSeconds, 1); duration_api_ms = $res.duration_api_ms
    input_tokens = $u.input_tokens; cache_read_input_tokens = $u.cache_read_input_tokens
    cache_creation_input_tokens = $u.cache_creation_input_tokens; output_tokens = $u.output_tokens
    ephemeral_1h_input_tokens = $u.cache_creation.ephemeral_1h_input_tokens; ephemeral_5m_input_tokens = $u.cache_creation.ephemeral_5m_input_tokens
    context = $context; cost_usd = $cost; is_error = [bool]$res.is_error
  }
  try {
    New-Item -ItemType Directory -Force $usageDir | Out-Null
    [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 4), $utf8)
    [IO.File]::AppendAllText($callsFile, (($call | ConvertTo-Json -Compress) + "`n"), $utf8)
  } catch { [Console]::Error.WriteLine("run-job 기록을 못 남겼어요: $_") }
}
if ($res -and $res.PSObject.Properties['result']) {
  if ($res.is_error) { [Console]::Error.WriteLine($res.result) } else { $res.result }
  if ($res.session_id) { "$(if ($Resume) { '(이어 부름)' } else { '(새 세션)' }) 세션: $($res.session_id)" }
} else { $raw }
exit $code
