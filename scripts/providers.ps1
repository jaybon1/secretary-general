# 다른 스크립트가 dot-source 해서 쓰는 공용 함수: 업무 세션·작업을 돌릴 설정을 scripts/providers.json에서 고른다.
# 이 비서는 이 PC에 로그인된 Claude 구독 하나로만 돈다(비밀값은 없다).

function Get-ProviderConfig {
  Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'providers.json') | ConvertFrom-Json
}

# 구독 설정을 고른다. Clear-HostClaudeEnv 뒤에 부른다. 이름을 안 주면 providers.json의 default.
function Use-Subscription([string]$Name) {
  $config = Get-ProviderConfig
  if (-not $Name) { $Name = $config.default }
  $p = $config.providers.$Name
  if (-not $p) { throw "공급자 설정이 없어요: $Name (scripts/providers.json)" }
  if ($p.type -ne 'claude-subscription') { throw "공급자 설정 '$Name'의 type은 claude-subscription이어야 해요(지금: $($p.type)). scripts/providers.json을 확인해요." }
  # 사용량 기록(~/.claude/usage/<공급자>.json)을 어느 것으로 볼지 상태줄·정지 훅에 알려 준다.
  $env:SECRETARY_PROVIDER = $Name
  # effort(생각 깊이, low|medium|high|xhigh|max)는 공급자에 기본값을 두고, 스크립트의 -Effort가 있으면 그쪽을 쓴다.
  [pscustomobject]@{ Name = $Name; Type = $p.type; Effort = $p.effort }
}

# 쉬는 업무 세션에 새 업무를 넣는다. 짧은 claude -p(Haiku, 도구는 ListAgents·SendMessage만)를 띄워 그 세션에 SendMessage로 보낸다.
# $Hit은 claude agents --json 목록 항목. 출력 글을 돌려준다.
function Send-WorkerMessage([string]$Claude, $Hit, [string]$Message) {
  # Windows PowerShell 5.1은 큰따옴표가 든 인자를 깨뜨려 넘기므로 작은따옴표로 바꾼다.
  $body = ($Message -replace '"', "'") -replace '\r?\n', ' '
  $prompt = "ListAgents로 세션 목록을 보고, 이름이 정확히 $($Hit.name) 인 세션을 찾아라(ListAgents의 대괄호 id는 bg id $($Hit.id) 와 다르다). 그 세션에 SendMessage로 아래 <msg> 안의 글을 한 글자도 바꾸지 말고 보내라. 보냈으면 '보냄'이라고만, 못 찾았으면 '못 찾음'이라고만 답하라. <msg>$body</msg>"
  # 받는 세션은 보낸 세션의 권한 모드가 자기와 다르면 메시지를 붙잡아 두고 승인을 기다린다. 업무 세션은 auto 모드라 같은 auto로 보낸다.
  # 보내는 쪽이 신뢰되지 않은 폴더에서 돌아도 메시지가 붙잡히므로, 업무 세션과 같은 공간 폴더에서 보낸다.
  Push-Location $Hit.cwd
  try { (& $Claude -p --model haiku --strict-mcp-config --disable-slash-commands --no-session-persistence --tools ListAgents,SendMessage --allowedTools ListAgents,SendMessage --permission-mode auto $prompt) -join "`n" }
  finally { Pop-Location }
}

# Claude Code 설정 폴더(CLAUDE_CONFIG_DIR, 없으면 ~/.claude).
function Get-ClaudeConfigDir {
  if ($env:CLAUDE_CONFIG_DIR) { return $env:CLAUDE_CONFIG_DIR }
  Join-Path $env:USERPROFILE '.claude'
}

# 세션의 마지막 문맥 크기: 대화 기록(<설정 폴더>\projects\*\<세션 id>.jsonl)의 마지막 assistant 메시지 usage의
# input + cache_read + cache_creation. 기록을 못 찾으면 $null.
function Get-SessionContext([string]$ConfigDir, [string]$SessionId) {
  if (-not $SessionId) { return $null }
  $file = Get-ChildItem (Join-Path $ConfigDir 'projects') -Recurse -Filter "$SessionId.jsonl" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $file) { return $null }
  $lines = @(Get-Content -Encoding UTF8 -Tail 300 $file.FullName)
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -notmatch '"type"\s*:\s*"assistant"') { continue }
    try { $u = ($lines[$i] | ConvertFrom-Json).message.usage } catch { continue }
    if ($u) { return [int]$u.input_tokens + [int]$u.cache_read_input_tokens + [int]$u.cache_creation_input_tokens }
  }
  $null
}

# 업무 세션 재사용 상태(~/.claude/usage/worker-sessions.json, bg id → 공간·업무 끝난 시각 등)와 판단 기록(worker-reuse.jsonl).
function Get-WorkerUsageDir { Join-Path $env:USERPROFILE '.claude\usage' }
function Read-WorkerState {
  try { $s = Get-Content -Raw -Encoding UTF8 (Join-Path (Get-WorkerUsageDir) 'worker-sessions.json') | ConvertFrom-Json } catch { $s = $null }
  if (-not $s) { $s = [pscustomobject]@{} }
  $s
}
function Save-WorkerState($State) {
  New-Item -ItemType Directory -Force (Get-WorkerUsageDir) | Out-Null
  [IO.File]::WriteAllText((Join-Path (Get-WorkerUsageDir) 'worker-sessions.json'), ($State | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
}
function Add-WorkerReuseLog($Entry) {
  try {
    New-Item -ItemType Directory -Force (Get-WorkerUsageDir) | Out-Null
    [IO.File]::AppendAllText((Join-Path (Get-WorkerUsageDir) 'worker-reuse.jsonl'), (($Entry | ConvertTo-Json -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  } catch { [Console]::Error.WriteLine("업무 세션 재사용 기록을 못 남겼어요: $_") }
}
