# 비서가 직접 하더라도 비용이 큰 작업을 별도 claude -p 프로세스로 한 번 돌리고 결과 글만 돌려받는다(Claude 구독).
# 빈 세션에서 돌아 비서 대화의 긴 문맥을 매번 다시 읽지 않는다.
# 작업 폴더(-Folder)를 안 주면 임시 폴더에서 돈다(비서 폴더에는 업무 파일을 만들지 않는다). 긴 지시는 -PromptFile로.
#
# 사용자 설정의 MCP(계정 커넥터 포함)는 붙이지 않는다(도구 설명이 매 턴 문맥을 키우므로).
# 그 일에 MCP가 필요하면 -McpConfig <MCP 설정 JSON 파일>로 그것만 붙인다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job.ps1 -Model <opus|sonnet|haiku> [-Effort <low|medium|high|xhigh|max>] [-Folder <폴더>] [-McpConfig <파일>] (-Prompt <지시> | -PromptFile <파일>)

param(
  [string]$Provider,
  [string]$Model,
  [string]$Effort,
  [string]$Folder = [IO.Path]::GetTempPath(),
  [string]$McpConfig,
  [string]$Prompt,
  [string]$PromptFile
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\claude-env.ps1"
# 한글 지시·결과·오류 문구가 깨지지 않게, 무엇이든 내보내기 전에 표준입출력을 UTF-8로 맞춘다.
$null = Use-Utf8Console
. "$PSScriptRoot\providers.ps1"
Clear-HostClaudeEnv
$claude = Get-ClaudeExe
$info = Use-Provider $Provider
if ($PromptFile) { $Prompt = Get-Content -Raw -Encoding UTF8 $PromptFile }
if (-not $Prompt) { throw '-Prompt나 -PromptFile이 필요해요.' }
# 기본 모델로 조용히 돌지 않게, 비서가 일에 맞는 모델을 늘 직접 정한다.
if (-not $Model) { throw '-Model이 필요해요. 일에 맞는 모델(opus|sonnet|haiku)을 정해 넘겨요.' }
if (-not (Test-ClaudeLogin $claude)) {
  throw 'Claude Code 터미널 버전에 로그인돼 있지 않아요. 이 PC에서 "claude auth login"을 먼저 실행해야 해요.'
}
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
$mcpArg = @('--strict-mcp-config')
if ($McpConfig) { $mcpArg += @('--mcp-config', $McpConfig) }
$Prompt | & $claude -p --permission-mode auto @modelArg @effortArg @mcpArg
exit $LASTEXITCODE
