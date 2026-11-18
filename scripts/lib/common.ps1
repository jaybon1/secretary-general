# 다른 스크립트가 dot-source 해서 쓰는 공용 함수(scripts/lib/). 다른 폴더의 스크립트는 . "$PSScriptRoot\..\lib\common.ps1"로 부른다.

# 비서 폴더와 그 scripts 폴더. 이 파일이 scripts/lib/에 있으므로 거기서 올라가 찾는다(부르는 스크립트의 폴더와 상관없다).
$ScriptsDir = Split-Path -Parent $PSScriptRoot
$SecretaryRoot = Split-Path -Parent $ScriptsDir
# 이 비서 전용 설정(this-secretary.local.json) 읽기: Get-ThisSecretarySection.
. (Join-Path $PSScriptRoot 'this-secretary.ps1')
# 비서 폴더 밖 도구는 비서 폴더의 bin\<이름>(고정 진입점, src/core/paths.ts ENTRY_POINTS)으로 비서 스크립트를 부른다. 작업 공간 도구는 진입점 폴더를
# 공간 맨 위 secretary-link.local.json의 bin(비서가 써 둔다, src/workspace/secretary-link.ts)으로 찾고, 없으면 이 비서의 환경변수 SECRETARY_<번호>_DIR(번호는
# 아래 고유 번호) 아래 bin을 쓴다. 사용자 환경변수로도 등록하지만(설치 상태 점검(setup-check) 항목 secretary-dir), 이 스크립트들이 띄우는 것(비서 서버와
# 그 세션, run-job, 업무 세션)은 등록 전이나 다른 사본에서 돌 때도 지금 도는 이 비서 폴더를 보게 이 파일 끝에서 늘 맞춘다.

# 데스크톱 앱 세션 안에서 실행하면 앱 전용 환경변수(ANTHROPIC_BASE_URL 등)가 따라와
# 별도로 띄우는 claude 프로세스가 앱의 연결을 잘못 쓰게 되므로 지운다.

# 이 PC의 PowerShell 5.1은 기본으로 CP949로 내보내 비서(UTF-8로 읽음)에게 한글이 깨져 보인다.
# 비서가 출력을 읽는 스크립트는 맨 처음 이걸 불러 오류 문구까지 UTF-8로 내보낸다. 인코딩을 돌려준다.
function Use-Utf8Console {
  $utf8 = New-Object Text.UTF8Encoding $false
  $global:OutputEncoding = $utf8
  try { [Console]::OutputEncoding = $utf8 } catch {}
  $utf8
}

function Get-ClaudeExe {
  # 테스트 중 표시(test/env.ts가 넣는 SECRETARY_NO_MODEL_CALLS)가 있으면 claude를 띄우지 않고 멈춘다(모델 호출·사용량·기록이 생기므로). TS 쪽 짝: src/core/no-model-calls.ts.
  if ($env:SECRETARY_NO_MODEL_CALLS) { throw '테스트 중에는 claude·run-job을 부르지 않아요(SECRETARY_NO_MODEL_CALLS). 테스트에는 가짜를 넣는다.' }
  $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path $fallback) { return $fallback }
  throw 'claude 실행 파일을 찾지 못했어요. https://claude.ai/install.ps1 로 Claude Code를 설치하세요.'
}

function Clear-HostClaudeEnv {
  Get-ChildItem env: | Where-Object Name -match '^(CLAUDE|ANTHROPIC)' | ForEach-Object {
    Remove-Item -LiteralPath "env:$($_.Name)" -ErrorAction SilentlyContinue
  }
  # 비서 서버가 켜진 뒤 설치한 프로그램(예: Python)은 서버의 옛 PATH에 없으므로, 레지스트리의 최신 PATH를 다시 읽는다.
  $env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
}

