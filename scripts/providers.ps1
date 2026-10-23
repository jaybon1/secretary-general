# 다른 스크립트가 dot-source 해서 쓰는 공용 함수: 업무 세션·작업을 돌릴 설정을 scripts/providers.json에서 고른다.
# 이 비서는 이 PC에 로그인된 Claude 구독 하나로만 돈다(비밀값은 없다).

function Get-ProviderConfig {
  Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'providers.json') | ConvertFrom-Json
}

# 공급자 설정을 고른다. Clear-HostClaudeEnv 뒤에 부른다. 이름을 안 주면 providers.json의 default.
function Use-Provider([string]$Name) {
  $config = Get-ProviderConfig
  if (-not $Name) { $Name = $config.default }
  $p = $config.providers.$Name
  if (-not $p) { throw "공급자 설정이 없어요: $Name (scripts/providers.json)" }
  if ($p.type -ne 'claude-subscription') { throw "'$Name'($($p.type))는 지원하지 않아요. 이 비서는 Claude 구독(claude-subscription)만 써요." }
  # 사용량 기록(~/.claude/usage/<공급자>.json)을 어느 것으로 볼지 상태줄·정지 훅에 알려 준다.
  $env:SECRETARY_PROVIDER = $Name
  # effort(생각 깊이, low|medium|high|xhigh|max)는 공급자에 기본값을 두고, 스크립트의 -Effort가 있으면 그쪽을 쓴다.
  [pscustomobject]@{ Name = $Name; Type = $p.type; Effort = $p.effort }
}
