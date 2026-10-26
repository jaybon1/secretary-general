# 업무 세션을 백그라운드 Claude Code 세션(claude --bg)으로 시작한다.
# 데스크톱 앱의 start_session을 쓸 수 없을 때(원격으로 받은 지시, 앱이 아닌 세션) 쓰는 대체 경로.
# 업무 세션은 Remote Control에 붙이지 않아 다른 기기의 세션 목록에 나타나지 않는다.
# 진행은 비서가 SendMessage notify_when_idle과 watch-worker.ps1로 받아 전한다.
# 출력 끝의 "backgrounded · <짧은 id> · <이름>"에서 id를 session_ref로 기록한다. 출력 보기: worker-logs.ps1
# 재사용: 같은 공간의 업무 세션이 업무를 끝낸 지(worker-done.ps1) 55분 안이고 마지막 문맥이 8만 토큰 미만이며
# 모델·생각 깊이·-Chrome·-LockTests가 같으면, 새 세션 대신 그 세션에 새 업무를 보내고 "재사용: <id> · <이름>"을 낸다.
# 조건이 안 맞으면 그 세션을 끄고 새로 띄운다. -New면 무조건 새로 시작. 판단은 ~/.claude/usage/worker-reuse.jsonl에 쌓는다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-worker.ps1 -Folder <공간 폴더> -Name <업무이름> -Prompt <지시> [-Effort <low|medium|high|xhigh|max>] [-Chrome] [-LockTests] [-New]
# -Effort: 생각 깊이. 안 주면 공간 .claude/settings.json의 effortLevel, 그다음 providers.json의 effort, 없으면 Claude Code 기본값.
# -Chrome: 브라우저가 필요한 업무만. 이 PC의 크롬(Claude in Chrome)을 연결한다.
# -LockTests: TASK.md에 "테스트 잠금: 예"인 업무만. 테스트 파일 수정을 훅으로 막는다.