# 지금 프로세스의 설정 폴더(Use-Provider·Find-WorkerSession이 CLAUDE_CONFIG_DIR을 넣는다. 없으면 ~/.claude).
function Get-ClaudeConfigDir {
  if ($env:CLAUDE_CONFIG_DIR) { return $env:CLAUDE_CONFIG_DIR }
  Join-Path $env:USERPROFILE '.claude'
}

# Windows 프로세스 목록(WMI Win32_Process). -Filter는 WQL 조건(예: "ParentProcessId=123"), -Property는 받을 속성만(빠르다).
# 서버·업무 모니터링 스크립트가 같은 조회를 하므로 여기 하나로 둔다. TS 쪽 짝: src/core/windows-process.ts.
function Get-WinProcess([string]$Filter, [string[]]$Property) {
  $query = @{ ClassName = 'Win32_Process' }
  if ($Filter) { $query.Filter = $Filter }
  if ($Property) { $query.Property = $Property }
  Get-CimInstance @query
}

function Test-ClaudeLogin([string]$claude) {
  try { return [bool]((& $claude auth status 2>$null | Out-String | ConvertFrom-Json).loggedIn) } catch { return $false }
}

# 비서가 따로 띄우는 claude를 다루는 스크립트의 공통 머리: 출력을 UTF-8로, 앱 전용 환경변수를 지우고, claude 실행 파일 경로를 돌려준다.
function Initialize-ClaudeScript {
  $null = Use-Utf8Console
  Clear-HostClaudeEnv
  Get-ClaudeExe
}

# 저장소 밖 비서 폴더(~/.secretary): 바로 아래는 한 PC의 비서들이 함께 쓰는 것(모음이 든 단어: keys, usage, ntfy 등),
# 비서마다의 것은 그 고유 번호 폴더 아래(<번호>\logs: 서버·쉬는 시간 작업·끝 알림, <번호>\state: 업무 세션·run-job 기록).
# 번호에는 모음이 없어 단어 이름과 겹치지 않는다. TS 쪽 짝: src/core/paths.ts SECRETARY_HOME.
function Get-SecretaryHome { Join-Path $env:USERPROFILE '.secretary' }

