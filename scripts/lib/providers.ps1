# 다른 스크립트가 dot-source 해서 쓰는 공용 함수: 업무 세션·작업을 어느 공급자로 돌릴지 고른다(common.ps1 다음에 부른다).
# (업무 세션 다루기는 worker-lib.ps1, 기억 MCP 붙이기는 memory-mcp.ps1, 다른 회사 CLI 실행은 run-job-other-cli.ps1)
# 공급자 목록과 기본값은 scripts/lib/providers.json(비밀값 없음). 키는 저장소 밖 키 폴더의 <공급자이름>.env에
# KEY=VALUE 줄로 둔다. 키 폴더: SECRETARY_KEYS_DIR, 없으면 %USERPROFILE%\.secretary\keys (Get-SecretaryHome, common.ps1을 먼저 dot-source 한다)
# 비서 세션 자신은 언제나 구독으로 돈다. 이 함수는 비서가 따로 띄우는 claude 프로세스에만 쓴다.

function Get-ProviderConfig {
  Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'providers.json') | ConvertFrom-Json
}

function Get-KeysDir {
  if ($env:SECRETARY_KEYS_DIR) { return $env:SECRETARY_KEYS_DIR }
  Join-Path (Get-SecretaryHome) 'keys'
}

# $Pattern(providers.json의 keyFile, 예: anthropic-api-key-*.env)이 있으면 키 폴더에서 그 꼴 파일 하나를 쓴다.
# 계정이 든 키 파일 이름(키 폴더 README 이름 규칙)을 git에 올라가는 providers.json에 적지 않기 위해서다.
function Set-KeyEnv([string]$Name, [string]$Pattern) {
  if ($Pattern) {
    $found = @(Get-ChildItem -LiteralPath (Get-KeysDir) -Filter $Pattern -File -ErrorAction SilentlyContinue)
    if ($found.Count -eq 0) { throw "'$Name' 키 파일이 없어요: $(Join-Path (Get-KeysDir) $Pattern)" }
    if ($found.Count -gt 1) { throw "'$Name' 키 파일이 여러 개예요($(($found | ForEach-Object Name) -join ', ')). 하나만 남겨 주세요." }
    $path = $found[0].FullName
  } else {
    $path = Join-Path (Get-KeysDir) "$Name.env"
  }
  if (-not (Test-Path $path)) { throw "'$Name' 키 파일이 없어요: $path" }
  foreach ($line in Get-Content -Encoding UTF8 $path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      Set-Item -LiteralPath "env:$($Matches[1])" -Value $Matches[2].Trim('"')
    }
  }
}

# 'auto'(providers.json의 default나 -Provider auto, 기능 multi-subscription "다중 구독"): 넘길 구독(계정 a 'subscription' 밖의 claude-subscription) 중
# 지금 가장 여유 있는 것. 고르는 규칙은 질문 훅의 <secretary-usage> 줄과 같은 코드(node src/cli.ts subscription-pick, src/usage/subscription-routing.ts)다.
# 그 명령이 실패하면 넘길 구독 중 providers.json에서 첫째, 없으면 계정 a.
function Resolve-AutoProvider($config) {
  # 이 파일은 늘 common.ps1 뒤에 불러온다(Invoke-SecretaryCli, $SecretaryRoot).
  $r = Invoke-SecretaryCli @('subscription-pick', '--root', $SecretaryRoot)
  $picked = ($r.out -join ' ').Trim()
  if ($picked -and $picked -ne 'auto' -and $config.providers.$picked) { return $picked }
  $first = $config.providers.PSObject.Properties | Where-Object { $_.Value.type -eq 'claude-subscription' -and $_.Name -ne 'subscription' } | Select-Object -First 1
  if ($first) { $first.Name } else { 'subscription' }
}

