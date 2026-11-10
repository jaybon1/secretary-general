# 다른 스크립트가 dot-source 해서 쓰는 공용 함수(scripts/lib/). 다른 폴더의 스크립트는 . "$PSScriptRoot\..\lib\common.ps1"로 부른다.

# 비서 폴더와 그 scripts 폴더. 이 파일이 scripts/lib/에 있으므로 거기서 올라가 찾는다(부르는 스크립트의 폴더와 상관없다).
$ScriptsDir = Split-Path -Parent $PSScriptRoot
$SecretaryRoot = Split-Path -Parent $ScriptsDir
# 이 비서 전용 설정(this-secretary.local.json) 읽기: Get-ThisSecretarySection.
. (Join-Path $PSScriptRoot 'this-secretary.ps1')
# 비서 폴더 밖 도구는 비서 폴더의 bin\<이름>(고정 입구, src/core/paths.ts ENTRY_POINTS)으로 비서 스크립트를 부른다. 작업 공간 도구는 입구 폴더를
# 공간 맨 위 secretary-link.local.json의 bin(비서가 써 둔다, src/workspace/secretary-link.ts)으로 찾고, 없으면 이 비서의 환경변수 SECRETARY_<번호>_DIR(번호는
# 아래 고유 번호) 아래 bin을 쓴다(2026-11-10 전 공간 규칙은 그다음 옛 SECRETARY_DIR도 읽었다). 사용자 환경변수로도 등록하지만(설치 점검 secretary-dir), 이 스크립트들이 띄우는 것(비서 서버와
# 그 세션, run-job, 업무 세션)은 등록 전이나 다른 사본에서 돌 때도 지금 도는 이 비서 폴더를 보게 이 파일 끝에서 늘 맞춘다.
# 번호 없는 옛 이름 SECRETARY_DIR도 바깥 도구가 새 이름으로 옮겨 갈 때까지 함께 맞춘다.
$env:SECRETARY_DIR = $SecretaryRoot # legacy-name: env-secretary-dir

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
  # 시험 중 표시(test/env.ts가 넣는 SECRETARY_NO_MODEL_CALLS)가 있으면 claude를 띄우지 않고 멈춘다(모델 호출·사용량·기록이 생기므로). TS 쪽 짝: src/core/no-model-calls.ts.
  if ($env:SECRETARY_NO_MODEL_CALLS) { throw '시험 중에는 claude·run-job을 부르지 않아요(SECRETARY_NO_MODEL_CALLS). 시험에 가짜를 넣는다.' }
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
# 서버·업무 감시 스크립트가 같은 조회를 하므로 여기 하나로 둔다. TS 쪽 짝: src/core/windows-process.ts.
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

# 저장소 밖 비서 폴더(~/.secretary): 바로 아래는 한 PC의 비서들이 함께 쓰는 것(모음이 든 낱말: keys, usage, ntfy 등),
# 비서마다의 것은 그 고유 번호 폴더 아래(<번호>\logs: 서버·쉬는 시간 작업·끝 알림, <번호>\state: 업무 세션·run-job 기록).
# 번호에는 모음이 없어 낱말 이름과 겹치지 않는다. TS 쪽 짝: src/core/paths.ts SECRETARY_HOME.
function Get-SecretaryHome { Join-Path $env:USERPROFILE '.secretary' }

# 이 비서의 기록 폴더: ~/.secretary/<고유 번호>/logs(.secretary-id, 아래 Read-SecretaryId). 한 PC의 두 비서가 한 기록 파일에 섞어 쓰지 않게 한다.
# 번호가 아직 없는 사본은 예전처럼 logs 바로 아래에 쓴다. 번호를 읽기만 한다(만들지 않음). 옛 기록(2026-11-09까지의 logs\<번호>, 번호 전의
# logs\server-a, logs\idle-jobs.log 등)은 옮기지 않고 그 자리에 둔다(서버 기록 보기는 server-lib.ps1 Get-LegacyServerLogDirs도 본다).
# TS 쪽 짝: src/core/paths.ts secretaryLogDir.
function Get-SecretaryLogDir([string]$Root = $SecretaryRoot) {
  $id = Read-SecretaryId $Root
  if ($id) { Join-Path (Get-SecretaryHome) "$id\logs" } else { Join-Path (Get-SecretaryHome) 'logs' }
}

