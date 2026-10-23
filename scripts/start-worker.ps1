# 업무 세션을 백그라운드 Claude Code 세션(claude --bg)으로 시작한다.
# 데스크톱 앱의 start_session을 쓸 수 없을 때(원격으로 받은 지시, 앱이 아닌 세션) 쓰는 대체 경로.
# 업무 세션은 Remote Control에 붙이지 않아 다른 기기의 세션 목록에 나타나지 않는다.
# 진행은 비서가 SendMessage notify_when_idle과 watch-worker.ps1로 받아 전한다.
# 출력 끝의 "backgrounded · <짧은 id> · <이름>"에서 id를 session_ref로 기록한다. 출력 보기: worker-logs.ps1
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-worker.ps1 -Folder <공간 폴더> -Name <업무이름> -Prompt <지시> [-Effort <low|medium|high|xhigh|max>] [-Chrome]
# -Effort: 생각 깊이. 안 주면 공간 .claude/settings.json의 effortLevel, 그다음 providers.json의 effort, 없으면 Claude Code 기본값.
# -Chrome: 브라우저가 필요한 업무만. 이 PC의 크롬(Claude in Chrome)을 연결한다.

param(
  [Parameter(Mandatory)] [string]$Folder,
  [Parameter(Mandatory)] [string]$Name,
  [Parameter(Mandatory)] [string]$Prompt,
  [string]$Provider,
  [string]$Effort,
  [switch]$Chrome
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\claude-env.ps1"
$null = Use-Utf8Console
. "$PSScriptRoot\providers.ps1"
Clear-HostClaudeEnv
$claude = Get-ClaudeExe
if (-not (Test-Path $Folder -PathType Container)) { throw "공간 폴더가 없어요: $Folder" }
$info = Use-Provider $Provider
if (-not (Test-ClaudeLogin $claude)) { throw 'Claude Code 터미널 버전에 로그인돼 있지 않아요. 이 PC에서 "claude auth login"을 먼저 실행해야 해요.' }

# Windows PowerShell 5.1은 큰따옴표가 든 인자를 네이티브 프로그램에 깨뜨려 넘기므로 작은따옴표로 바꾼다.
$safePrompt = ($Prompt -replace '"', "'") -replace '\r?\n', ' '
# 백그라운드 세션에는 승인 창을 눌러 줄 사람이 없다. 명령줄에 길게 쓴 스크립트(여러 줄 따옴표, # 주석)는
# 자동 판단 모드의 안전장치가 승인 창을 띄워 세션이 멈추므로, 스크립트는 파일로 저장해 실행하게 한다.
$safePrompt += ' (공통 규칙: 이 세션은 백그라운드라 승인 창을 누를 사람이 없다. python -c, node -e처럼 명령줄에 여러 줄 스크립트를 쓰지 말고, 스크립트는 작업 폴더 안의 파일로 저장한 뒤 그 파일을 실행하라. 명령이 실패하면 그 프로그램이 설치돼 있는지 먼저 확인하고, 보고할 때 권한에 막힌 것인지 프로그램이 없는 것인지 구분해 적어라. 만든 것을 실행할 수 없으면 최소한 구문(.ps1은 PowerShell 5.1 파서로)과 CLI 옵션(--help)을 확인하고, 보고서에 실행 확인 안 됨이라고 적어라.)'

Set-Location $Folder
# 공간이 정한 모델(.claude/settings.json의 model)을 --model로 넘긴다.
$spaceSettings = Join-Path $Folder '.claude\settings.json'
$space = if (Test-Path $spaceSettings) { Get-Content -Raw -Encoding UTF8 $spaceSettings | ConvertFrom-Json }
$modelArg = if ($space.model) { @('--model', $space.model) } else { @() }
# settings.json의 effortLevel은 Claude Code가 max를 경고 없이 버리므로 직접 읽어 --effort로 넘긴다.
if (-not $Effort) { $Effort = $space.effortLevel }
if (-not $Effort) { $Effort = $info.Effort }
$effortArg = if ($Effort) { @('--effort', $Effort) } else { @() }
# --chrome 옵션을 claude --bg와 함께 쓰면 지시가 "-"로 바뀌어 업무 세션이 지시 없이 시작된다.
# 그래서 옵션 대신 환경변수로 크롬을 켠다(비서 서버 remote-server.ps1과 같은 방식).
if ($Chrome) { $env:CLAUDE_CODE_ENABLE_CFC = '1' }
& $claude --bg --name $Name @modelArg @effortArg --permission-mode auto $safePrompt
exit $LASTEXITCODE
