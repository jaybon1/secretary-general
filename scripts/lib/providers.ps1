# 다른 스크립트가 dot-source 해서 쓰는 공용 함수: 업무 세션·작업을 어느 공급자로 돌릴지 고른다(common.ps1 다음에 부른다).
# (업무 세션 다루기는 worker-lib.ps1, 기억 MCP 붙이기는 memory-mcp.ps1, 다른 회사 CLI 실행은 run-job-other.ps1)
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

function Set-KeyEnv([string]$Name) {
  $path = Join-Path (Get-KeysDir) "$Name.env"
  if (-not (Test-Path $path)) { throw "'$Name' 키 파일이 없어요: $path" }
  foreach ($line in Get-Content -Encoding UTF8 $path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      Set-Item -LiteralPath "env:$($Matches[1])" -Value $Matches[2].Trim('"')
    }
  }
}

# 공급자 환경을 현재 프로세스에 넣는다. Clear-HostClaudeEnv 뒤에 부른다. 이름을 안 주면 providers.json의 default.
function Use-Provider([string]$Name) {
  $config = Get-ProviderConfig
  if (-not $Name) { $Name = $config.default }
  $p = $config.providers.$Name
  if (-not $p) { throw "공급자 설정이 없어요: $Name (scripts/lib/providers.json)" }
  # 사용량 기록(~/.claude/usage/subscription-<계정>.json, Get-UsageKey)을 어느 공급자 것으로 볼지 상태줄·정지 훅에 알려 준다.
  $env:SECRETARY_PROVIDER = $Name
  switch ($p.type) {
    # 두 번째 구독 계정은 키 폴더의 <공급자이름>.env에 CLAUDE_CONFIG_DIR=<그 계정으로 /login한 설정 폴더>를 둔다. 없으면 이 PC 기본 로그인.
    'claude-subscription' { if (Test-Path (Join-Path (Get-KeysDir) "$Name.env")) { Set-KeyEnv $Name } }
    'claude-bedrock' {
      $env:CLAUDE_CODE_USE_BEDROCK = '1'
      $env:AWS_REGION = $p.region
      Set-KeyEnv $Name
    }
    'claude-api-key' { Set-KeyEnv $Name }
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
  # effort(생각 깊이, low|medium|high|xhigh|max)는 공급자에 기본값을 두고, 스크립트의 -Effort가 있으면 그쪽을 쓴다.
  [pscustomobject]@{ Name = $Name; Type = $p.type; Models = $models; Effort = $p.effort }
}

# --model에 넘길 이름. 공급자 models에 같은 이름(예: fable)이 있으면 그 모델 이름으로 바꾼다.
function Resolve-ProviderModel($Info, [string]$Model) {
  if ($Model -and $Info.Models -and $Info.Models.$Model) { return $Info.Models.$Model }
  $Model
}

# 이 PC의 Claude 계정 설정 폴더: 기본(''= ~/.claude 또는 지금 CLAUDE_CONFIG_DIR)과, 구독 공급자 키 파일의 CLAUDE_CONFIG_DIR(계정 b: ~/.claude-b).
# TS 쪽 짝: src/core/provider-accounts.ts accountConfigDirs(대화 기록 폴더 찾기).
function Get-AccountConfigDirs {
  $dirs = @('')
  foreach ($prop in (Get-ProviderConfig).providers.PSObject.Properties) {
    $path = Join-Path (Get-KeysDir) "$($prop.Name).env"
    if ($prop.Value.type -ne 'claude-subscription' -or -not (Test-Path $path)) { continue }
    foreach ($line in Get-Content -Encoding UTF8 $path) {
      if ($line -match '^\s*CLAUDE_CONFIG_DIR\s*=\s*(.*?)\s*$') { $dirs += [Environment]::ExpandEnvironmentVariables($Matches[1].Trim('"')) }
    }
  }
  $dirs
}

# 사용량 기록 이름(~/.claude/usage/<이름>.json, <이름>.refresh, guard-override-<이름>.json): Claude 구독 공급자는 "subscription-<로그인 계정>"
# (로그인 폴더 .claude.json의 oauthAccount.emailAddress에서 @ 앞, 예: subscription-kim2), 계정을 못 읽거나 계정이 없는 공급자는 공급자 이름.
# 공급자 이름(subscription, subscription-b 등)은 넣지 않는다: 계정이 같으면 같은 파일이다.
# 한 PC의 두 비서가 다른 계정으로 로그인해도 서로의 사용량·정지 해제를 읽거나 덮어쓰지 않게 한다.
# TS 쪽 짝(같은 규칙): src/usage/files.ts usageKey, src/core/provider-accounts.ts providerLoginFile·loginAccount.

# 공급자의 로그인 파일(.claude.json). 구독 공급자만: 키 파일의 CLAUDE_CONFIG_DIR, 없으면 지금 프로세스가 그 공급자로 돌 때(SECRETARY_PROVIDER)
# 지금 CLAUDE_CONFIG_DIR, 없으면 기본 로그인(사용자 폴더, 시험은 SECRETARY_LOGIN_HOME으로 임시 폴더). Use-Provider가 띄우는 것과 같은 폴더다.
# -Clean은 부른 쪽 환경(CLAUDE_CONFIG_DIR·SECRETARY_PROVIDER)을 보지 않는다: Clear-HostClaudeEnv + Use-Provider $Name 뒤에 읽는 것과 같다
# (키 파일의 CLAUDE_CONFIG_DIR, 없으면 기본 로그인). 다른 공급자들의 지금 이름을 셀 때 쓴다(Remove-LegacyUsageFiles).
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
  $loginHome = if ($env:SECRETARY_LOGIN_HOME) { $env:SECRETARY_LOGIN_HOME } else { $env:USERPROFILE }
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

# 지금 이름($Key)에서 거슬러 본 옛 이름: 계정 칸이 없던 "<공급자>"와, 계정 앞에 공급자 이름이 붙던 "<공급자>-<계정>"(예: subscription-b-kim2).
# 지금 이름이 공급자 이름 그대로면(계정을 못 읽음) 없다. TS 쪽 짝: src/usage/files.ts legacyUsageKeys.
function Get-LegacyUsageKeys([string]$Name, [string]$Key) {
  $plain = $Name -replace '[^A-Za-z0-9_.-]', '_'
  if (-not $Key -or $Key -eq $plain -or -not $Key.StartsWith('subscription-')) { return @() }
  @($plain, "$plain-$($Key.Substring('subscription-'.Length))") | Select-Object -Unique | Where-Object { $_ -ne $Key }
}

# 계정 이름으로 쓴 바로 뒤, 옛 이름(Get-LegacyUsageKeys)의 .json·.refresh를 지운다. 어떤 공급자의 지금 이름과 같은 이름은 지우지 않는다
# (계정 이름이 b면 subscription의 새 이름 subscription-b가 공급자 subscription-b의 옛 이름과 같다). 옛 "<공급자>-<계정>" 정지 해제
# (guard-override-<옛 이름>.json)는 같은 계정이므로 새 이름에 없을 때 옮기고, 그 밖의 옛 해제는 지운다.
# 지금 이름 목록은 공급자마다 그 공급자 환경으로 깨끗이 센다(Get-UsageKey -Clean, usage-query.ps1이 조회하는 환경과 같다): 부른 쪽에
# CLAUDE_CONFIG_DIR가 남아 있어도 다른 공급자의 실제 계정 이름을 옛 이름으로 잘못 보고 지우지 않게.
# TS 쪽 짝: src/usage/files.ts dropLegacyUsageFiles(상태줄이 쓴 뒤 부른다).
function Remove-LegacyUsageFiles([string]$Name, [string]$Key) {
  $old = @(Get-LegacyUsageKeys $Name $Key)
  $dir = Get-UsageDir
  $found = $old | Where-Object { $k = $_; @("$k.json", "$k.refresh", "guard-override-$k.json") | Where-Object { Test-Path -LiteralPath (Join-Path $dir $_) } }
  if (-not $found) { return }
  $current = @((Get-ProviderConfig).providers.PSObject.Properties | ForEach-Object { Get-UsageKey $_.Name -Clean })
  $plain = $Name -replace '[^A-Za-z0-9_.-]', '_'
  $lift = Join-Path $dir "guard-override-$Key.json"
  foreach ($oldKey in $old) {
    if ($current -contains $oldKey) { continue }
    foreach ($ext in 'json', 'refresh') {
      Remove-Item -LiteralPath (Join-Path $dir "$oldKey.$ext") -Force -ErrorAction SilentlyContinue
    }
    $oldLift = Join-Path $dir "guard-override-$oldKey.json"
    if (-not (Test-Path -LiteralPath $oldLift)) { continue }
    if ($oldKey -ne $plain -and -not (Test-Path -LiteralPath $lift)) { Move-Item -LiteralPath $oldLift $lift -ErrorAction SilentlyContinue }
    else { Remove-Item -LiteralPath $oldLift -Force -ErrorAction SilentlyContinue }
  }
}
