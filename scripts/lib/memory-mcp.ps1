# 다른 스크립트가 dot-source 해서 쓰는 공용 함수: 업무 세션·run-job에 비서 기억 MCP를 붙인다(run-job.ps1, worker-lib.ps1).
# 서버는 이 저장소의 src/mcp/server.ts(--readonly면 recall·search_log만).

# 업무 세션·run-job에 붙이는 비서 기억 읽기 도구(recall·search_log만, 쓰기 도구 없음). 개인 기억이 다른 회사 서버로
# 나가지 않게 구독 공급자(claude-subscription)에만 붙인다(2026-11-05 결정).
$MemoryReadTools = @('mcp__secretary__recall', 'mcp__secretary__search_log')
function Test-MemoryMcp($Info) { $Info.Type -eq 'claude-subscription' }

# 이 비서의 임시 파일 이름 꼬리표: 고유 번호(.secretary-id, 만들지 않고 읽기만), 없으면 비서 폴더 경로의 해시 8글자.
# 한 PC의 비서 여럿이나 worktree가 같은 %TEMP% 파일(서버 경로가 적힌 MCP 설정)을 서로 덮어쓰지 않게 한다.
function Get-SecretaryFileTag([string]$Root = $SecretaryRoot) {
  $id = Read-SecretaryId $Root
  if ($id) { return $id }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Root).TrimEnd('\').ToLowerInvariant())) } finally { $sha.Dispose() }
  -join ($bytes[0..3] | ForEach-Object { $_.ToString('x2') })
}

# 읽기 전용 기억 MCP 설정(.mcp.json과 같은 실행 명령에 --readonly)을 실행 때 임시 파일로 만들어 그 경로를 돌려준다.
# 작업 폴더가 비서 폴더가 아니므로 서버 파일은 이 저장소의 절대 경로로 적는다.
# -Writable: 기억 쓰기 도구까지 붙인 설정. 기억을 쓰는 담당자(run-job -Staff, 설정 memory가 write: 기억 정리)에만 쓴다(2026-11-05 결정).
# SECRETARY_DB가 정해져 있으면(시험용 DB 사본) 서버에도 그 값을 넘기고, 파일 이름도 따로 둔다.
function New-MemoryMcpConfig([switch]$Writable) {
  $server = (Resolve-Path (Join-Path $SecretaryRoot 'src\mcp\server.ts')).Path
  # if 식으로 배열을 받으면 원소 하나짜리가 문자열로 풀려 JSON의 args가 배열이 아니게 되므로 이렇게 쌓는다.
  [object[]]$serverArgs = @($server)
  if (-not $Writable) { $serverArgs += '--readonly' }
  $server = [ordered]@{ command = 'node'; args = $serverArgs }
  if ($env:SECRETARY_DB) { $server.env = [ordered]@{ SECRETARY_DB = [IO.Path]::GetFullPath($env:SECRETARY_DB) } }
  $config = [ordered]@{ mcpServers = [ordered]@{ secretary = $server } }
  $json = $config | ConvertTo-Json -Depth 5
  $file = Join-Path $env:TEMP "secretary-memory-$(if ($Writable) { 'write' } else { 'readonly' })-$(Get-SecretaryFileTag)$(if ($env:SECRETARY_DB) { '-db-' + (Get-SecretaryFileTag $env:SECRETARY_DB) }).mcp.json"
  # 다른 업무 세션이 읽는 중일 수 있으니, 내용이 같으면 다시 쓰지 않는다.
  if (-not (Test-Path $file) -or (Get-Content -Raw -Encoding UTF8 $file) -ne $json) {
    [IO.File]::WriteAllText($file, $json, [Text.UTF8Encoding]::new($false))
  }
  $file
}