# 공급자 환경을 현재 프로세스에 넣는다. Clear-HostClaudeEnv 뒤에 부른다. 이름을 안 주면 providers.json의 default('auto'면 Resolve-AutoProvider).
function Use-Provider([string]$Name) {
  $config = Get-ProviderConfig
  if (-not $Name) { $Name = $config.default }
  if ($Name -eq 'auto') { $Name = Resolve-AutoProvider $config }
  $p = $config.providers.$Name
  if (-not $p) { throw "공급자 설정이 없어요: $Name (scripts/lib/providers.json)" }
  # 사용량 기록(~/.secretary/usage/subscription-<계정>.json, Get-UsageKey)을 어느 공급자 것으로 볼지 상태줄·정지 훅에 알려 준다.
  $env:SECRETARY_PROVIDER = $Name
  switch ($p.type) {
    # 두 번째부터의 구독 계정(b, c, …)은 키 폴더의 <공급자이름>.env에 CLAUDE_CONFIG_DIR=<그 계정으로 /login한 설정 폴더>를 둔다. 없으면 이 PC 기본 로그인.
    'claude-subscription' { if (Test-Path (Join-Path (Get-KeysDir) "$Name.env")) { Set-KeyEnv $Name } }
    'claude-bedrock' {
      $env:CLAUDE_CODE_USE_BEDROCK = '1'
      $env:AWS_REGION = $p.region
      Set-KeyEnv $Name
    }
    'claude-api-key' { Set-KeyEnv $Name $p.keyFile }
    # Anthropic 호환 게이트웨이. 이 프로세스에만 주소·키를 넣어 이 PC의 구독 로그인은 그대로 둔다.
    'claude-gateway' {
      $env:ANTHROPIC_BASE_URL = $p.base_url
      $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      $env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
      Set-KeyEnv $Name
    }
    # 로그인은 copilot이 자기 저장소에 둔다. Claude Code가 아니라 run-job.ps1에서만 따로 실행한다.
    'copilot-cli' { }
    'antigravity-cli' { }
    default { throw "'$Name'($($p.type))는 아직 연결되지 않았어요. 설치하고 시험한 뒤 scripts/lib/providers.ps1에 연결해야 해요." }
  }
  # 역할 정의의 model: opus|sonnet|haiku가 이 공급자의 모델 이름으로 풀리게 한다.
  $models = $p.models
  if ($models) {
    if ($models.main) { $env:ANTHROPIC_MODEL = $models.main }
    if ($models.opus) { $env:ANTHROPIC_DEFAULT_OPUS_MODEL = $models.opus }
    if ($models.sonnet) { $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $models.sonnet }
    if ($models.haiku) { $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $models.haiku }
  }
  # effort(추론 수준, low|medium|high|xhigh|max)는 공급자에 기본값을 두고, 스크립트의 -Effort가 있으면 그쪽을 쓴다.
  [pscustomobject]@{ Name = $Name; Type = $p.type; Models = $models; Effort = $p.effort; PersonalDataAllowed = (Test-PersonalDataAllowed $p) }
}

# 개인정보(프로필, 기억, 다른 업무·일정·사람·계정 이야기)를 그 공급자에게 보내도 되는가: providers.json 공급자의
# personalDataAllowed가 true일 때만이고, 값이 없거나 true가 아니면 안 된다(안전한 쪽). 구독·자기 유료 계정은 true,
# 외부 중개 회사(게이트웨이)·무료 플랜·무료 키·연결 자리만 있는 것은 false다. 중개 회사는 믿기 어려울 수 있고,
# 무료 플랜은 보낸 글을 학습 데이터로 쓸 수 있기 때문이다(2026-11-13 결정). 사용량·로그인·자동 판단 모드는 이 값이 아니라 type으로 가른다.
# JSON의 true(불 값)만 본다: PowerShell은 글자 "true"도 -eq $true로 같다고 보므로 형을 함께 확인한다.
function Test-PersonalDataAllowed($Provider) { $null -ne $Provider -and $Provider.personalDataAllowed -is [bool] -and $Provider.personalDataAllowed }