# 작업 공간들의 상위 폴더(workspaces): SECRETARY_WORKSPACE_ROOT, 없으면 비서 폴더 옆. TS 쪽 짝: src/core/config.ts WORKSPACE_ROOT.
function Get-WorkspaceRoot { if ($env:SECRETARY_WORKSPACE_ROOT) { $env:SECRETARY_WORKSPACE_ROOT.TrimEnd('\') } else { Join-Path (Split-Path -Parent $SecretaryRoot) 'workspaces' } }

# 이 비서의 기록 폴더: ~/.secretary/<고유 번호>/logs(.secretary-id, 아래 Read-SecretaryId). 한 PC의 두 비서가 한 기록 파일에 섞어 쓰지 않게 한다.
# 번호가 아직 없는 사본은 예전처럼 logs 바로 아래에 쓴다. 번호를 읽기만 한다(만들지 않음). 옛 기록(2026-11-09까지의 logs\<번호>, 번호 전의
# logs\server-a, logs\idle-jobs.log 등)은 옮기지 않고 그 자리에 둔다.
# TS 쪽 짝: src/core/paths.ts secretaryLogDir.
function Get-SecretaryLogDir([string]$Root = $SecretaryRoot) {
  $id = Read-SecretaryId $Root
  if ($id) { Join-Path (Get-SecretaryHome) "$id\logs" } else { Join-Path (Get-SecretaryHome) 'logs' }
}

# 한 PC의 비서 모두가 같이 쓰는 사용량 폴더(~/.secretary/usage): 계정마다의 사용량·90% 해제(같은 계정을 쓰는 비서끼리 같은 파일을 본다),
# 조회 표시, 사용량 조회기 잠금. TS 쪽 짝: src/core/paths.ts USAGE_DIR.
function Get-UsageDir { Join-Path (Get-SecretaryHome) 'usage' }

# 이 비서의 기록 폴더: ~/.secretary/<고유 번호>/state. 업무 세션(worker-sessions.json, worker-reuse.jsonl), run-job(run-job-sessions.json,
# run-job-calls.jsonl, run-job-active\), 뒤에서 띄운 일(bg-jobs\), 업무 모니터링(watch\)을 두어 한 PC의 두 비서가 서로의 기록을 읽거나 섞어 쓰지 않게 한다.
# 번호가 아직 없는 사본은 Get-UsageDir에 쓴다. 번호를 읽기만 한다(만들지 않음). TS 쪽 짝: src/core/paths.ts secretaryStateDir.
function Get-SecretaryStateDir([string]$Root = $SecretaryRoot) {
  $id = Read-SecretaryId $Root
  if ($id) { Join-Path (Get-SecretaryHome) "$id\state" } else { Get-UsageDir }
}

function Get-KstZone { [TimeZoneInfo]::FindSystemTimeZoneById('Korea Standard Time') }
# UTC 시각을 한국시간 글로. 예: ConvertTo-KstText $utc 'HH:mm'
function ConvertTo-KstText([DateTime]$Utc, [string]$Format) { [TimeZoneInfo]::ConvertTimeFromUtc($Utc, (Get-KstZone)).ToString($Format) }

# 구독 밖 공급자로 도는 업무 세션·run-job의 허용 목록(scripts/worker/worker-permissions.json). 파일에는 비서 폴더를
# {SECRETARY_DIR}로 적어 두고(사용자마다, 옮길 때마다 다르다) 여기서 이 비서 폴더로 바꿔 객체로 돌려준다.
function Get-WorkerPermissions {
  $text = Get-Content -Raw -Encoding UTF8 (Join-Path $ScriptsDir 'worker\worker-permissions.json')
  $text.Replace('{SECRETARY_DIR}', $SecretaryRoot.Replace('\', '\\')) | ConvertFrom-Json
}

# 업무 세션·run-job 설정(--settings)의 PostToolUse 훅 하나: 같은 종류 조작이 한 턴에 여러 번 되풀이되면 막지 않고 알린다
# (src/mistake-guards/repeat-hook.ts, 기능 mistake-guards. 기준은 this-secretary.local.json의 mistake-guards 키의 repeatLimit). 그 파일이 없으면 빈 목록.
# matcher는 비서 자신의 설정(.claude/settings.json)과 같다: 세지 않는 비서 MCP 도구(mcp__secretary__)는 빼서 그 호출마다 훅 프로세스가 뜨지 않게 한다.
function Get-RepeatHook {
  $hook = Join-Path $SecretaryRoot 'src\mistake-guards\repeat-hook.ts'
  if (-not (Test-Path -LiteralPath $hook)) { return @() }
  [pscustomobject]@{ matcher = 'Bash|PowerShell|Read|Write|WebFetch|mcp__(?!secretary__).*'; hooks = @([pscustomobject]@{ type = 'command'; command = "node `"$hook`""; timeout = 10 }) }
}

# 업무 세션(start-worker)과 run-job이 claude에 --settings로 넘길 설정 객체를 한 곳에서 만든다(예전에는 두 스크립트가 따로 만들었다).
#   -Permissions: 구독 밖 공급자는 자동 판단 모드가 없어 허용 목록(Get-WorkerPermissions)을 넣는다. -EditFolder를 함께 주면 그 폴더 전체 경로의
#     Edit 규칙(//c/Users/…/**)을 덧붙인다: Edit(./**)의 ./는 시작 폴더가 아니라 셸이 마지막으로 cd한 폴더 기준이라, cd output/… 뒤에는 그 폴더의 다른 곳이 막힌다.
#   -GuardHook: PreToolUse 훅(providers.ps1 Get-FolderGuardHook), -RepeatHooks: PostToolUse 훅(Get-RepeatHook). 훅이 하나도 없으면 hooks 키를 넣지 않는다.
#   -Extra: 그 밖에 넣을 키(업무 세션의 worktree·env).
function New-ClaudeRunSettings([switch]$Permissions, [string]$EditFolder, $GuardHook, $RepeatHooks = @(), [hashtable]$Extra = @{}) {
  $s = if ($Permissions) { Get-WorkerPermissions } else { [pscustomobject]@{} }
  # 드라이브 문자로 시작하는 전체 경로만(//c/… 꼴로 바꿀 수 있는 것).
  if ($Permissions -and $EditFolder -match '^[A-Za-z]:\\') {
    $full = $EditFolder.TrimEnd('\')
    $posix = '//' + $full.Substring(0, 1).ToLower() + ($full.Substring(2) -replace '\\', '/').TrimEnd('/')
    $s.permissions.allow += "Edit($posix/**)"
  }
  $hooks = [pscustomobject]@{}
  if ($GuardHook) { $hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @($GuardHook) }
  if (@($RepeatHooks).Count) { $hooks | Add-Member -NotePropertyName PostToolUse -NotePropertyValue @($RepeatHooks) }
  if ($hooks.PSObject.Properties.Name) { $s | Add-Member -NotePropertyName hooks -NotePropertyValue $hooks -Force }
  foreach ($k in $Extra.Keys) { $s | Add-Member -NotePropertyName $k -NotePropertyValue $Extra[$k] -Force }
  $s
}

# 비서 cli(node src/cli.ts <명령> …)를 부르고 종료 코드·출력 줄·오류 줄을 나눠 돌려준다: code, out(출력 줄 배열), err(빈 줄을 뺀 오류 줄 배열).
# 업무 세션·run-job 스크립트 여러 곳이 같은 부르기(네이티브 stderr를 예외로 바꾸지 않게 Continue, 출력과 오류 줄 가르기)를 따로 짜던 것을 모았다.
# node를 띄우지도 못하면 code -1과 그 오류 글.
function Invoke-SecretaryCli([string[]]$CliArgs) {
  # PowerShell 5.1은 Stop일 때 네이티브 명령의 stderr 한 줄도 오류로 던진다. 이 함수 안에서만 Continue로 둔다.
  $ErrorActionPreference = 'Continue'
  try {
    $all = @(& node --no-warnings (Join-Path $SecretaryRoot 'src\cli.ts') @CliArgs 2>&1)
    $code = $LASTEXITCODE
  } catch { return [pscustomobject]@{ code = -1; out = @(); err = @("$_") } }
  [pscustomobject]@{
    code = $code
    out = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    err = @($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  }
}

# BOM 없는 UTF-8로 쓴다(-Append면 덧붙인다). 비서·node가 UTF-8로 읽는다.
function Write-Utf8File([string]$Path, [string]$Text, [switch]$Append) {
  $enc = New-Object Text.UTF8Encoding $false
  if ($Append) { [IO.File]::AppendAllText($Path, $Text, $enc) } else { [IO.File]::WriteAllText($Path, $Text, $enc) }
}

# 동시에 도는 run-job·업무 세션 스크립트가 같은 상태 파일(run-job-sessions.json, worker-sessions.json 등)과
# 기록 파일(run-job-calls.jsonl, worker-reuse.jsonl)을 고칠 때 쓰는 잠금. 예전에는 시작 때 읽은 상태를 끝날 때 통째로 덮어써서, 함께 돈 다른
# 프로세스가 그사이 적은 항목이 지워졌다(재사용 통계가 흐려진다). 그 파일 옆 <파일>.lock을 혼자 열어(FileShare.None) 잡고, 다 하면 닫는다.
# 잠금 파일은 지우지 않는다(지우면 기다리던 쪽과 새로 연 쪽이 서로 다른 파일을 잡는다). 프로세스가 죽으면 Windows가 핸들을 닫아 잠금도 풀린다.
# $LockTimeoutSec 안에 못 잡으면 예외를 던진다. 변수 이름은 $Body가 부르는 쪽 변수를 가리지 않게 lk로 시작한다.
function Invoke-WithFileLock([string]$LockedPath, [scriptblock]$LockedBody, [int]$LockTimeoutSec = 30) {
  $lkFile = "$LockedPath.lock"
  New-Item -ItemType Directory -Force (Split-Path -Parent $lkFile) | Out-Null
  $lkDeadline = [DateTime]::UtcNow.AddSeconds($LockTimeoutSec)
  $lkStream = $null
  while (-not $lkStream) {
    try { $lkStream = [IO.File]::Open($lkFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch {
      if ([DateTime]::UtcNow -ge $lkDeadline) { throw "상태 파일 잠금을 $($LockTimeoutSec)초 안에 얻지 못했어요: $lkFile ($($_.Exception.Message))" }
      Start-Sleep -Milliseconds (Get-Random -Minimum 20 -Maximum 80)
    }
  }
  try { & $LockedBody } finally { $lkStream.Dispose() }
}

# 다른 프로세스(대시보드, 잠금 없이 읽는 쪽)가 쓰다 만 파일을 읽지 않게, 같은 폴더의 임시 파일에 다 쓴 뒤 바꿔 끼운다(BOM 없는 UTF-8).
# 읽는 쪽이 그 순간 파일을 열고 있으면 바꿔 끼우기가 실패하므로 잠깐씩 다시 해 본다.
function Write-Utf8FileAtomic([string]$Path, [string]$Text) {
  $tmp = "$Path.$PID.tmp"
  Write-Utf8File $tmp $Text
  for ($i = 0; ; $i++) {
    try {
      if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
      return
    } catch {
      if ($i -ge 40) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
      Start-Sleep -Milliseconds 50
    }
  }
}

# 상태 파일(JSON 객체 하나)의 지금 내용. 없거나 읽지 못하면 빈 객체.
function Read-JsonStateFile([string]$Path) {
  $s = $null
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    try { $s = [IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { [Console]::Error.WriteLine("상태 파일을 읽지 못해 빈 상태로 봐요: $Path ($_)") }
  }
  if (-not $s) { $s = [pscustomobject]@{} }
  $s
}

# 상태 파일을 잠근 채(Invoke-WithFileLock) 지금 내용을 다시 읽어 $StateChange(그 객체를 param으로 받아 고친다)를 하고 통째로 바꿔 쓴다.
# 시작 때 읽어 둔 객체를 쓰지 말고, 바꿀 항목만 이 안에서 고친다(그사이 다른 프로세스가 적은 항목이 남는다). $StateChange가 돌려준 값을 돌려준다.
function Update-JsonStateFile([string]$StatePath, [scriptblock]$StateChange, [int]$StateDepth = 4) {
  Invoke-WithFileLock $StatePath {
    $stObj = Read-JsonStateFile $StatePath
    $stResult = & $StateChange $stObj
    Write-Utf8FileAtomic $StatePath ($stObj | ConvertTo-Json -Depth $StateDepth)
    $stResult
  }
}

# run-job -ReportFile: 결과 글을 보고 파일로 바로 쓴다(서브에이전트 보고 저장 scripts/subagent-report/subagent-report.ts와 같은 규칙).
# 경로가 폴더(있는 폴더이거나 \·/로 끝남)면 그 안의 REPORT.md. 이미 같은 내용이면 두고, 다른 내용이 있으면 쓰지 않고 오류(-Force면 덮어씀).
function Resolve-ReportFile([string]$ReportPath) {
  $full = [IO.Path]::GetFullPath($ReportPath)
  if ((Test-Path -LiteralPath $full -PathType Container) -or $ReportPath -match '[\\/]$') { $full = Join-Path $full 'REPORT.md' }
  $full
}
# 돌리기 전에: 이미 내용이 있는 보고 파일이면(-Force 없이) 결과를 덮어쓸 수 없으니 돌리지 않고 멈춘다.
function Assert-ReportFileFree([string]$ReportPath, [switch]$Force) {
  if ($Force -or -not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) { return }
  if ((Get-Item -LiteralPath $ReportPath).Length -gt 0) { throw "이미 내용이 있는 $(Split-Path -Leaf $ReportPath)이 있어 돌리지 않았어요: $ReportPath (덮어쓰려면 -Force, 다른 이름이면 -ReportFile에 그 경로)" }
}
# 돌린 뒤: 결과 글을 쓴다. 돌려주는 것: 'written' | 'same'. 그사이 다른 내용이 생겼으면(-Force 없이) 오류.
function Save-ReportFile([string]$ReportPath, [string]$Text, [switch]$Force) {
  if (Test-Path -LiteralPath $ReportPath -PathType Leaf) {
    if ([IO.File]::ReadAllText($ReportPath) -eq $Text) { return 'same' }
    if (-not $Force -and (Get-Item -LiteralPath $ReportPath).Length -gt 0) { throw "이미 다른 내용의 $(Split-Path -Leaf $ReportPath)이 있어 쓰지 않았어요: $ReportPath (덮어쓰려면 -Force)" }
  }
  New-Item -ItemType Directory -Force (Split-Path -Parent $ReportPath) | Out-Null
  Write-Utf8FileAtomic $ReportPath $Text
  'written'
}

# 기록 파일(jsonl)에 한 줄을 잠근 채 덧붙인다. 잠금 없이 둘이 동시에 덧붙이면 한쪽이 '파일을 쓰는 중'으로 실패해 그 줄이 빠진다.
function Add-Utf8Line([string]$LinePath, [string]$Line) {
  Invoke-WithFileLock $LinePath { Write-Utf8File $LinePath ($Line + "`n") -Append }
}

# 비서 설치마다의 고유 번호(짧은 무작위 글자): 비서 폴더 맨 위 .secretary-id. 처음 필요할 때(설치 상태 점검, install-scheduled-tasks.ps1, 업데이트) 만들고
# 그 뒤로 계속 쓴다. 배포판·git·업데이트에 들어가지 않는다. 예약 작업 이름 끝에 붙고('Secretary Idle Jobs (A3F9)'), 다른 폴더의 비서가
# 같은 번호면 이 비서를 옮기거나 복사하고 남은 사본, 다르면 다른 비서로 가린다. TS 쪽 짝: src/core/secretary-id.ts(글자·형식이 같다).
# 번호는 어디서나 대문자다(파일, 작업 이름, 변수 이름). 소문자로 적힌 파일도 대문자로 읽고, Get-SecretaryId가 대문자로 고쳐 쓴다.
$SecretaryIdFile = '.secretary-id'
# 모음(A·E·U·Y, I·O는 원래 없음)을 빼 새 번호가 단어가 되지 않는다(~/.secretary에 함께 쓰는 이름과 안 겹침). 모음 든 옛 번호도 그대로 읽는다.
$SecretaryIdAlphabet = 'BCDFGHJKMNPQRSTVWXZ23456789'

# 그 비서 폴더의 번호(-File이면 그 파일), 대문자로. 없거나 형식이 아니면 $null.
function Read-SecretaryId([string]$Root = $SecretaryRoot, [string]$File) {
  if (-not $File) { $File = Join-Path $Root $SecretaryIdFile }
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $null }
  try { $id = ([IO.File]::ReadAllText($File)).Trim([char]0xFEFF, ' ', "`r", "`n", "`t").ToUpperInvariant() } catch { return $null }
  if ($id -cmatch '^[A-Z0-9]{4,12}$') { return $id }
  $null
}

# 이 비서의 번호. 없으면 새로 만들어 적는다(4글자). 적지 못하면 $null. 대문자 한 줄이 아니게 적혀 있으면 그렇게 고쳐 쓴다(이 비서 폴더만 부른다).
function Get-SecretaryId([string]$Root = $SecretaryRoot, [string]$File) {
  if (-not $File) { $File = Join-Path $Root $SecretaryIdFile }
  $id = Read-SecretaryId -File $File
  if ($id) {
    try { if ([IO.File]::ReadAllText($File) -cne "$id`n") { Write-Utf8File $File "$id`n" } } catch {}
    return $id
  }
  $id = -join (1..4 | ForEach-Object { $SecretaryIdAlphabet[(Get-Random -Maximum $SecretaryIdAlphabet.Length)] })
  # 파일이 없을 때만 새로 만든다(CreateNew). 두 프로세스가 동시에 처음 만들면 서로 다른 번호를 쓰게 되므로, 이미 생겼으면 그 번호를 읽는다.
  # .NET 파일 함수는 PowerShell 위치가 아닌 프로세스 폴더 기준으로 상대 경로를 풀므로 전체 경로로 바꿔 넘긴다.
  $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($File)
  try {
    $fs = [IO.File]::Open($full, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $bytes = [Text.Encoding]::ASCII.GetBytes("$id`n"); $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
    return $id
  } catch {
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $null }
  }
  # 다른 프로세스가 막 만든 파일: 다 쓸 때까지(빈 파일인 동안) 잠깐(최대 약 0.5초) 기다려 그 번호를 읽는다.
  for ($i = 0; $i -lt 25 -and (Get-Item -LiteralPath $full).Length -eq 0; $i++) { Start-Sleep -Milliseconds 20 }
  $theirs = Read-SecretaryId -File $full
  if ($theirs) { return $theirs }
  # 번호가 없는 파일(깨졌거나 빈 채 남음)은 전처럼 새 번호로 덮어쓴다.
  try { Write-Utf8File $full "$id`n" } catch { return $null }
  $id
}

# 예약 작업의 등록 이름: features.json의 이름 + 이 비서 번호. 번호가 아직 없으면 이름 그대로.
# 작업 스케줄러는 이름의 대소문자를 가리지 않는다(소문자 번호로 등록된 작업도 같은 작업으로 찾는다).
function Get-TaskNameWithId([string]$Name, [string]$Id) { if ($Id) { "$Name ($($Id.ToUpperInvariant()))" } else { $Name } }

# 비서 폴더 환경변수 이름: SECRETARY_<번호 대문자>_DIR(예: SECRETARY_A3F9_DIR). 번호가 아직 없으면 SECRETARY_DIR. TS 쪽 짝: src/core/paths.ts secretaryDirEnv.
function Get-SecretaryDirEnv([string]$Id) { if ($Id) { "SECRETARY_$($Id.ToUpperInvariant())_DIR" } else { 'SECRETARY_DIR' } }

# 이 비서가 띄우는 것에 넘길 비서 폴더 환경변수(이름 → 값): 이 비서 번호의 변수(번호가 없으면 SECRETARY_DIR). 번호를 읽기만 한다(만들지 않음).
function Get-SecretaryDirVars([string]$Root = $SecretaryRoot) {
  [ordered]@{ (Get-SecretaryDirEnv (Read-SecretaryId $Root)) = $Root }
}

# 그 폴더가 비서 폴더인지: package.json 이름이 secretary이거나 번호 파일이 있다.
function Test-SecretaryFolder([string]$Dir) {
  if (Test-Path -LiteralPath (Join-Path $Dir $SecretaryIdFile) -PathType Leaf) { return $true }
  $pkg = Join-Path $Dir 'package.json'
  if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { return $false }
  try { return (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).name -eq 'secretary' } catch { return $false }
}

# 한 PC에 비서가 여럿일 때: 경로(예약 작업이 부르는 파일 등)가 이 PC의 다른 비서 것이면 그 비서 폴더, 아니면 $null.
# 이 비서 폴더 안이면 이 비서 것. 그 위로 비서 폴더(package.json 이름이 secretary이거나 번호 파일이 있는 폴더)가 있으면, 두 폴더 모두
# 번호가 있고 같을 때는 이 비서를 옮기거나 복사하고 남은 사본이라 이 비서 것($null), 번호가 다르거나 어느 한쪽에 없으면 그 비서 것.
# 위에 비서 폴더가 없으면(옮겼거나 지운 폴더) 이 비서의 옛 위치로 본다($null). 설치 상태 점검과 같은 판단이다(src/setup/other-secretaries.ts).
# 전체 경로가 아니면 판단하지 않는다($null).
function Get-OtherSecretary([string]$Path, [string]$Root = $SecretaryRoot) {
  if (-not $Path -or -not [IO.Path]::IsPathRooted($Path)) { return $null }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $mine = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if ($full -eq $mine -or $full.StartsWith("$mine\", [StringComparison]::OrdinalIgnoreCase)) { return $null }
  $dir = $full
  while ($dir) {
    if ((Test-Path -LiteralPath $dir -PathType Container) -and (Test-SecretaryFolder $dir)) {
      # 같은 폴더를 다르게 쓴 것(8.3 짧은 이름 등)이면 이 비서다.
      if ((Get-Item -LiteralPath $dir).FullName.TrimEnd('\') -eq (Get-Item -LiteralPath $Root -ErrorAction SilentlyContinue).FullName.TrimEnd('\')) { return $null }
      $myId = Read-SecretaryId $Root
      if ($myId -and (Read-SecretaryId $dir) -eq $myId) { return $null }
      return $dir
    }
    $dir = Split-Path -Parent $dir
  }
  $null
}

# 예약 작업 동작이 부르는 파일: -File 뒤 스크립트(conhost --headless 뒤도), 없으면 전체 경로로 적힌 프로그램. 상대 경로는 작업 폴더 기준.
# 알 수 없으면 $null. 설치 상태 점검의 짝: src/setup/windows-probe.ts taskTargetFile.
function Get-TaskTargetFile($Action) {
  if (-not $Action) { return $null }
  if ("$($Action.Arguments)" -match '(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))') { $t = if ($Matches[1]) { $Matches[1] } else { $Matches[2] } }
  elseif ("$($Action.Execute)" -match '[\\/]') { $t = "$($Action.Execute)".Trim('"') }
  else { return $null }
  if ([IO.Path]::IsPathRooted($t)) { return $t }
  if ($Action.WorkingDirectory) { return Join-Path $Action.WorkingDirectory $t }
  $null
}

# 구독 대화 캐시(1시간) 안에 다시 읽을 기준(분). 업무 모니터링(watch-worker.ps1)·뒤에서 띄운 일 기다리기(wait-job.ps1)가 이 분마다 비서를 깨우고,
# 세션 재사용(resume)도 이 안일 때만 한다. 캐시가 살아 있을 때 읽으면 싸고 캐시가 다시 1시간 늘어난다. 여기 한 곳만 고친다.
$CacheWakeMinutes = 55

# 세션 재사용 기준(run-job 자동 재사용, 업무 세션 재사용): 마지막 호출·업무 끝 뒤 이 분 안이고 컨텍스트가 이 토큰 미만일 때.
# 캐시(1시간)가 살아 있어 새 세션보다 싸다. 실측(run-job-calls.jsonl, scripts/run-job/run-job-stats.ps1)을 보며 여기 한 곳만 고친다.
$SessionReuseMinutes = $CacheWakeMinutes
# 2026-11-08 8만→20만: 업무 세션이 끝날 때 컨텍스트가 늘 8만을 넘어(중앙값 19만) 재사용이 0번이었다. 2주쯤 재사용한 업무와 새로 띄운 업무를 비교해 다시 정한다.
$SessionReuseMaxContext = 200000

# 이 비서 번호의 비서 폴더 환경변수(SECRETARY_<번호>_DIR)를 지금 프로세스에 맞춘다(맨 위 설명, 띄우는 것이 물려받는다).
foreach ($v in (Get-SecretaryDirVars).GetEnumerator()) { Set-Item -LiteralPath "env:$($v.Key)" -Value $v.Value }