# 한 PC의 비서 모두가 같이 쓰는 사용량 폴더(~/.secretary/usage): 계정마다의 사용량·90% 해제(같은 계정을 쓰는 비서끼리 같은 파일을 본다),
# 조회 표시, 사용량 조회기 잠금. TS 쪽 짝: src/core/paths.ts USAGE_DIR.
function Get-UsageDir { Join-Path (Get-SecretaryHome) 'usage' }
# 2026-11-09까지의 같은 폴더(~/.claude/usage). 새로 쓰지 않는다. 읽는 쪽(정지 훅·대시보드)은 TS가 둘 다 본다. TS 쪽 짝: LEGACY_USAGE_DIR.
function Get-LegacyUsageDir { Join-Path $env:USERPROFILE '.claude\usage' } # legacy-name: usage-dir

# 이 비서의 기록 폴더: ~/.secretary/<고유 번호>/state. 업무 세션(worker-sessions.json, worker-reuse.jsonl), run-job(run-job-sessions.json,
# run-job-calls.jsonl, run-job-active\), 뒤에서 띄운 일(bg-jobs\), 업무 감시(watch\)를 두어 한 PC의 두 비서가 서로의 기록을 읽거나 섞어 쓰지 않게 한다.
# 번호가 아직 없는 사본은 Get-UsageDir에 쓴다. 번호를 읽기만 한다(만들지 않음). 옛 기록(2026-11-09까지의 ~/.secretary/state/<번호>,
# 번호 전의 ~/.claude/usage 중 이 비서 몫)은 세션을 열 때 한 번 복사해 온다(src/core/state-dir-migrate.ts, 옛 파일은 그대로 둔다).
# TS 쪽 짝: src/core/paths.ts secretaryStateDir.
function Get-SecretaryStateDir([string]$Root = $SecretaryRoot) {
  $id = Read-SecretaryId $Root
  if ($id) { Join-Path (Get-SecretaryHome) "$id\state" } else { Get-UsageDir }
}

