# 비서가 직접 하더라도 비용이 큰 작업을 공급자(기본: providers.json의 default)로 한 번 돌리고 결과 글만 돌려받는다.
# 비서 세션은 구독으로 돌고 세션 안에서 공급자를 바꿀 수 없으므로 별도 claude -p 프로세스로 실행한다.
# 작업 폴더(-Folder)를 안 주면 workspaces\_run-job-home에서 돈다(공통 규칙은 그 AGENTS.md, 일마다 output/research/<날짜-일이름>/, 보고서는 남기고 받아 온 큰 재료만 다 쓰면 비서가 지운다).
# workspaces는 SECRETARY_WORKSPACE_ROOT, 없으면 비서 폴더 옆(src/core/config.ts WORKSPACE_ROOT와 같다). 그 폴더가 없으면 오류로 멈춘다
# (node src/cli.ts workspace-aux-folders가 만든다). 비서 폴더에는 업무 파일을 만들지 않는다. 긴 지시는 -PromptFile로.
# -Staff <이름>: 반복 일 담당자(src/staff/<이름>.json, src/staff/staff.ts, 예: memory-consolidation, situation-board)로 돈다.
#   작업 폴더는 workspaces\_staff\<이름>이고, 공급자·모델·effort·새 세션·기억 도구·허용/금지 도구를
#   그 파일에서 읽는다(허용 도구 목록은 그 파일 한 곳). 같은 값을 따로 주면 오류다.
# -EvalProvider <공급자>: -Staff와 함께, 담당자 설정 파일의 provider를 그 실행에서만 바꾼다(평가 세트가 시험용 DB로 담당자를 돌릴 때).
#   기억 도구를 쓰는 담당자를 개인정보를 보내지 않는 공급자로 돌리는 것은 이때만, SECRETARY_DB가 이 비서의 secretary.db가 아닌 시험용 DB일 때만 된다.
#
# Claude Code 공급자는 사용자 설정의 MCP(계정 커넥터 포함)를 붙이지 않는다(도구 설명이 매 턴 컨텍스트를 키우므로).
# 그 일에 MCP가 필요하면 -McpConfig <MCP 설정 JSON 파일>로 그것만 붙인다.
# 개인정보를 보내도 되는 Claude Code 공급자(providers.json의 personalDataAllowed, memory-mcp.ps1 Test-MemoryMcp)면 비서 기억 읽기 도구
# (recall·search_log, --readonly 기억 MCP)를 늘 함께 붙이고, 아니면 붙이지 않는다.
#   담당자 설정의 memory가 write면(기억 정리) 읽기 전용 대신 쓰기 도구가 있는 기억 MCP를 붙이고, 설정의 도구만 허용하며
#   금지 도구(파일·명령·웹)는 모두 뺀다. 기억 읽기 도구가 붙는 공급자에서만 된다(2026-11-05 결정, 2026-11-13 구독에서 personalDataAllowed로).
# -DryRun: 실행하지 않고 공급자와 MCP 인자만 찍는다(테스트용).
# Claude Code 공급자는 결과 끝에 '(재사용|새 세션) 세션: <id>'를 찍는다. -Resume을 안 주면 이 비서의 같은 공급자·작업 폴더·모델의
# 마지막 세션을 55분 안·컨텍스트 20만 토큰 미만일 때 자동으로 재사용(resume)한다(상태: 이 비서의 기록 폴더 ~/.secretary/<비서 번호>/state/run-job-sessions.json).
# 앞 일과 섞이면 안 되면 -New, 특정 세션을 재사용하려면 -Resume <id>(같은 -Folder·공급자에서).
# 호출마다 토큰·비용·시간을 같은 폴더의 run-job-calls.jsonl에 한 줄씩 남긴다(요약: scripts/run-job/run-job-stats.ps1).
# 도는 동안은 같은 폴더의 run-job-active/<PID>.json(pid, started_at, provider, model, folder, label=지시 첫 줄)을 두고 끝나면 지운다.
# -RawJson <파일>을 주면 claude -p의 json 출력(토큰·비용 포함)을 그 파일에 남긴다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/run-job.ps1 [-Provider <이름>] -Model <opus|sonnet|haiku|공급자 models의 이름> [-Effort <low|medium|high|xhigh|max>] [-Folder <폴더>] [-McpConfig <파일>] [-Resume <세션 id> | -New] [-RawJson <파일>] [-DryRun] [-Detach] (-Prompt <지시> | -PromptFile <파일>)
#     담당자로: run-job.ps1 -Staff <이름> [-EvalProvider <공급자>] [-RawJson <파일>] [-DryRun] [-Detach] (-Prompt <지시> | -PromptFile <파일>)