param(
  [Parameter(Mandatory)] [string]$Folder,
  [Parameter(Mandatory)] [string]$Name,
  [Parameter(Mandatory)] [string]$Prompt,
  [string]$Effort,
  [switch]$Chrome,
  [switch]$LockTests,
  [switch]$New
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\claude-env.ps1"
$null = Use-Utf8Console
. "$PSScriptRoot\providers.ps1"
Clear-HostClaudeEnv
$claude = Get-ClaudeExe
if (-not (Test-Path $Folder -PathType Container)) { throw "공간 폴더가 없어요: $Folder" }
$info = Use-Subscription
if (-not (Test-ClaudeLogin $claude)) { throw 'Claude Code 터미널 버전에 로그인돼 있지 않아요. 이 PC에서 "claude auth login"을 먼저 실행해야 해요.' }

# Windows PowerShell 5.1은 큰따옴표가 든 인자를 네이티브 프로그램에 깨뜨려 넘기므로 작은따옴표로 바꾼다.
$taskPrompt = ($Prompt -replace '"', "'") -replace '\r?\n', ' '
$safePrompt = $taskPrompt
# 백그라운드 세션에는 승인 창을 눌러 줄 사람이 없다. 명령줄에 길게 쓴 스크립트(여러 줄 따옴표, # 주석)는
# 자동 판단 모드의 안전장치가 승인 창을 띄워 세션이 멈추므로, 스크립트는 파일로 저장해 실행하게 한다.
$safePrompt += ' (공통 규칙: 이 세션은 백그라운드라 승인 창을 누를 사람이 없다. python -c, node -e처럼 명령줄에 여러 줄 스크립트를 쓰지 말고, 스크립트는 작업 폴더 안의 파일로 저장한 뒤 그 파일을 실행하라. 명령이 실패하면 그 프로그램이 설치돼 있는지 먼저 확인하고, 보고할 때 권한에 막힌 것인지 프로그램이 없는 것인지 구분해 적어라. 만든 것을 실행할 수 없으면 최소한 구문(.ps1은 PowerShell 5.1 파서로)과 CLI 옵션(--help)을 확인하고, 보고서에 실행 확인 안 됨이라고 적어라.)'

$folderFull = (Resolve-Path $Folder).Path.TrimEnd('\')
# 공간이 정한 모델(.claude/settings.json의 model)을 --model로 넘긴다.
$spaceSettings = Join-Path $Folder '.claude\settings.json'
$space = if (Test-Path $spaceSettings) { Get-Content -Raw -Encoding UTF8 $spaceSettings | ConvertFrom-Json }
$model = $space.model
$modelArg = if ($model) { @('--model', $model) } else { @() }
# settings.json의 effortLevel은 Claude Code가 max를 경고 없이 버리므로 직접 읽어 --effort로 넘긴다.
if (-not $Effort) { $Effort = $space.effortLevel }
if (-not $Effort) { $Effort = $info.Effort }
$effortArg = if ($Effort) { @('--effort', $Effort) } else { @() }

# 재사용 판단: 같은 공간의 쉬는 업무 세션(worker-done.ps1이 업무 끝난 시각을 적은 것) 중 가장 최근 것을 본다.
# 캐시가 살아 있을 때 이어 쓰면 새 세션의 시작 비용(1~2.5만 토큰)을 아낀다(run-job 자동 이어 부르기와 같은 기준).
$config = Get-ClaudeConfigDir
$state = Read-WorkerState
$now = [DateTime]::UtcNow
$idle = @($state.PSObject.Properties | ForEach-Object { $_.Value } |
  Where-Object { $_.folder -eq $folderFull -and $_.done_at } |
  Sort-Object { [DateTime]::Parse($_.done_at) } -Descending)
$prev = $idle | Select-Object -First 1
$log = [ordered]@{ at = $now.ToString('o'); folder = $folderFull; name = $Name; id = $null
  reused = $false; new_reason = $null; minutes_since_done = $null; context = $null }
if ($prev) {
  $log.minutes_since_done = [math]::Round(($now - [DateTime]::Parse($prev.done_at).ToUniversalTime()).TotalMinutes, 1)
  $alive = (& $claude agents --json | ConvertFrom-Json) | Where-Object { $_.id -eq $prev.id } | Select-Object -First 1
  if ($alive) { $log.context = Get-SessionContext $config $alive.sessionId }
  if ($New) { $log.new_reason = '-New' }
  elseif (-not $alive) { $log.new_reason = '세션 없음' }
  elseif ($log.minutes_since_done -ge 55) { $log.new_reason = '55분 초과' }
  elseif ($null -eq $log.context) { $log.new_reason = '문맥 모름' }
  elseif ($log.context -ge 80000) { $log.new_reason = '문맥 초과' }
  elseif ($prev.model -ne $model -or $prev.effort -ne $Effort -or [bool]$prev.chrome -ne [bool]$Chrome -or [bool]$prev.lock_tests -ne [bool]$LockTests) { $log.new_reason = '설정 다름' }
  else {
    $n = [int]$prev.tasks + 1
    $msg = "새 업무 #$($n): 앞 업무는 끝났다. 앞 업무와 섞지 말고 아래 지시만 따르라(앞 업무의 파일·결정은 이번 지시서에 없으면 쓰지 않고, 보고서는 이번 업무 폴더에 따로 쓴다). 지시: $taskPrompt"
    $sent = Send-WorkerMessage $claude $alive $msg
    if ($sent -match '보냄') {
      $prev.done_at = $null; $prev.tasks = $n; $prev.task_name = $Name
      Save-WorkerState $state
      $log.id = $prev.id; $log.reused = $true
      Add-WorkerReuseLog $log
      Write-Output "재사용: $($prev.id) · $($prev.name) (새 업무 #$n, 업무 끝난 지 $($log.minutes_since_done)분, 문맥 $($log.context) 토큰)"
      exit 0
    }
    $log.new_reason = '보내기 실패'
    [Console]::Error.WriteLine("쉬는 업무 세션 $($prev.id)에 새 업무를 못 보냈어요: $sent")
  }
} else { $log.new_reason = if ($New) { '-New' } else { '쉬는 세션 없음' } }
# 재사용하지 않은 쉬는 세션은 끈다(공간마다 한 명). 일하는 중인 세션(업무 끝난 시각 없음)은 건드리지 않는다.
foreach ($old in $idle) {
  try { & $claude stop $old.id *> $null } catch {}
  $state.PSObject.Properties.Remove($old.id)
}

Set-Location $Folder
# 백그라운드 세션은 상위 폴더 신뢰를 이어받지 않으므로, 신뢰된 상위 폴더 아래 공간이면 설정에 신뢰를 적는다.
node "$PSScriptRoot\trust-folder.mjs" $folderFull
# --chrome 옵션을 claude --bg와 함께 쓰면 지시가 "-"로 바뀌어 업무 세션이 지시 없이 시작된다.
# 그래서 옵션 대신 환경변수로 크롬을 켠다(비서 서버 remote-server.ps1과 같은 방식).
if ($Chrome) { $env:CLAUDE_CODE_ENABLE_CFC = '1' }
# 백그라운드 세션은 git 저장소에서 파일을 고치기 전에 git worktree(.claude/worktrees/)로 옮겨 가도록 강제돼,
# 결과가 공간의 output/이 아니라 사본 폴더에 생긴다. 업무 하나에 세션 하나라 격리가 필요 없으므로 제자리에서 일하게 한다.
# 환경변수 CLAUDE_BG_ISOLATION은 이미 떠 있는 백그라운드 서비스에 전달되지 않아서 --settings로 넘긴다.
$workerSettings = [pscustomobject]@{ worktree = [pscustomobject]@{ bgIsolation = 'none' } }
# 공간 밖 쓰기, git push, 게시·업로드, 큰 삭제(-LockTests면 테스트 파일 수정도)를 훅으로 막는다(worker-guard.mjs).
$guard = "node `"$PSScriptRoot\worker-guard.mjs`" `"$folderFull`"" + $(if ($LockTests) { ' --lock-tests' } else { '' })
$guardHook = [pscustomobject]@{ matcher = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'; hooks = @([pscustomobject]@{ type = 'command'; command = $guard; timeout = 5 }) }
$workerSettings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{ PreToolUse = @($guardHook) }) -Force
# 계정에 붙인 claude.ai 커넥터는 업무에 쓰지 않으므로 업무 세션에는 붙이지 않는다(도구 설명이 매 턴 문맥을 키운다).
$workerSettings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{ ENABLE_CLAUDEAI_MCP_SERVERS = 'false' }) -Force
$settingsFile = Join-Path $env:TEMP "worker-settings-$Name.json"
[IO.File]::WriteAllText($settingsFile, ($workerSettings | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
# id를 읽으려고 출력을 받아 둔다. PowerShell 5.1은 Stop일 때 네이티브 프로그램의 오류 출력을 예외로 바꾸므로 잠시 Continue로 둔다.
$ErrorActionPreference = 'Continue'
$out = @(& $claude --bg --name $Name @modelArg @effortArg --permission-mode auto --settings $settingsFile $safePrompt 2>&1 | ForEach-Object { "$_" })
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$out
# 새 세션을 상태 파일에 적어 두면, 업무가 끝난 뒤(worker-done.ps1) 같은 공간의 다음 업무가 이어 쓸 수 있다.
if (($out -join "`n") -match 'backgrounded\W+([0-9a-f]{6,})') {
  $id = $Matches[1]
  $entry = [pscustomobject]@{ id = $id; name = $Name; task_name = $Name; folder = $folderFull
    model = $model; effort = $Effort; chrome = [bool]$Chrome; lock_tests = [bool]$LockTests; started_at = $now.ToString('o'); done_at = $null; tasks = 1 }
  $state | Add-Member -NotePropertyName $id -NotePropertyValue $entry -Force
  $log.id = $id
}
try { Save-WorkerState $state } catch { [Console]::Error.WriteLine("업무 세션 상태를 못 남겼어요: $_") }
Add-WorkerReuseLog $log
exit $code