# 비서 폴더에서 돌면 프로필·기억 주입 훅과 기억 MCP가 붙어 개인정보가 공급자에게 넘어가므로, 개인정보를 보내지 않는 공급자는 막는다(run-job.ps1).
function Assert-SecretaryFolderProvider($Info, [string]$Folder, [string]$Root = $SecretaryRoot) {
  if ($Info.PersonalDataAllowed) { return }
  if ((Resolve-Path $Folder).Path.TrimEnd('\') -ne (Resolve-Path $Root).Path.TrimEnd('\')) { return }
  throw "개인정보를 보내지 않는 공급자($($Info.Name), providers.json의 personalDataAllowed가 true가 아님)는 비서 폴더에서 돌리지 않아요. -Folder를 빼거나(workspaces\_run-job-home) 작업 공간을 주세요."
}

# 개인정보를 보내지 않는 공급자로 보내는 지시(-Prompt 글이나 -PromptFile)와 거기 적힌 TASK.md에 사용자 호칭, 기억·대화 번호(#1234 꼴),
# 다른 작업 공간 이름이 있으면 띄우기 전에 멈춘다(delegate-check.ts private가 DB에서 그 값을 읽어 찾는다). 무엇이 어느 줄에서 걸렸는지
# 예외 글에 담아, 비서가 그 줄을 고쳐 쓰고 다시 띄우게 한다. 검사를 못 돌리면(DB 없음 등) 그대로 보내지 않고 멈춘다.
# start-worker.ps1(Start-Worker), send-worker.ps1(Send-Worker, 그 세션의 공급자 기준), run-job.ps1이 부른다. 개인정보를 보내도 되는 공급자면 아무것도 하지 않는다.
function Assert-PrivateFreeBrief($Info, [string]$Folder, [string]$PromptFile, [string]$Prompt) {
  if ($Info.PersonalDataAllowed) { return }
  $file = $PromptFile
  $temp = $null
  if (-not $file) {
    $temp = Join-Path $env:TEMP ('secretary-private-check-{0}.md' -f [guid]::NewGuid().ToString('N'))
    Write-Utf8File $temp $Prompt
    $file = $temp
  }
  # PowerShell 5.1은 Stop일 때 네이티브 명령의 stderr 한 줄도 오류로 던진다. 이 함수 안에서만 Continue로 둔다.
  $ErrorActionPreference = 'Continue'
  try {
    $folderArg = if ($Folder) { @('--folder', ([IO.Path]::GetFullPath($Folder).TrimEnd('\'))) } else { @() }
    $out = @(& node --no-warnings (Join-Path $ScriptsDir 'delegate-check\delegate-check.ts') private $file --provider $Info.Name @folderArg 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally { if ($temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue } }
  if ($code -eq 0) { return }
  $text = $out -join "`n"
  if ($temp) { $text = $text.Replace($temp, '(-Prompt 글)') }
  if ($code -eq 1) { throw "개인정보를 보내지 않는 공급자($($Info.Name))로 보낼 글에 개인정보가 있어 멈췄어요(띄우거나 보내지 않음).`n$text" }
  throw "개인정보 검사를 못 돌려 멈췄어요($($Info.Name)): $text"
}

# 폴더 훅(worker-folder-guard.mjs)에 넘길 비서 폴더 인자: ' --secretary "<긴 이름>"'과, 다르면 ' --secretary "<8.3 짧은 이름>"'.
# 셸 명령이 이 비서 폴더를 어느 형식으로 적어도(8.3 짧은 이름 형식 PROGRA~1 같은 것 포함) 훅이 알아본다. 짧은 이름을 못 구하면 긴 이름만.
function Get-SecretaryGuardArgs([string]$Root = $SecretaryRoot) {
  $long = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $forms = @($long)
  try {
    $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($long).ShortPath.TrimEnd('\')
    if ($short -and $short -ne $long) { $forms += $short }
  } catch {}
  -join ($forms | ForEach-Object { " --secretary `"$_`"" })
}

# 업무 세션·run-job 설정(--settings)의 PreToolUse 훅 하나(scripts/worker/worker-folder-guard.mjs): $Folder 밖 쓰기, git push, 게시·업로드,
# 큰 삭제(-LockTests면 테스트 파일 수정도), 비서 폴더를 건드리는 셸 명령(bin\ 진입점 부르기만 된다)을 막는다.
# 개인정보를 보내지 않는 공급자($Info.PersonalDataAllowed가 아님)면 --limit-reads로 읽기도 막는다: Read·Grep·Glob은 $Folder와
# 공통 스킬 폴더(workspaces\_skills)만, 셸 명령은 키 폴더·~/.secretary·notes·inbox·Claude 설정 폴더·secretary.db를 적으면 거절.
# 개인 자료가 그 공급자(외부 중개 서버 등)로 나가지 않게 하기 위해서다(2026-11-18 결정: 공간 폴더, 공통 스킬, 그 업무의 결과 폴더만).
# -ReadDir(run-job의 결과 폴더)를 주면 읽기는 $Folder 전체 대신 그 폴더와 $Folder의 AGENTS.md·CLAUDE.md만이고, 셸 명령이 그 옆의 다른 결과 폴더를 적어도 막는다.
# -ReadRoot: 읽기를 더 허용할 폴더(start-worker -PromptFile의 지시 사본 폴더).
function Get-FolderGuardHook($Info, [string]$Folder, [switch]$LockTests, [string]$ReadDir, [string[]]$ReadRoot = @()) {
  $q = { param($p) "`"$("$p".TrimEnd('\'))`"" }
  $cmd = "node $(& $q (Join-Path $ScriptsDir 'worker\worker-folder-guard.mjs')) $(& $q $Folder)" + $(if ($LockTests) { ' --lock-tests' } else { '' }) + (Get-SecretaryGuardArgs)
  $matcher = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'
  if (-not $Info.PersonalDataAllowed) {
    $cmd += " --limit-reads --read-root $(& $q (Join-Path (Get-WorkspaceRoot) '_skills')) --private $(& $q (Get-KeysDir))"
    foreach ($r in @($ReadRoot | Where-Object { $_ })) { $cmd += " --read-root $(& $q $r)" }
    if ($ReadDir) {
      foreach ($p in @($ReadDir, (Join-Path $Folder 'AGENTS.md'), (Join-Path $Folder 'CLAUDE.md'))) { $cmd += " --read-scope $(& $q $p)" }
      $cmd += " --sibling-private $(& $q $ReadDir)"
    }
    $matcher += '|Read|Grep|Glob'
  }
  [pscustomobject]@{ matcher = $matcher; hooks = @([pscustomobject]@{ type = 'command'; command = $cmd; timeout = 5 }) }
}

# 구독 밖 공급자로 도는 run-job(run-job.ps1)의 설정: 허용 목록(common.ps1 Get-WorkerPermissions)에, 개인정보를 보내지 않는 공급자면
# 업무 세션과 같은 폴더 훅(Get-FolderGuardHook, 작업 폴더 $Folder 기준)을, $RepeatHooks가 있으면 그것을 더한다.
# 개인정보를 보내도 되는 공급자(API 키 등)는 지금처럼 폴더 훅 없이 돈다(비서 코드 일처럼 작업 폴더 밖 원본을 읽는 일이 있다).
# $ReadDir(Resolve-RunJobReadDir)가 있으면 읽기를 그 결과 폴더와 작업 폴더의 AGENTS.md로 좁힌다.
# 설정 객체는 업무 세션과 같은 함수(common.ps1 New-ClaudeRunSettings)로 만들어, 작업 폴더 전체 경로의 Edit 규칙도 업무 세션처럼 붙는다.
function Get-RunJobPermissions($Info, [string]$Folder, $RepeatHooks = @(), [string]$ReadDir) {
  $guard = if (-not $Info.PersonalDataAllowed) { Get-FolderGuardHook $Info $Folder -ReadDir $ReadDir } else { $null }
  New-ClaudeRunSettings -Permissions -EditFolder $Folder -GuardHook $guard -RepeatHooks $RepeatHooks
}

# run-job의 결과 폴더(-ReadDir)를 정해 전체 경로로 돌려준다(없으면 $null). 기본 작업 폴더(-Folder 없음, _run-job-home)에서 개인정보를 보내지 않는
# Claude Code 공급자로 돌 때는 꼭 받는다: 그런 run-job은 _run-job-home 전체가 아니라 그 일의 결과 폴더(output/research/<날짜-일이름>)와
# AGENTS.md만 읽는다(2026-11-18 결정: 공간 폴더, 공통 스킬, 그 업무의 결과 폴더만). 없으면 지어 만들지 않고 멈춘다: 지시가 쓰라고 한
# 결과 폴더와 어긋난 폴더를 읽게 되기 때문이다. 상대 경로는 작업 폴더 기준이고, 작업 폴더 안의 하위 폴더여야 하며, 없으면 만든다.
# -Folder로 공간을 준 run-job(과 담당자)은 그 폴더 전체를 읽으므로 받지 않는다.
function Resolve-RunJobReadDir($Info, [string]$Folder, [string]$ReadDir, [bool]$FolderGiven) {
  if ($FolderGiven) {
    if ($ReadDir) { throw '-ReadDir는 기본 작업 폴더(_run-job-home)에서 돌 때만 줘요. -Folder로 준 공간은 그 폴더 전체를 읽어요.' }
    return $null
  }
  if (-not $ReadDir) {
    if (-not $Info.PersonalDataAllowed -and "$($Info.Type)" -like 'claude-*') {
      throw "개인정보를 보내지 않는 공급자($($Info.Name))의 run-job은 그 일의 결과 폴더만 읽어요. -ReadDir <결과 폴더>(예: output\research\<YYYYMMDD>-<일이름>)를 주세요."
    }
    return $null
  }
  $root = [IO.Path]::GetFullPath($Folder).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($ReadDir)) { $ReadDir } else { Join-Path $root $ReadDir })).TrimEnd('\')
  if (-not $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { throw "-ReadDir는 작업 폴더($root) 안의 하위 폴더여야 해요: $full" }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { New-Item -ItemType Directory -Force $full | Out-Null }
  $full
}

# --model에 넘길 이름. 공급자 models에 같은 이름(예: fable)이 있으면 그 모델 이름으로 바꾼다.
function Resolve-ProviderModel($Info, [string]$Model) {
  if ($Model -and $Info.Models -and $Info.Models.$Model) { return $Info.Models.$Model }
  $Model
}

# 이 PC의 Claude 계정 설정 폴더(전체 경로): 지금 프로세스의 CLAUDE_CONFIG_DIR(있으면), 기본 ~/.claude, 구독 공급자 키 파일의
# CLAUDE_CONFIG_DIR(계정 b: ~/.claude-b, 파일마다 첫 줄만) 순서로, 같은 글자의 경로는 한 번만. TS 쪽 짝(같은 결과):
# src/core/provider-accounts.ts accountConfigDirs(대화 기록 폴더 찾기). 예전에는 맨 앞에 ''(기본)만 넣어 지금 CLAUDE_CONFIG_DIR을 빠뜨렸다.
# 기본 ~/.claude는 그 경로로 나오므로, 그 폴더로 claude를 부를 때는 CLAUDE_CONFIG_DIR을 지운다(worker-lib.ps1 Use-ConfigDir: 넣으면
# 로그인 파일을 ~/.claude.json 대신 그 폴더 안에서 찾는다).
function Get-AccountConfigDirs {
  $dirs = New-Object System.Collections.Generic.List[string]
  $add = { param($d) if ($d -and -not $dirs.Contains($d)) { $dirs.Add($d) } }
  & $add $env:CLAUDE_CONFIG_DIR
  & $add (Join-Path $env:USERPROFILE '.claude')
  foreach ($prop in (Get-ProviderConfig).providers.PSObject.Properties) {
    $path = Join-Path (Get-KeysDir) "$($prop.Name).env"
    if ($prop.Value.type -ne 'claude-subscription' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
      if ($line -match '^\s*CLAUDE_CONFIG_DIR\s*=\s*(.*?)\s*$') { & $add ([Environment]::ExpandEnvironmentVariables($Matches[1].Trim('"'))); break }
    }
  }
  $dirs.ToArray()
}

# 사용량 기록 이름(~/.secretary/usage/<이름>.json, <이름>.refresh, usage-guard-override-<이름>.json): Claude 구독 공급자는 "subscription-<로그인 계정>"
# (로그인 폴더 .claude.json의 oauthAccount.emailAddress에서 @ 앞, 예: subscription-kim2), 계정을 못 읽거나 계정이 없는 공급자는 공급자 이름.
# 공급자 이름(subscription, subscription-b 등)은 넣지 않는다: 계정이 같으면 같은 파일이다.
# 한 PC의 두 비서가 다른 계정으로 로그인해도 서로의 사용량·정지 해제를 읽거나 덮어쓰지 않게 한다.
# TS 쪽 짝(같은 규칙): src/usage/usage-files.ts usageKey, src/core/provider-accounts.ts providerLoginFile·loginAccount.

# 공급자의 로그인 파일(.claude.json). 구독 공급자만: 키 파일의 CLAUDE_CONFIG_DIR, 없으면 지금 프로세스가 그 공급자로 돌 때(SECRETARY_PROVIDER)
# 지금 CLAUDE_CONFIG_DIR, 없으면 기본 로그인(사용자 폴더, 테스트는 SECRETARY_TEST_LOGIN_HOME으로 임시 폴더). Use-Provider가 띄우는 것과 같은 폴더다.
# -Clean은 부른 쪽 환경(CLAUDE_CONFIG_DIR·SECRETARY_PROVIDER)을 보지 않는다: Clear-HostClaudeEnv + Use-Provider $Name 뒤에 읽는 것과 같다
# (키 파일의 CLAUDE_CONFIG_DIR, 없으면 기본 로그인). 공급자 환경으로 깨끗이 읽을 때 쓴다.
function Get-ProviderLoginFile([string]$Name, [switch]$Clean) {
  $p = (Get-ProviderConfig).providers.$Name
  if (-not $p -or $p.type -ne 'claude-subscription') { return $null }
  $dir = $null
  $keyFile = Join-Path (Get-KeysDir) "$Name.env"
  if (Test-Path -LiteralPath $keyFile -PathType Leaf) {
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $keyFile) {
      if ($line -match '^\s*CLAUDE_CONFIG_DIR\s*=\s*(.*?)\s*$') { $dir = [Environment]::ExpandEnvironmentVariables($Matches[1].Trim('"')); break }
    }
  }
  $current = if ($env:SECRETARY_PROVIDER) { $env:SECRETARY_PROVIDER } else { 'subscription' }
  if (-not $dir -and -not $Clean -and $current -eq $Name -and $env:CLAUDE_CONFIG_DIR) { $dir = $env:CLAUDE_CONFIG_DIR }
  if ($dir) { return Join-Path $dir '.claude.json' }
  $loginHome = if ($env:SECRETARY_TEST_LOGIN_HOME) { $env:SECRETARY_TEST_LOGIN_HOME } else { $env:USERPROFILE }
  Join-Path $loginHome '.claude.json'
}

# 공급자의 로그인 계정(메일 @ 앞). 못 읽으면 $null. 파일 전체를 ConvertFrom-Json으로 읽지 않는다(PowerShell 5.1은 대소문자만 다른 키가 있으면 실패하고 느리다).
function Get-ProviderAccount([string]$Name, [switch]$Clean) {
  $file = Get-ProviderLoginFile $Name -Clean:$Clean
  if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  try { $text = [IO.File]::ReadAllText($file) } catch { return $null }
  $start = [regex]::Match($text, '"oauthAccount"\s*:\s*\{')
  if (-not $start.Success) { return $null }
  $window = $text.Substring($start.Index, [Math]::Min(4000, $text.Length - $start.Index))
  $m = [regex]::Match($window, '"emailAddress"\s*:\s*"([^"]*)"')
  if (-not $m.Success) { return $null }
  $account = ($m.Groups[1].Value -split '@')[0].Trim()
  if ($account) { $account } else { $null }
}

function Get-UsageKey([string]$Name, [switch]$Clean) {
  $account = Get-ProviderAccount $Name -Clean:$Clean
  if ($account) { 'subscription-' + ($account -replace '[^A-Za-z0-9_.-]', '_') } else { $Name -replace '[^A-Za-z0-9_.-]', '_' }
}

# 공급자의 사용량 기록 파일(-Ext refresh면 조회 시작 표시).
function Get-UsageFile([string]$Name, [string]$Ext = 'json') { Join-Path (Get-UsageDir) "$(Get-UsageKey $Name).$Ext" }