param(
  [string]$Provider,
  [string]$Model,
  [string]$Effort,
  [string]$Folder,
  [string]$McpConfig,
  [string]$Resume,
  [switch]$New,
  [string]$Staff,
  [string]$EvalProvider,
  [string]$RawJson,
  [string]$Prompt,
  [string]$PromptFile,
  [switch]$DryRun,
  [switch]$Detach
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\lib\common.ps1"
. "$PSScriptRoot\..\lib\providers.ps1"
. "$PSScriptRoot\..\lib\memory-mcp.ps1"
. "$PSScriptRoot\run-job-other-cli.ps1"
# 한글 지시·결과·오류 문구가 깨지지 않게, 무엇이든 내보내기 전에 표준입출력을 UTF-8로 맞춘다.
$claude = Initialize-ClaudeScript
# 결과물 상위의 workspaces 폴더(src/core/config.ts WORKSPACE_ROOT와 같다).
$workspaceRoot = if ($env:SECRETARY_WORKSPACE_ROOT) { $env:SECRETARY_WORKSPACE_ROOT } else { Join-Path (Split-Path -Parent $SecretaryRoot) 'workspaces' }
$memoryWrite = $false
$staffConfig = $null
if ($Staff) {
  if ($Staff -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { throw "담당자 이름이 아니에요: $Staff" }
  $staffFile = Join-Path $SecretaryRoot "src\staff\$Staff.json"
  if (-not (Test-Path $staffFile -PathType Leaf)) { throw "담당자 설정이 없어요: $staffFile" }
  foreach ($k in 'Provider', 'Model', 'Effort', 'Folder', 'McpConfig', 'Resume', 'New') {
    if ($PSBoundParameters.ContainsKey($k)) { throw "-Staff와 -$($k)는 함께 줄 수 없어요(값은 $staffFile 한 곳에서 정해요)." }
  }
  $staffConfig = Get-Content -Raw -Encoding UTF8 $staffFile | ConvertFrom-Json
  $Provider = if ($EvalProvider) { $EvalProvider } else { $staffConfig.provider }
  $Model = $staffConfig.model; $Effort = $staffConfig.effort
  $New = [switch][bool]$staffConfig.newSession
  $memoryWrite = $staffConfig.memory -eq 'write'
  # 담당자 폴더는 workspaces\_staff\<담당자 이름>(src/staff/staff.ts staffFolder와 같다).
  $Folder = Join-Path (Join-Path $workspaceRoot '_staff') $Staff
  # 담당자 폴더는 비서 코드가 만든다(node src/cli.ts workspace-aux-folders). 없으면 빈 폴더만 만들어 돌린다.
  if (-not (Test-Path $Folder -PathType Container)) { New-Item -ItemType Directory -Force $Folder | Out-Null }
} elseif ($EvalProvider) { throw '-EvalProvider는 -Staff와 함께만 써요.' }
$info = Use-Provider $Provider
if ($PromptFile) { $Prompt = Get-Content -Raw -Encoding UTF8 $PromptFile }
if (-not $Prompt) { throw '-Prompt나 -PromptFile이 필요해요.' }
# 공급자의 main으로 조용히 돌지 않게, 비서가 일에 맞는 모델을 늘 직접 정한다.
if (-not $Model) { throw '-Model이 필요해요. 일에 맞는 모델(opus|sonnet|haiku|공급자 models의 이름)을 정해 넘겨요.' }
if ($info.Type -eq 'claude-subscription' -and -not (Test-ClaudeLogin $claude)) {
  throw 'Claude Code 터미널 버전에 로그인돼 있지 않아요. 이 PC에서 "claude auth login"을 먼저 실행해야 해요.'
}
if ($Resume -and $info.Type -in $OtherCliTypes) {
  throw "$($info.Name) 공급자는 -Resume(세션 재사용)을 지원하지 않아요. -Resume 없이 새로 돌려요."
}
if ($Resume -and $New) { throw '-Resume과 -New는 함께 줄 수 없어요.' }
if ($RawJson) { $RawJson = [IO.Path]::GetFullPath($RawJson) }
$folderGiven = $PSBoundParameters.ContainsKey('Folder') -or $Staff
if (-not $folderGiven) {
  $Folder = Join-Path $workspaceRoot '_run-job-home'
  # 없으면 멈춘다(2026-11-09 결정). 임시 폴더에서 돌면 그 폴더의 공통 규칙(AGENTS.md)과 결과 자리가 빠진다.
  # 설치 상태 점검(setup-check) 항목 'workspace-aux-folders'(node src/cli.ts workspace-aux-folders)가 이 폴더를 만들고, 옛 이름 run-job-home이면 옮긴다.
  if (-not (Test-Path $Folder -PathType Container)) {
    throw "run-job 기본 작업 폴더가 없어요: $Folder (SECRETARY_WORKSPACE_ROOT=$($env:SECRETARY_WORKSPACE_ROOT)). 비서 폴더에서 node src/cli.ts workspace-aux-folders로 만들거나(옛 이름 run-job-home이면 옮긴다) -Folder를 주세요."
  }
}
if (-not (Test-Path $Folder -PathType Container)) { throw "작업 폴더가 없어요: $Folder" }
# 작업 폴더로 옮겨 가기 전에 절대 경로로 바꿔 둔다.
if ($McpConfig) {
  if (-not (Test-Path $McpConfig -PathType Leaf)) { throw "MCP 설정 파일이 없어요: $McpConfig" }
  $McpConfig = (Resolve-Path $McpConfig).Path
}
# 비서 폴더에서 돌면 개인정보가 공급자에게 넘어가므로, 개인정보를 보내지 않는 공급자(providers.json의 personalDataAllowed)는 막는다(providers.ps1).
Assert-SecretaryFolderProvider $info $Folder

# -Detach: 이 백그라운드 명령과 떼어 따로 돌리고 바로 끝난다(scripts/lib/detached-job.ps1). 55분 넘게 걸릴 수 있는 일에 쓰고, scripts/run-job/wait-job.ps1로 55분씩 기다린다.
if ($Detach -and -not $DryRun) {
  . "$PSScriptRoot\..\lib\detached-job.ps1"
  $label = (($Prompt -split "`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() -replace '^#+\s*', ''
  if ($label.Length -gt 60) { $label = $label.Substring(0, 60) + '…' }
  Start-DetachedSelf $PSCommandPath $PSBoundParameters $label
  exit 0
}

# 지시는 인자 대신 표준입력으로 넘겨 따옴표 문제를 피한다.

Set-Location $Folder
$Model = Resolve-ProviderModel $info $Model
# 다른 회사 CLI(Copilot, Antigravity)는 Claude Code가 아니라 따로 돌린다(run-job-other-cli.ps1). 재사용·기록은 없다.
if ($info.Type -in $OtherCliTypes) {
  if ($DryRun) { "공급자: $($info.Name) ($($info.Type)) · 다른 회사 CLI(run-job-other-cli.ps1)"; exit 0 }
  exit (Invoke-OtherCliJob $info $Model $Prompt $Folder)
}
$modelArg = @('--model', $Model)
# -Effort를 안 주면: 공간에서 돌 때는 그 공간의 effortLevel, 비서 자신의 일(-Folder 없음)은 비서와 같은 effortLevel, 그다음 공급자의 effort.
if (-not $Effort) {
  $settings = if ($PSBoundParameters.ContainsKey('Folder')) { Join-Path $PWD '.claude\settings.json' } else { (Join-Path $SecretaryRoot '.claude\settings.json') }
  if (Test-Path $settings) { $Effort = (Get-Content -Raw -Encoding UTF8 $settings | ConvertFrom-Json).effortLevel }
}
if (-not $Effort) { $Effort = $info.Effort }
$effortArg = if ($Effort) { @('--effort', $Effort) } else { @() }
# 자동 판단(auto) 모드는 구독에서만 동작하므로, 다른 공급자는 start-worker.ps1과 같은 허용 목록으로 돌린다.
# 같은 종류 조작이 한 턴에 여러 번 되풀이되면 막지 않고 알리는 훅(common.ps1 Get-RepeatHook). 담당자(-Staff)는 도구가 정해져 있어 넣지 않는다.
$repeatHooks = if ($staffConfig) { @() } else { @(Get-RepeatHook) }
# 설정 파일은 내용이 같으면 다시 쓰지 않아, 동시에 도는 run-job이 반쯤 쓴 파일을 읽지 않는다.
function Write-RunJobSettings([string]$Name, $Settings) {
  $file = Join-Path $env:TEMP $Name
  $text = $Settings | ConvertTo-Json -Depth 8
  if (-not (Test-Path $file) -or [IO.File]::ReadAllText($file) -ne $text) { Write-Utf8File $file $text }
  $file
}
$permArg = if ($info.Type -eq 'claude-subscription') {
  @('--permission-mode', 'auto') + $(if ($repeatHooks.Count) { @('--settings', (Write-RunJobSettings 'run-job-hooks.json' ([pscustomobject]@{ hooks = [pscustomobject]@{ PostToolUse = $repeatHooks } }))) } else { @() })
} else {
  # 웹 검색 도구는 다른 공급자에 없다. Bing 결과 페이지는 WebFetch로 읽힌다. 담당자는 웹 도구가 꺼져 있어 지시를 그대로 둔다(평가가 실제 지시로 재도록).
  if (-not $staffConfig) { $Prompt += "`n`n(웹 검색 도구가 없으니, 검색이 필요하면 WebFetch로 https://www.bing.com/search?q=<검색어> 를 가져와 결과를 보라.)" }
  # 허용 목록의 비서 폴더 자리({SECRETARY_DIR})를 채운 사본을 넘긴다(common.ps1 Get-WorkerPermissions).
  $perm = Get-WorkerPermissions
  if ($repeatHooks.Count) { $perm | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{ PostToolUse = $repeatHooks }) -Force }
  @('--permission-mode', 'dontAsk', '--settings', (Write-RunJobSettings 'run-job-permissions.json' $perm))
}
# claude -p는 마지막 턴 뒤 10분이 지나면 뒤에서 도는 보조 에이전트를 멈춘다. 끝날 때까지 기다리게 한다.
$env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'
$mcpArg = @('--strict-mcp-config')
# 개인정보를 보내도 되는 공급자면 비서 기억 읽기 도구(recall·search_log)를 늘 붙인다. 아니면 개인 기억이 믿기 어려운 곳으로 나가므로 붙이지 않는다.
$mcpFiles = @()
if ($staffConfig) {
  # 담당자: 기억 도구·허용/금지 도구는 담당자 설정(src/staff/<이름>.json) 한 곳에서만 정한다.
  # 평가(-EvalProvider)는 시험용 DB(SECRETARY_DB)로만 그 밖의 공급자에서 돌린다: 그 DB에는 평가 사례로 넣은 대화·기억만 있다.
  $evalDb = $EvalProvider -and $env:SECRETARY_DB -and ([IO.Path]::GetFullPath($env:SECRETARY_DB) -ne [IO.Path]::GetFullPath((Join-Path $SecretaryRoot 'secretary.db')))
  if ($staffConfig.memory -ne 'none' -and -not (Test-MemoryMcp $info) -and -not $evalDb) { throw "기억 도구를 쓰는 담당자는 개인정보를 보내도 되는 Claude Code 공급자(providers.json의 personalDataAllowed)에서만 돌아요(지금: $($info.Name)). 평가는 -EvalProvider와 시험용 SECRETARY_DB를 함께 줘요." }
  $allowed = @()
  if ($memoryWrite) {
    $mcpFiles += New-MemoryMcpConfig -Writable -Staff $Staff
    $allowed += @($staffConfig.mcpTools | ForEach-Object { "mcp__secretary__$_" })
  } elseif ($staffConfig.memory -eq 'read') {
    $mcpFiles += New-MemoryMcpConfig
    $allowed += $MemoryReadTools
  }
  if ($mcpFiles) { $mcpArg += @('--mcp-config') + $mcpFiles }
  # 내장 도구는 설정의 tools만 남긴다(기억 정리는 지연 로딩된 MCP 도구를 불러오는 ToolSearch만, 상황판은 없음).
  # 빈 목록은 --tools ""(내장 도구 없음)다. PowerShell 5.1은 빈 인자를 빼고 넘기므로 따옴표 두 개를 글자로 넘긴다.
  # --tools만으로는 Bash가 남는 것을 봐서(2026-11-05 시험) 설정의 deniedTools를 금지 목록에도 넣는다.
  $mcpArg += @('--tools', $(if (@($staffConfig.tools).Count) { @($staffConfig.tools) -join ',' } else { '""' }))
  if ($allowed.Count) { $mcpArg += @('--allowedTools', ($allowed -join ',')) }
  if (@($staffConfig.deniedTools).Count) { $mcpArg += @('--disallowedTools', (@($staffConfig.deniedTools) -join ',')) }
} else {
  if (Test-MemoryMcp $info) { $mcpFiles += New-MemoryMcpConfig }
  if ($McpConfig) { $mcpFiles += $McpConfig }
  if ($mcpFiles) { $mcpArg += @('--mcp-config') + $mcpFiles }
  if (Test-MemoryMcp $info) { $mcpArg += @('--allowedTools', ($MemoryReadTools -join ',')) }
}
if ($DryRun) { "공급자: $($info.Name) ($($info.Type)) · MCP 인자: $($mcpArg -join ' ')"; exit 0 }
# 자동 재사용: 같은 키(공급자+작업 폴더+모델)의 마지막 호출이 55분 안이고 컨텍스트가 20만 토큰 미만이면 그 세션을 재사용한다(기준: common.ps1).
# 캐시(구독 claude -p는 1시간, 읽을 때마다 연장)를 다시 쓰므로 새 세션보다 회당 비용이 약 75% 적다(2026-10-24 실측).
# 기록은 이 비서의 기록 폴더에 둔다(common.ps1 Get-SecretaryStateDir). 한 PC의 다른 비서와 따로라 남의 세션을 재사용하지 않는다.
$stateDir = Get-SecretaryStateDir
$stateFile = Join-Path $stateDir 'run-job-sessions.json'
$callsFile = Join-Path $stateDir 'run-job-calls.jsonl'
$folderFull = (Resolve-Path $Folder).Path.TrimEnd('\')
$key = "$($info.Name)|$folderFull|$Model"
try { $state = Get-Content -Raw -Encoding UTF8 $stateFile | ConvertFrom-Json } catch { $state = $null }
if (-not $state) { $state = [pscustomobject]@{} }
$last = $state.PSObject.Properties[$key].Value
$now = [DateTime]::UtcNow
$sinceMin = if ($last) { [math]::Round(($now - [DateTime]::Parse($last.at).ToUniversalTime()).TotalMinutes, 1) } else { $null }
$newReason = $null
if ($New) { $newReason = '-New' }
elseif (-not $Resume) {
  if (-not $last) { $newReason = '첫 호출' }
  elseif ($sinceMin -ge $SessionReuseMinutes) { $newReason = "$($SessionReuseMinutes)분 초과" }
  elseif ($last.context -ge $SessionReuseMaxContext) { $newReason = '컨텍스트 초과' }
  else { $Resume = $last.session_id; $autoResume = $true }
}

function Invoke-Claude([string]$sessionId) {
  $resumeArg = if ($sessionId) { @('--resume', $sessionId) } else { @() }
  # 세션 id를 얻으려고 json으로 받되, 화면에는 예전처럼 결과 글만 내고 끝에 세션 id 한 줄을 붙인다.
  $out = ($Prompt | & $claude -p @permArg @modelArg @effortArg @mcpArg @resumeArg --output-format json) -join "`n"
  $script:code = $LASTEXITCODE
  $out
}
# 도는 동안 run-job-active/<PID>.json에 시작 기록을 둬서 진행 중인 run-job을 밖에서도 알 수 있게 한다(끝나면 지운다).
$activeFile = Join-Path $stateDir "run-job-active\$PID.json"
$label = (($Prompt -split "`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() -replace '^#+\s*', ''
if ($label.Length -gt 80) { $label = $label.Substring(0, 80) + '…' }
try {
  New-Item -ItemType Directory -Force (Split-Path $activeFile) | Out-Null
  $active = [ordered]@{ pid = $PID; started_at = $now.ToString('o'); provider = $info.Name; model = $Model; folder = $folderFull; label = $label }
  Write-Utf8File $activeFile ($active | ConvertTo-Json -Compress)
} catch {}
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  $raw = Invoke-Claude $Resume
  try { $res = $raw | ConvertFrom-Json } catch { $res = $null }
  # 재사용이 실패하면(세션 없음 등은 json 대신 오류 글만 나온다) 새로 시작해서 한 번 다시 돌린다.
  if ($autoResume -and -not ($res -and $res.session_id)) {
    [Console]::Error.WriteLine("재사용 실패, 새 세션으로 다시 돌려요: $raw")
    $Resume = $null; $newReason = '재사용 실패'
    $raw = Invoke-Claude $null
    try { $res = $raw | ConvertFrom-Json } catch { $res = $null }
  }
} finally { Remove-Item $activeFile -ErrorAction SilentlyContinue }
$clock.Stop()
if ($RawJson) { Write-Utf8File $RawJson $raw }

if ($res -and $res.session_id) {
  # 재사용하면 total_cost_usd가 세션 누적값이므로, 같은 세션의 이전 누적값을 빼서 이번 호출 비용을 낸다.
  $prev = $state.PSObject.Properties.Value | Where-Object { $_.session_id -eq $res.session_id } | Select-Object -First 1
  $cost = if ($Resume -and $prev) { [math]::Round($res.total_cost_usd - $prev.total_cost_usd, 6) } elseif ($Resume) { $null } else { $res.total_cost_usd }
  $u = $res.usage
  $context = [int]$u.input_tokens + [int]$u.cache_read_input_tokens + [int]$u.cache_creation_input_tokens
  $entry = [pscustomobject]@{ session_id = $res.session_id; at = $now.ToString('o'); context = $context; total_cost_usd = $res.total_cost_usd }
  if ($state.PSObject.Properties[$key]) { $state.$key = $entry } else { $state | Add-Member -NotePropertyName $key -NotePropertyValue $entry }
  $call = [ordered]@{
    at = $now.ToString('o'); provider = $info.Name; model = $Model; folder = $folderFull; session_id = $res.session_id
    resumed = [bool]$Resume; new_reason = $newReason; minutes_since_last = $sinceMin
    total_sec = [math]::Round($clock.Elapsed.TotalSeconds, 1); duration_api_ms = $res.duration_api_ms
    input_tokens = $u.input_tokens; cache_read_input_tokens = $u.cache_read_input_tokens
    cache_creation_input_tokens = $u.cache_creation_input_tokens; output_tokens = $u.output_tokens
    ephemeral_1h_input_tokens = $u.cache_creation.ephemeral_1h_input_tokens; ephemeral_5m_input_tokens = $u.cache_creation.ephemeral_5m_input_tokens
    context = $context; cost_usd = $cost; is_error = [bool]$res.is_error
  }
  try {
    New-Item -ItemType Directory -Force $stateDir | Out-Null
    Write-Utf8File $stateFile ($state | ConvertTo-Json -Depth 4)
    Write-Utf8File $callsFile (($call | ConvertTo-Json -Compress) + "`n") -Append
  } catch { [Console]::Error.WriteLine("run-job 기록을 못 남겼어요: $_") }
}
if ($res -and $res.PSObject.Properties['result']) {
  if ($res.is_error) { [Console]::Error.WriteLine($res.result) } else { $res.result }
  if ($res.session_id) { "$(if ($Resume) { '(재사용)' } else { '(새 세션)' }) 세션: $($res.session_id)" }
} else { $raw }
exit $code