# 2026-11-09까지의 이 비서 기록 폴더(~/.secretary/state/<번호>). 그때 띄운 일(bg-jobs)·감시(watch)를 끝까지 찾을 때만 읽는다. 번호가 없으면 $null.
function Get-LegacySecretaryStateDir([string]$Root = $SecretaryRoot) { # legacy-name: state-dir
  $id = Read-SecretaryId $Root
  if ($id) { Join-Path (Get-SecretaryHome) "state\$id" } else { $null }
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
# (src/mistake-guards/repeat-hook.ts, 기능 mistake-guards. 기준은 this-secretary.local.json의 mistake-guards 칸 repeatLimit). 그 파일이 없으면 빈 목록.
function Get-RepeatHook {
  $hook = Join-Path $SecretaryRoot 'src\mistake-guards\repeat-hook.ts'
  if (-not (Test-Path -LiteralPath $hook)) { return @() }
  [pscustomobject]@{ matcher = 'Bash|PowerShell|Read|Write|WebFetch|mcp__.*'; hooks = @([pscustomobject]@{ type = 'command'; command = "node `"$hook`""; timeout = 10 }) }
}

# BOM 없는 UTF-8로 쓴다(-Append면 덧붙인다). 비서·node가 UTF-8로 읽는다.
function Write-Utf8File([string]$Path, [string]$Text, [switch]$Append) {
  $enc = New-Object Text.UTF8Encoding $false
  if ($Append) { [IO.File]::AppendAllText($Path, $Text, $enc) } else { [IO.File]::WriteAllText($Path, $Text, $enc) }
}

# 비서 설치마다의 고유 번호(짧은 무작위 글자): 비서 폴더 맨 위 .secretary-id. 처음 필요할 때(설치 점검, install-scheduled-tasks.ps1, 업데이트) 만들고
# 그 뒤로 계속 쓴다. 배포판·git·업데이트에 들어가지 않는다. 예약 작업 이름 끝에 붙고('Secretary Idle Jobs (A3F9)'), 다른 폴더의 비서가
# 같은 번호면 이 비서를 옮기거나 복사하고 남은 사본, 다르면 다른 비서로 가린다. TS 쪽 짝: src/setup/secretary-id.ts(글자·꼴이 같다).
# 번호는 어디서나 대문자다(파일, 작업 이름, 변수 이름). 소문자로 적힌 파일도 대문자로 읽고, Get-SecretaryId가 대문자로 고쳐 쓴다.
$SecretaryIdFile = '.secretary-id'
# 모음(A·E·U·Y, I·O는 원래 없음)을 빼 새 번호가 낱말이 되지 않는다(~/.secretary에 함께 쓰는 이름과 안 겹침). 모음 든 옛 번호도 그대로 읽는다.
$SecretaryIdAlphabet = 'BCDFGHJKMNPQRSTVWXZ23456789'

# 그 비서 폴더의 번호(-File이면 그 파일), 대문자로. 없거나 꼴이 아니면 $null.
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
  try { Write-Utf8File $File "$id`n" } catch { return $null }
  $id
}

# 예약 작업의 등록 이름: features.json의 이름 + 이 비서 번호. 번호가 없으면 이름 그대로(번호 붙기 전의 옛 이름).
# 작업 스케줄러는 이름의 대소문자를 가리지 않는다(소문자 번호로 등록된 작업도 같은 작업으로 찾는다).
function Get-TaskNameWithId([string]$Name, [string]$Id) { if ($Id) { "$Name ($($Id.ToUpperInvariant()))" } else { $Name } }

# 비서 폴더 환경변수 이름: SECRETARY_<번호 대문자>_DIR(예: SECRETARY_A3F9_DIR). 번호가 없으면 옛 이름 SECRETARY_DIR. TS 쪽 짝: src/core/paths.ts secretaryDirEnv.
function Get-SecretaryDirEnv([string]$Id) { if ($Id) { "SECRETARY_$($Id.ToUpperInvariant())_DIR" } else { 'SECRETARY_DIR' } }

# 이 비서가 띄우는 것에 넘길 비서 폴더 환경변수(이름 → 값): 이 비서 번호의 변수와 옛 이름. 번호를 읽기만 한다(만들지 않음).
function Get-SecretaryDirVars([string]$Root = $SecretaryRoot) {
  $vars = [ordered]@{ SECRETARY_DIR = $Root } # legacy-name: env-secretary-dir
  $id = Read-SecretaryId $Root
  if ($id) { $vars[(Get-SecretaryDirEnv $id)] = $Root }
  $vars
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
# 위에 비서 폴더가 없으면(옮겼거나 지운 폴더) 이 비서의 옛 자리로 본다($null). 설치 점검과 같은 판단이다(src/setup/other-secretaries.ts).
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
# 알 수 없으면 $null. 설치 점검의 짝: src/setup/windows-probe.ts taskTargetFile.
function Get-TaskTargetFile($Action) {
  if (-not $Action) { return $null }
  if ("$($Action.Arguments)" -match '(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))') { $t = if ($Matches[1]) { $Matches[1] } else { $Matches[2] } }
  elseif ("$($Action.Execute)" -match '[\\/]') { $t = "$($Action.Execute)".Trim('"') }
  else { return $null }
  if ([IO.Path]::IsPathRooted($t)) { return $t }
  if ($Action.WorkingDirectory) { return Join-Path $Action.WorkingDirectory $t }
  $null
}

# 구독 대화 캐시(1시간) 안에 다시 읽을 기준(분). 업무 감시(watch-worker.ps1)·뒤에서 띄운 일 기다리기(wait-job.ps1)가 이 분마다 비서를 깨우고,
# 세션 이어 쓰기도 이 안일 때만 한다. 캐시가 살아 있을 때 읽으면 싸고 캐시가 다시 1시간 늘어난다. 여기 한 곳만 고친다.
$CacheWakeMinutes = 55

# 세션 이어 쓰기 기준(run-job 자동 이어 부르기, 업무 세션 재사용): 마지막 호출·업무 끝 뒤 이 분 안이고 문맥이 이 토큰 미만일 때.
# 캐시(1시간)가 살아 있어 새 세션보다 싸다. 실측(run-job-calls.jsonl, scripts/run-job/run-job-stats.ps1)을 보며 여기 한 곳만 고친다.
$SessionReuseMinutes = $CacheWakeMinutes
# 2026-11-08 8만→20만: 업무 세션이 끝날 때 문맥이 늘 8만을 넘어(중앙값 19만) 재사용이 0번이었다. 2주쯤 이어 쓴 업무와 새로 띄운 업무를 비교해 다시 정한다.
$SessionReuseMaxContext = 200000

# 이 비서 번호의 비서 폴더 환경변수(SECRETARY_<번호>_DIR)를 지금 프로세스에 맞춘다(맨 위 설명, 띄우는 것이 물려받는다).
foreach ($v in (Get-SecretaryDirVars).GetEnumerator()) { Set-Item -LiteralPath "env:$($v.Key)" -Value $v.Value }
