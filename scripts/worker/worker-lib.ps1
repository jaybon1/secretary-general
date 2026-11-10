# 업무 세션(백그라운드 claude --bg) 다루기를 한곳에 모은 공용 모듈. 입구 스크립트 넷이 dot-source 해서 함수 하나를 부른다:
#   start-worker.ps1 → Start-Worker, send-worker.ps1 → Send-Worker, worker-logs.ps1 → Show-WorkerLogs, worker-done.ps1 → Complete-Worker
# 입구를 파일별로 남긴 것은 권한 허용 목록이 스크립트 이름으로 구분하기 때문이다(예: 시작은 허용, 끄기는 따로). 이름·인자·출력은 입구 머리말 그대로.
# watch-worker.ps1(감시)도 여기의 Find-WorkerSession을 쓴다.
# 재사용 상태: 이 비서의 기록 폴더(~/.secretary/<비서 번호>/state, common.ps1 Get-SecretaryStateDir)의 worker-sessions.json
# (bg id → 공간·공급자·설정 폴더·업무 끝난 시각), 판단 기록: 같은 폴더의 worker-reuse.jsonl.

. "$PSScriptRoot\..\lib\common.ps1"
. "$PSScriptRoot\..\lib\providers.ps1"
. "$PSScriptRoot\..\lib\memory-mcp.ps1"

# 업무 세션 훅(worker-folder-guard.mjs)에 넘길 비서 폴더 인자: ' --secretary "<긴 이름>"'과, 다르면 ' --secretary "<8.3 짧은 이름>"'.
# 셸 명령이 이 비서 폴더를 어느 꼴로 적어도(8.3 짧은 이름 꼴 PROGRA~1 같은 것 포함) 훅이 알아본다. 짧은 이름을 못 구하면 긴 이름만.
function Get-SecretaryGuardArgs([string]$Root = $SecretaryRoot) {
  $long = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $forms = @($long)
  try {
    $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($long).ShortPath.TrimEnd('\')
    if ($short -and $short -ne $long) { $forms += $short }
  } catch {}
  -join ($forms | ForEach-Object { " --secretary `"$_`"" })
}

# 'bg:1234abcd'처럼 기록된 session_ref도 받는다.
function ConvertTo-WorkerId([string]$Id) { $Id -replace '^bg:', '' }

# 업무 세션은 공급자마다 다른 설정 폴더(CLAUDE_CONFIG_DIR, 예: 두 번째 구독)에서 돌아서, 기본 설정 폴더의
# claude agents/logs로는 보이지 않는다. id가 보이는 설정 폴더를 찾아 이 프로세스에 넣고 목록 항목을 돌려준다. 없으면 $null.
function Find-WorkerSession([string]$Claude, [string]$Id) {
  foreach ($dir in Get-AccountConfigDirs) {
    if ($dir) { $env:CLAUDE_CONFIG_DIR = $dir } else { Remove-Item env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
    $hit = (& $Claude agents --json | ConvertFrom-Json) | Where-Object { $_.sessionId -like "$Id*" -or $_.id -like "$Id*" } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  Remove-Item env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
  $null
}

# 업무 세션의 작업 상태 파일(<설정 폴더>\jobs\<짧은 id>\state.json, 백그라운드 서비스가 씀). 못 읽으면 $null.
# tempo: active(모델이 일하는 중) | idle | blocked, state: working | done | blocked, fan: 뒤에서 도는 명령 목록.
function Read-WorkerJob([string]$ConfigDir, [string]$Id) {
  try { Get-Content -Raw -Encoding UTF8 -ErrorAction Stop (Join-Path $ConfigDir "jobs\$Id\state.json") | ConvertFrom-Json } catch { $null }
}

# 업무 세션이 턴을 끝내고 쉬는지. $Alive는 claude agents 목록 항목, $Job은 Read-WorkerJob 결과. 일하는 중이면 $null,
# 쉬면 @{ status; state; leftover = @(뒤에서 도는 명령 설명) }.
# claude agents의 status는 턴이 끝나도 뒤에서 도는 명령(run_in_background, 2분을 넘겨 뒤로 넘어간 명령)이 남아 있으면 busy다.
# 2026-11-05 한 업무는 끝난 명령이 멈춘 채 남아 status=busy로 50분 남았고 감시가 쉼을 놓쳤다. 그래서 status가 busy여도
# 모델이 쉬고(tempo idle·blocked) 결과나 질문을 냈으면(state done·blocked) 쉼으로 본다. 뒤에서 도는 명령을 기다리며 쉬는
# 세션(state working)은 그 명령이 끝나면 이어서 일하므로 일하는 중으로 둔다.
function Get-WorkerRest($Alive, $Job) {
  if ($Alive.status -ne 'busy') { return @{ status = "$($Alive.status)"; state = "$($Alive.state)"; leftover = @() } }
  if (-not $Job -or $Job.tempo -notin 'idle', 'blocked' -or $Job.state -notin 'done', 'blocked') { return $null }
  $leftover = @($Job.fan | Where-Object { $_ } | ForEach-Object {
      $label = "$($_.label)" -replace '\s+', ' '
      if ($label.Length -gt 80) { $label = $label.Substring(0, 80) + '…' }
      "$($_.kind) $($_.id): $label"
    })
  @{ status = 'busy'; state = "$($Job.state)"; leftover = $leftover }
}

# 그 세션이 보이는 설정 폴더에서 업무 세션에 메시지를 넣는다. 다른 설정 폴더의 세션에는 비서의 SendMessage가 닿지 않아,
# 짧은 claude -p(Haiku, 도구는 ListAgents·SendMessage만)를 띄워 대신 보낸다. $Hit은 claude agents 목록 항목. 출력 글을 돌려준다.
function Send-WorkerMessage([string]$Claude, $Hit, [string]$Message) {
  # Windows PowerShell 5.1은 큰따옴표가 든 인자를 깨뜨려 넘기므로 작은따옴표로 바꾼다.
  $body = ($Message -replace '"', "'") -replace '\r?\n', ' '
  $prompt = "ListAgents로 세션 목록을 보고, 이름이 정확히 $($Hit.name) 인 세션을 찾아라(ListAgents의 대괄호 id는 bg id $($Hit.id) 와 다르다). 그 세션에 SendMessage로 아래 <msg> 안의 글을 한 글자도 바꾸지 말고 보내라. 보냈으면 '보냄'이라고만, 못 찾았으면 '못 찾음'이라고만 답하라. <msg>$body</msg>"
  # 받는 세션은 보낸 세션의 권한 모드 종류가 자기와 다르면 메시지를 붙잡아 두고 승인을 기다린다.
  # 다른 설정 폴더의 업무 세션은 구독이라 auto 모드로 도므로 같은 auto로 보낸다.
  # 보내는 쪽이 신뢰되지 않은 폴더에서 돌면 받는 세션이 메시지를 붙잡아 두므로, 업무 세션과 같은 공간 폴더에서 보낸다.
  Push-Location $Hit.cwd
  try { (& $Claude -p --model haiku --strict-mcp-config --disable-slash-commands --no-session-persistence --tools ListAgents,SendMessage --allowedTools ListAgents,SendMessage --permission-mode auto $prompt) -join "`n" }
  finally { Pop-Location }
}

# 세션의 마지막 문맥 크기: 대화 기록(<설정 폴더>\projects\*\<세션 id>.jsonl) 끝 4MB에서 마지막 모델 호출의 usage
# input + cache_read + cache_creation. 계산은 비서 프롬프트 훅과 같은 코드(node src/cli.ts context-tokens). 기록을 못 찾으면 $null.
function Get-SessionContext([string]$ConfigDir, [string]$SessionId) {
  if (-not $SessionId) { return $null }
  $file = Get-ChildItem (Join-Path $ConfigDir 'projects') -Recurse -Filter "$SessionId.jsonl" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $file) { return $null }
  # node가 오류를 내면(읽기 실패 등) Stop 설정에서 예외가 되므로 모름($null)으로 둔다.
  try { $out = "$(& node --no-warnings (Join-Path $SecretaryRoot 'src\cli.ts') context-tokens $file.FullName 2>$null)".Trim() } catch { return $null }
  if ($out -match '^\d+$') { [int]$out } else { $null }
}

function Get-WorkerStateFile { Join-Path (Get-SecretaryStateDir) 'worker-sessions.json' }
function Read-WorkerState {
  try { $s = Get-Content -Raw -Encoding UTF8 (Get-WorkerStateFile) | ConvertFrom-Json } catch { $s = $null }
  if (-not $s) { $s = [pscustomobject]@{} }
  $s
}
function Save-WorkerState($State) {
  New-Item -ItemType Directory -Force (Get-SecretaryStateDir) | Out-Null
  Write-Utf8File (Get-WorkerStateFile) ($State | ConvertTo-Json -Depth 4)
}
# 상태 파일의 model 값: 공간이 모델을 정하지 않았으면 $null(JSON null). 값 없는 if 식을 그대로 저장하면
# PowerShell 5.1이 {}로 써서, 다시 읽은 {}가 늘 "설정 다름"이 되어 이어 쓰기가 안 됐다. 그때 저장된 {}도 $null로 읽는다.
function ConvertTo-WorkerModel($Value) {
  if ($Value -is [string] -and $Value) { return $Value }
  return $null
}
# 쉬는 업무 세션($Prev, 상태 파일 항목)의 설정이 이번 업무와 다르면 $true. effort는 없을 때 null·빈 글을 같은 것으로 본다.
function Test-WorkerSettingsDiffer($Prev, $Model, [string]$Effort, [bool]$Chrome, [bool]$LockTests) {
  (ConvertTo-WorkerModel $Prev.model) -ne (ConvertTo-WorkerModel $Model) -or "$($Prev.effort)" -ne $Effort -or
    [bool]$Prev.chrome -ne $Chrome -or [bool]$Prev.lock_tests -ne $LockTests
}
function Add-WorkerReuseLog($Entry) {
  try {
    $dir = Get-SecretaryStateDir
    New-Item -ItemType Directory -Force $dir | Out-Null
    Write-Utf8File (Join-Path $dir 'worker-reuse.jsonl') (($Entry | ConvertTo-Json -Compress) + "`n") -Append
  } catch { [Console]::Error.WriteLine("업무 세션 재사용 기록을 못 남겼어요: $_") }
}

# ---- start-worker.ps1 ------------------------------------------------------------------------

function Start-Worker([string]$Folder, [string]$Name, [string]$Prompt, [string]$Provider, [string]$Effort, [switch]$Chrome, [switch]$LockTests, [switch]$New, [switch]$DryRun) {
  $claude = Initialize-ClaudeScript
  if (-not (Test-Path $Folder -PathType Container)) { throw "공간 폴더가 없어요: $Folder" }
  $info = Use-Provider $Provider
  if ($info.Type -notlike 'claude-*') { throw "'$($info.Name)'($($info.Type))는 Claude Code가 아니라 업무 세션에 못 써요. 결과만 받는 일은 run-job.ps1 -Provider $($info.Name)로 돌려요." }
  if ($info.Type -eq 'claude-subscription' -and -not (Test-ClaudeLogin $claude)) { throw 'Claude Code 터미널 버전에 로그인돼 있지 않아요. 이 PC에서 "claude auth login"을 먼저 실행해야 해요.' }
  Write-Output "공급자: $($info.Name)"

  # Windows PowerShell 5.1은 큰따옴표가 든 인자를 네이티브 프로그램에 깨뜨려 넘기므로 작은따옴표로 바꾼다.
  $taskPrompt = ($Prompt -replace '"', "'") -replace '\r?\n', ' '
  $safePrompt = $taskPrompt
  # 백그라운드 세션에는 승인 창을 눌러 줄 사람이 없다. 명령줄에 길게 쓴 스크립트(여러 줄 따옴표, # 주석)는
  # 자동 판단 모드의 안전장치가 승인 창을 띄워 세션이 멈추므로, 스크립트는 파일로 저장해 실행하게 한다.
  $safePrompt += ' (공통 규칙: 이 세션은 백그라운드라 승인 창을 누를 사람이 없다. python -c, node -e처럼 명령줄에 여러 줄 스크립트를 쓰지 말고, 스크립트는 작업 폴더 안의 파일로 저장한 뒤 그 파일을 실행하라. 명령이 실패하면 그 프로그램이 설치돼 있는지 먼저 확인하고, 보고할 때 권한에 막힌 것인지 프로그램이 없는 것인지 구분해 적어라. 만든 것을 실행할 수 없으면 최소한 구문(.ps1은 PowerShell 5.1 파서로)과 CLI 옵션(--help)을 확인하고, 보고서에 실행 확인 안 됨이라고 적어라.)'

  $folderFull = (Resolve-Path $Folder).Path.TrimEnd('\')
  # 공간이 정한 모델(.claude/settings.json의 model)을 --model로 넘긴다. 공급자가 기본 모델을 환경변수로 정하면
  # 그쪽이 settings.json보다 앞서서, 넘기지 않으면 공간의 모델이 무시된다.
  $spaceSettings = Join-Path $Folder '.claude\settings.json'
  $space = if (Test-Path $spaceSettings) { Get-Content -Raw -Encoding UTF8 $spaceSettings | ConvertFrom-Json }
  $model = ConvertTo-WorkerModel $(if ($space.model) { Resolve-ProviderModel $info $space.model })
  $modelArg = if ($model) { @('--model', $model) } else { @() }
  # settings.json의 effortLevel은 Claude Code가 max를 경고 없이 버리므로 직접 읽어 --effort로 넘긴다.
  if (-not $Effort) { $Effort = $space.effortLevel }
  if (-not $Effort) { $Effort = $info.Effort }
  $effortArg = if ($Effort) { @('--effort', $Effort) } else { @() }
  # 구독 공급자면 비서 기억 읽기 도구(recall·search_log, --readonly 기억 MCP)를 붙인다. 구독이 아니면 개인 기억이 바깥으로 나가므로 붙이지 않는다.
  # --mcp-config·--allowedTools는 값을 여럿 받으므로 지시(맨 끝 인자)보다 앞, --settings 앞에 둔다.
  $mcpArg = if (Test-MemoryMcp $info) { @('--mcp-config', (New-MemoryMcpConfig), '--allowedTools', ($MemoryReadTools -join ',')) } else { @() }
  if ($DryRun) { "MCP 인자: $($mcpArg -join ' ')"; exit 0 }

  # 재사용 판단: 같은 공간·공급자의 쉬는 업무 세션(worker-done.ps1이 업무 끝난 시각을 적은 것) 중 가장 최근 것을 본다.
  # 캐시가 살아 있을 때 이어 쓰면 새 세션의 시작 비용(1~2.5만 토큰)을 아낀다(run-job 자동 이어 부르기와 같은 기준, common.ps1).
  $config = Get-ClaudeConfigDir
  $state = Read-WorkerState
  $now = [DateTime]::UtcNow
  $idle = @($state.PSObject.Properties | ForEach-Object { $_.Value } |
    Where-Object { $_.folder -eq $folderFull -and $_.provider -eq $info.Name -and $_.done_at } |
    Sort-Object { [DateTime]::Parse($_.done_at) } -Descending)
  $prev = $idle | Select-Object -First 1
  $log = [ordered]@{ at = $now.ToString('o'); folder = $folderFull; provider = $info.Name; name = $Name; id = $null
    reused = $false; new_reason = $null; minutes_since_done = $null; context = $null }
  if ($prev) {
    $log.minutes_since_done = [math]::Round(($now - [DateTime]::Parse($prev.done_at).ToUniversalTime()).TotalMinutes, 1)
    $alive = (& $claude agents --json | ConvertFrom-Json) | Where-Object { $_.id -eq $prev.id } | Select-Object -First 1
    if ($alive) { $log.context = Get-SessionContext $config $alive.sessionId }
    if ($New) { $log.new_reason = '-New' }
    elseif (-not $alive) { $log.new_reason = '세션 없음' }
    elseif ($log.minutes_since_done -ge $SessionReuseMinutes) { $log.new_reason = "$($SessionReuseMinutes)분 초과" }
    elseif ($null -eq $log.context) { $log.new_reason = '문맥 모름' }
    elseif ($log.context -ge $SessionReuseMaxContext) { $log.new_reason = '문맥 초과' }
    elseif (Test-WorkerSettingsDiffer $prev $model $Effort $Chrome $LockTests) { $log.new_reason = '설정 다름' }
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
  # 백그라운드 세션은 상위 폴더 신뢰를 이어받지 않으므로, 신뢰된 상위 폴더 아래 공간이면 이 계정 설정에 신뢰를 적는다.
  node "$PSScriptRoot\trust-folder.mjs" $folderFull
  # --chrome 옵션을 claude --bg와 함께 쓰면 지시가 "-"로 바뀌어 업무 세션이 지시 없이 시작된다.
  # 그래서 옵션 대신 환경변수로 크롬을 켠다(비서 서버 remote-server.ps1과 같은 방식).
  if ($Chrome) { $env:CLAUDE_CODE_ENABLE_CFC = '1' }
  # 백그라운드 세션은 git 저장소에서 파일을 고치기 전에 git worktree(.claude/worktrees/)로 옮겨 가도록 강제돼,
  # 결과가 공간의 output/이 아니라 사본 폴더에 생긴다. 업무 하나에 세션 하나라 격리가 필요 없으므로 제자리에서 일하게 한다.
  # 환경변수 CLAUDE_BG_ISOLATION은 이미 떠 있는 백그라운드 서비스에 전달되지 않아서 --settings로 넘긴다.
  $workerSettings = [pscustomobject]@{ worktree = [pscustomobject]@{ bgIsolation = 'none' } }
  # 자동 판단(auto) 모드는 구독에서만 동작한다. 다른 공급자에서는 평범한 명령에도 승인 창이 떠서, 아무도 없는
  # 백그라운드 세션이 멈춘다. 그래서 허용 목록(worker-permissions.json)에 있는 것만 하고 나머지는 묻지 않고 거절하는
  # dontAsk 모드로 돌린다. 거절되면 업무 세션이 다른 방법을 찾거나 [질문]으로 묻는다.
  $permArg = if ($info.Type -eq 'claude-subscription') { @('--permission-mode', 'auto') } else {
    # 웹 검색 도구는 Anthropic 서버 기능이라 다른 공급자에는 없다. Bing 결과 페이지는 WebFetch로 읽힌다(구글·네이버·DuckDuckGo는 막힘).
    $safePrompt += ' (웹 검색 도구가 없으니, 검색이 필요하면 WebFetch로 https://www.bing.com/search?q=<검색어> 를 가져와 결과를 보라.)'
    # Edit(./**)의 ./는 시작 폴더가 아니라 셸이 마지막으로 cd한 폴더 기준이라, cd output/... 뒤에는 notes/가 막힌다.
    # 그래서 공간 폴더 전체 경로(//c/Users/...) 규칙을 덧붙인 설정 파일을 만들어 넘긴다.
    $perm = Get-WorkerPermissions
    $posix = '//' + $folderFull.Substring(0, 1).ToLower() + ($folderFull.Substring(2) -replace '\\', '/').TrimEnd('/')
    $perm.permissions.allow += "Edit($posix/**)"
    $perm | Add-Member -NotePropertyName worktree -NotePropertyValue $workerSettings.worktree -Force
    $workerSettings = $perm
    @('--permission-mode', 'dontAsk')
  }
  # 공간 밖 쓰기, git push, 게시·업로드, 큰 삭제(-LockTests면 테스트 파일 수정도), 비서 폴더를 건드리는 셸 명령(bin\ 입구 부르기만 된다)을
  # 훅으로 막는다(worker-folder-guard.mjs). 비서 폴더는 긴 이름과 8.3 짧은 이름 꼴을 함께 넘긴다(Get-SecretaryGuardArgs).
  $guard = "node `"$PSScriptRoot\worker-folder-guard.mjs`" `"$folderFull`"" + $(if ($LockTests) { ' --lock-tests' } else { '' }) + (Get-SecretaryGuardArgs)
  $guardHook = [pscustomobject]@{ matcher = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'; hooks = @([pscustomobject]@{ type = 'command'; command = $guard; timeout = 5 }) }
  # 같은 종류 조작이 한 턴에 여러 번(기준 this-secretary.local.json의 mistake-guards 칸 repeatLimit) 되풀이되면 막지 않고 도구·스크립트로 바꿀지 따져 보라고 알린다(src/mistake-guards/repeat-hook.ts).
  $workerSettings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{ PreToolUse = @($guardHook); PostToolUse = @(Get-RepeatHook) }) -Force
  # 계정에 붙인 claude.ai 커넥터(예: Google Calendar)는 업무에 쓰지 않으므로 업무 세션에는 붙이지 않는다.
  # 업무 세션은 이미 떠 있는 백그라운드 서비스의 환경을 물려받으므로, 공간 도구가 비서 입구(bin\)를 찾는 비서 폴더 환경변수
  # (이 비서 번호의 SECRETARY_<번호>_DIR, 옮기는 동안의 옛 이름 SECRETARY_DIR)도 여기서 넘긴다(common.ps1 Get-SecretaryDirVars).
  $workerEnv = [pscustomobject]@{ ENABLE_CLAUDEAI_MCP_SERVERS = 'false' }
  foreach ($v in (Get-SecretaryDirVars).GetEnumerator()) { $workerEnv | Add-Member -NotePropertyName $v.Key -NotePropertyValue $v.Value -Force }
  $workerSettings | Add-Member -NotePropertyName env -NotePropertyValue $workerEnv -Force
  $settingsFile = Join-Path $env:TEMP "worker-settings-$Name.json"
  Write-Utf8File $settingsFile ($workerSettings | ConvertTo-Json -Depth 8)
  # id를 읽으려고 출력을 받아 둔다. PowerShell 5.1은 Stop일 때 네이티브 프로그램의 오류 출력을 예외로 바꾸므로 잠시 Continue로 둔다.
  $ErrorActionPreference = 'Continue'
  $out = @(& $claude --bg --name $Name @modelArg @effortArg @permArg @mcpArg --settings $settingsFile $safePrompt 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $out
  # 새 세션을 상태 파일에 적어 두면, 업무가 끝난 뒤(worker-done.ps1) 같은 공간의 다음 업무가 이어 쓸 수 있다.
  if (($out -join "`n") -match 'backgrounded\W+([0-9a-f]{6,})') {
    $id = $Matches[1]
    $entry = [pscustomobject]@{ id = $id; name = $Name; task_name = $Name; folder = $folderFull; provider = $info.Name; config_dir = $config
      model = $model; effort = $Effort; chrome = [bool]$Chrome; lock_tests = [bool]$LockTests; started_at = $now.ToString('o'); done_at = $null; tasks = 1 }
    $state | Add-Member -NotePropertyName $id -NotePropertyValue $entry -Force
    $log.id = $id
  }
  try { Save-WorkerState $state } catch { [Console]::Error.WriteLine("업무 세션 상태를 못 남겼어요: $_") }
  Add-WorkerReuseLog $log
  exit $code
}

# ---- send-worker.ps1 -------------------------------------------------------------------------

function Send-Worker([string]$Id, [string]$Message) {
  $claude = Initialize-ClaudeScript
  $Id = ConvertTo-WorkerId $Id
  $hit = Find-WorkerSession $claude $Id
  if (-not $hit) { throw "업무 세션 $Id 이(가) 어느 계정의 목록에도 없어요." }

  $out = Send-WorkerMessage $claude $hit $Message
  if ($out -match '보냄') { $out; exit 0 }

  # 목록에는 있는데 메시지가 닿지 않으면 백그라운드 서비스가 꺼져 세션이 떠 있지 않은 것이다(2026-11-05 확인).
  # 같은 세션을 옵션 없이 이어 깨우면서 메시지를 첫 지시로 넣는다(옵션을 붙이면 사본이 생긴다).
  # Find-WorkerSession이 그 세션의 설정 폴더(CLAUDE_CONFIG_DIR)를 이미 넣어 두었다.
  $body = ($Message -replace '"', "'") -replace '\r?\n', ' '
  Push-Location $hit.cwd
  # claude가 stderr에 "Starting background service…"를 쓰면 Stop 설정에서 예외가 되므로 이 호출만 Continue로 둔다.
  $ErrorActionPreference = 'Continue'
  try { $wake = (& $claude --bg --resume $hit.sessionId $body 2>&1) -join "`n" } finally { Pop-Location }
  if ($LASTEXITCODE -eq 0 -and $wake -match 'backgrounded') { '깨워서 보냄'; exit 0 }
  "못 보냄: $out / 깨우기 출력: $wake"
  exit 1
}

# ---- worker-logs.ps1 -------------------------------------------------------------------------

function Show-WorkerLogs([string]$Id) {
  $claude = Initialize-ClaudeScript
  $Id = ConvertTo-WorkerId $Id
  $null = Find-WorkerSession $claude $Id
  & $claude logs $Id
  exit $LASTEXITCODE
}

# ---- worker-done.ps1 -------------------------------------------------------------------------

function Use-ConfigDir([string]$Dir) {
  if ($Dir -and $Dir.TrimEnd('\') -ne (Join-Path $env:USERPROFILE '.claude')) { $env:CLAUDE_CONFIG_DIR = $Dir }
  else { Remove-Item env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
}

# -IdleMinutes를 안 주면 이어 쓰기 기준($SessionReuseMinutes)을 쓴다.
function Complete-Worker([string]$Id, [switch]$Stop, [string]$StopAfter, [int]$IdleMinutes = $SessionReuseMinutes) {
  $claude = Initialize-ClaudeScript
  $Id = ConvertTo-WorkerId $Id
  $stopWorker = { param($WorkerId) try { & $claude stop $WorkerId *> $null } catch {} }

  $state = Read-WorkerState
  $entry = $state.PSObject.Properties[$Id].Value

  # 뒤에서 띄운 끄기 대기: 정해진 시간 뒤 업무 끝난 시각이 그대로면(재사용되지 않았으면) 끈다.
  if ($StopAfter) {
    Start-Sleep -Seconds ($IdleMinutes * 60)
    $state = Read-WorkerState
    $entry = $state.PSObject.Properties[$Id].Value
    if (-not $entry -or "$($entry.done_at)" -ne $StopAfter) { exit 0 }
    Use-ConfigDir $entry.config_dir
    & $stopWorker $Id
    $state.PSObject.Properties.Remove($Id)
    Save-WorkerState $state
    Add-WorkerReuseLog ([ordered]@{ at = [DateTime]::UtcNow.ToString('o'); event = 'idle_stop'; folder = $entry.folder; provider = $entry.provider; name = $entry.name; id = $Id; tasks = $entry.tasks })
    exit 0
  }

  if (-not $entry -or $Stop) {
    if ($entry) { Use-ConfigDir $entry.config_dir } elseif (-not (Find-WorkerSession $claude $Id)) { Write-Output "업무 세션 $Id 이(가) 어느 계정의 목록에도 없어요(이미 꺼짐)."; exit 0 }
    & $stopWorker $Id
    if ($entry) { $state.PSObject.Properties.Remove($Id); Save-WorkerState $state }
    Write-Output "껐어요: $Id$(if (-not $Stop) { ' (상태 파일에 없는 세션이라 바로 껐어요)' })"
    exit 0
  }

  Use-ConfigDir $entry.config_dir
  $alive = (& $claude agents --json | ConvertFrom-Json) | Where-Object { $_.id -eq $Id } | Select-Object -First 1
  if (-not $alive) {
    $state.PSObject.Properties.Remove($Id)
    Save-WorkerState $state
    Write-Output "업무 세션 $Id 이(가) 이미 목록에 없어요. 상태 파일에서 지웠어요."
    exit 0
  }
  $now = [DateTime]::UtcNow
  $doneAt = $now.ToString('o')
  $context = Get-SessionContext (Get-ClaudeConfigDir) $alive.sessionId
  # 이어 쓸 수 없는 세션(문맥이 기준 이상이거나 기록을 못 찾음)은 기다리지 않고 바로 끈다.
  if ($null -eq $context -or $context -ge $SessionReuseMaxContext) {
    & $stopWorker $Id
    $state.PSObject.Properties.Remove($Id)
    Save-WorkerState $state
    Add-WorkerReuseLog ([ordered]@{ at = $doneAt; event = 'done_stop'; folder = $entry.folder; provider = $entry.provider; name = $entry.name; id = $Id; tasks = $entry.tasks; context = $context })
    Write-Output "껐어요: $Id (문맥 $(if ($null -eq $context) { '모름' } else { "$context 토큰" })이라 이어 쓰지 않아요)."
    exit 0
  }
  $entry.done_at = $doneAt
  $entry | Add-Member -NotePropertyName context -NotePropertyValue $context -Force
  Save-WorkerState $state

  # 이 스크립트를 부른 쪽(비서의 명령)이 끝나면 자식 프로세스도 정리되므로, WMI로 부모와 상관없는 프로세스를 만든다.
  # conhost --headless로 띄워야 창이 잠깐 떴다 사라지지 않는다.
  $self = Join-Path $PSScriptRoot 'worker-done.ps1'
  $cmd = "conhost.exe --headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -Id $Id -StopAfter $doneAt -IdleMinutes $IdleMinutes"
  $null = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  $stopAt = ConvertTo-KstText $now.AddMinutes($IdleMinutes) 'HH:mm'
  Write-Output "업무 끝 표시: $Id (문맥 $context 토큰). $($IdleMinutes)분 안에 같은 공간의 다음 업무가 오면 이어 쓰고, 아니면 $stopAt(KST)에 꺼져요."
}
