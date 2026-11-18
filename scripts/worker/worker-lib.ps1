# 업무 세션(백그라운드 claude --bg) 다루기를 한곳에 모은 공용 모듈. 진입점 스크립트 넷이 dot-source 해서 함수 하나를 부른다:
#   start-worker.ps1 → Start-Worker, send-worker.ps1 → Send-Worker, worker-logs.ps1 → Show-WorkerLogs, worker-done.ps1 → Complete-Worker
# 진입점을 파일별로 남긴 것은 권한 허용 목록이 스크립트 이름으로 구분하기 때문이다(예: 시작은 허용, 끄기는 따로). 이름·인자·출력은 진입점 파일 맨 위 주석 그대로.
# watch-worker.ps1(모니터링)도 여기의 Find-WorkerSession을 쓴다.
# 재사용 상태: 이 비서의 기록 폴더(~/.secretary/<비서 번호>/state, common.ps1 Get-SecretaryStateDir)의 worker-sessions.json
# (bg id → 공간·공급자·설정 폴더·업무 끝난 시각), 판단 기록: 같은 폴더의 worker-reuse.jsonl.

. "$PSScriptRoot\..\lib\common.ps1"
. "$PSScriptRoot\..\lib\providers.ps1"
. "$PSScriptRoot\..\lib\memory-mcp.ps1"

# 'bg:1234abcd'처럼 기록된 session_ref도 받는다.
function ConvertTo-WorkerId([string]$Id) { $Id -replace '^bg:', '' }

# 이 프로세스의 설정 폴더(CLAUDE_CONFIG_DIR, 없으면 ~/.claude) 목록(claude agents --json)에서 업무 세션 항목 하나를 찾는다.
# 목록을 읽고 id를 맞추는 일(짧은 id·uuid·bg: 접두·이름, 여럿 맞으면 어느 것)은 node src/cli.ts worker-agent
# (src/workspace/worker-status.ts findAgent) 한 곳에서 한다. 이 스크립트들은 목록을 직접 읽지 않는다.
# 없으면 $null. 목록을 못 읽으면 예외를 던진다(없다고 보고 상태 파일을 지우거나 하지 않게).
function Get-WorkerAgent([string]$Claude, [string]$Id) {
  if (-not $Id) { return $null }
  $r = Invoke-SecretaryCli @('worker-agent', $Id, '--claude', $Claude)
  if ($r.code -eq 2) { return $null }
  if ($r.code -ne 0 -or -not $r.out.Count) {
    # cli가 실패하면 "오류: <메시지> (<파일:줄>)" 한 줄을 낸다(src/core/cli-errors.ts, 예전 cli는 스택 사이의 "Error: …" 줄). 없으면 끝 세 줄.
    $why = @($r.err | Where-Object { $_ -match '^(오류|\w*Error): ' } | Select-Object -First 1)
    if (-not $why.Count) { $why = @($r.err | Select-Object -Last 3) }
    throw "업무 세션 목록(claude agents --json)을 못 읽었어요: $($why -join ' / ')"
  }
  ($r.out -join "`n") | ConvertFrom-Json
}

# 업무 세션은 공급자마다 다른 설정 폴더(CLAUDE_CONFIG_DIR, 예: 두 번째 구독)에서 돌아서, 기본 설정 폴더의
# claude agents/logs로는 보이지 않는다. id가 보이는 설정 폴더를 찾아 이 프로세스에 넣고 목록 항목을 돌려준다. 없으면 $null.
function Find-WorkerSession([string]$Claude, [string]$Id) {
  foreach ($dir in @(Get-AccountConfigDirs)) {
    # 기본 ~/.claude면 CLAUDE_CONFIG_DIR을 지운다(Use-ConfigDir, 아래 worker-done.ps1 부분).
    Use-ConfigDir $dir
    $hit = Get-WorkerAgent $Claude $Id
    if ($hit) { return $hit }
  }
  Remove-Item env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
  $null
}

# 업무 세션이 지금 떠 있는지: 이 프로세스의 설정 폴더(Find-WorkerSession이 넣음) 목록을 Get-WorkerAgent로 다시 읽어
# state('up' 떠 있음 | 'off' 꺼짐 | 'unknown' 모름)와 근거 글(detail)을 돌려준다. 깨우기(--bg --resume) 전에 본다.
# 목록 항목의 status(busy·idle·waiting 등)가 있으면 떠 있음. 백그라운드 서비스가 꺼진 세션은 status·pid 없이
# id·state(working·blocked 등 마지막 상태)만 나온다(Claude Code 2.1.326에서 확인). 목록을 못 읽었거나, 항목이 사라졌거나,
# status 없이 pid만 있으면 모름.
function Test-WorkerUp([string]$Claude, $Hit) {
  try { $now = Get-WorkerAgent $Claude "$($Hit.id)" }
  catch { return [pscustomobject]@{ state = 'unknown'; detail = "$_" } }
  if (-not $now) { return [pscustomobject]@{ state = 'unknown'; detail = '목록에서 그 세션이 사라졌어요' } }
  if ("$($now.status)") { return [pscustomobject]@{ state = 'up'; detail = "목록 status: $($now.status)" } }
  if ($null -ne $now.pid -and "$($now.pid)") { return [pscustomobject]@{ state = 'unknown'; detail = "목록에 status는 없고 pid $($now.pid)가 있어요" } }
  [pscustomobject]@{ state = 'off'; detail = "목록 status 없음, state: $($now.state)" }
}

# 업무 세션에 보낼 글을 원문 그대로(UTF-8) 그 세션의 메시지 파일(임시 폴더 secretary-worker-messages\<세션 id>\<시각>.md)에 쓰고 경로를 돌려준다.
# 글을 명령 인자로 넘기면 PowerShell 5.1이 큰따옴표·줄바꿈을 깨뜨리고, Haiku가 긴 글을 다시 치면서 바꿀 수 있어서, 업무 세션에는
# 이 파일을 읽으라는 한 줄(Get-WorkerMessagePointer)만 보낸다. 세션 id 폴더 아래라, 읽기를 막는 훅(worker-folder-guard.mjs --limit-reads)이
# 붙은 업무 세션도 자기 파일로 읽는다.
function Write-WorkerMessageFile($Hit, [string]$Message) {
  $sid = if ($Hit.sessionId) { "$($Hit.sessionId)" } else { "$($Hit.id)" }
  Write-WorkerMessageIn $sid $Message
}
# 메시지 파일들의 상위 폴더(임시 폴더 아래, 한 PC의 비서들이 같이 쓴다).
function Get-WorkerMessageRoot { Join-Path $env:TEMP 'secretary-worker-messages' }
# 그 상위 폴더 아래 $Sub 폴더에 글을 원문 그대로 쓰고 경로를 돌려준다. 쓰기 전에 30일 지난 것을 지운다(Remove-OldWorkerMessages).
function Write-WorkerMessageIn([string]$Sub, [string]$Message) {
  Remove-OldWorkerMessages
  $dir = Join-Path (Get-WorkerMessageRoot) $Sub
  New-Item -ItemType Directory -Force $dir | Out-Null
  $file = Join-Path $dir ('{0}-{1}.md' -f [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'), [guid]::NewGuid().ToString('N').Substring(0, 6))
  Write-Utf8File $file $Message
  $file
}
# 메시지 파일은 업무 세션이 한 번 읽으면 다시 쓰이지 않는데 계속 쌓이므로, 그 안의 가장 최근 파일(없으면 폴더 자체)이 $Days일 넘은
# 폴더(세션 id 폴더, start-worker -PromptFile의 지시 사본 폴더)와 그런 낱개 파일을 지운다. 지우지 못해도 메시지 보내기는 이어 간다.
function Remove-OldWorkerMessages([int]$Days = 30, [datetime]$Now = [datetime]::Now) {
  $root = Get-WorkerMessageRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
  $cut = $Now.AddDays(-$Days)
  foreach ($e in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue)) {
    try {
      $last = $e.LastWriteTime
      if ($e.PSIsContainer) {
        $newest = Get-ChildItem -LiteralPath $e.FullName -Recurse -Force -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newest -and $newest.LastWriteTime -gt $last) { $last = $newest.LastWriteTime }
      }
      if ($last -lt $cut) { Remove-Item -LiteralPath $e.FullName -Recurse -Force -ErrorAction Stop }
    } catch { [Console]::Error.WriteLine("지난 업무 메시지 파일을 못 지웠어요: $($e.FullName): $_") }
  }
}
function Get-WorkerMessagePointer([string]$File) { "비서 메시지: $File 파일을 Read 도구로 읽고, 그 글을 비서가 보낸 메시지로 받아 따르라." }

# 꺼진(백그라운드 서비스에서 내려간) 업무 세션을 그 공간 폴더($Cwd)에서 같은 세션으로 이어 깨우며 $Pointer(메시지 파일을 읽으라는 한 줄)를
# 첫 지시로 넣는다. 옵션 없이 부른다: 옵션을 붙이면 다른 id의 사본이 뜨고, 옵션 없이 이으면 처음 띄울 때의 옵션으로 같은 id에 이어진다.
# 돌려주는 것: ok(깨웠는지), id(출력의 backgrounded 뒤 id, 없으면 $null), out(출력 글).
function Invoke-WorkerWake([string]$Claude, [string]$Cwd, [string]$SessionId, [string]$Pointer) {
  # claude가 stderr에 "Starting background service…"를 쓰면 Stop 설정에서 예외가 되므로 이 함수 안에서만 Continue로 둔다.
  $ErrorActionPreference = 'Continue'
  Push-Location $Cwd
  try {
    $out = (& $Claude --bg --resume $SessionId $Pointer 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  $id = if ($out -match 'backgrounded\W+([0-9a-f]{6,})') { $Matches[1] } else { $null }
  [pscustomobject]@{ ok = ($code -eq 0 -and $out -match 'backgrounded'); id = $id; out = $out }
}

# Haiku의 답이 보냈다는 뜻인지: '보냄' 한 마디(끝의 마침표 정도는 허용)만. '못 보냄'·'보냄 실패'처럼 '보냄'이 든 다른 답은 아니다.
function Test-WorkerSent([string]$Out) { "$Out".Trim() -match '^보냄[.!。]?$' }

# 그 세션이 보이는 설정 폴더에서 업무 세션에 메시지를 넣는다. 다른 설정 폴더의 세션에는 비서의 SendMessage가 닿지 않아,
# 짧은 claude -p(Haiku, 도구는 ListAgents·SendMessage만)를 띄워 대신 보낸다. $Hit은 claude agents 목록 항목.
# 글은 메시지 파일에 쓰고(Write-WorkerMessageFile) 그 파일을 읽으라는 한 줄만 보낸다. sent(보냈는지, Test-WorkerSent), out(Haiku 답), file, pointer를 돌려준다.
function Send-WorkerMessage([string]$Claude, $Hit, [string]$Message) {
  $file = Write-WorkerMessageFile $Hit $Message
  $pointer = Get-WorkerMessagePointer $file
  $prompt = "ListAgents로 세션 목록을 보고, 이름이 정확히 $($Hit.name) 인 세션을 찾아라(ListAgents의 대괄호 id는 bg id $($Hit.id) 와 다르다). 그 세션에 SendMessage로 아래 <msg> 안의 한 줄을 글자 그대로 보내라. 보냈으면 '보냄'이라고만, 못 찾았으면 '못 찾음'이라고만 답하라. <msg>$pointer</msg>"
  # 받는 세션은 보낸 세션의 권한 모드 종류가 자기와 다르면 메시지를 붙잡아 두고 승인을 기다린다.
  # 다른 설정 폴더의 업무 세션은 구독이라 auto 모드로 도므로 같은 auto로 보낸다.
  # 보내는 쪽이 신뢰되지 않은 폴더에서 돌면 받는 세션이 메시지를 붙잡아 두므로, 업무 세션과 같은 공간 폴더에서 보낸다.
  Push-Location $Hit.cwd
  try { $out = (& $Claude -p --model haiku --strict-mcp-config --disable-slash-commands --no-session-persistence --tools ListAgents,SendMessage --allowedTools ListAgents,SendMessage --permission-mode auto $prompt) -join "`n" }
  finally { Pop-Location }
  [pscustomobject]@{ sent = (Test-WorkerSent $out); out = $out; file = $file; pointer = $pointer }
}

# 업무 세션의 대화 기록(jsonl)에서 $What(answer: 마지막 답 원문, context: 마지막 컨텍스트 크기, path: 파일 경로)을 읽는다.
# 모니터링이 보는 진행·마지막 도구는 아래 Get-WorkerStatus가 판정과 함께 준다. 이 스크립트들은 jsonl을 직접 읽지 않고 node src/cli.ts worker-transcript
# (src/workspace/worker-transcript.ts, 찾기·읽기는 src/core/transcript.ts)만 쓴다. 기록 찾기는 작업 상태 파일
# (<설정 폴더>\jobs\<짧은 id>\state.json)의 linkScanPath, 없으면 <설정 폴더>\projects 아래에서 세션 id로.
# 못 찾거나 읽지 못하면 $null, 읽으면 출력 줄 배열.
function Invoke-WorkerTranscript([string]$What, [string]$ConfigDir, [string]$Id, [string]$SessionId, [string]$Text) {
  if (-not $Id) { return $null }
  $cliArgs = @('worker-transcript', $What, $ConfigDir, $Id) + @($SessionId | Where-Object { $_ }) + $(if ($Text) { @('--text', $Text) } else { @() })
  $r = Invoke-SecretaryCli $cliArgs
  if ($r.code -ne 0 -or -not $r.out.Count) { return $null }
  , @($r.out)
}

# Haiku가 '보냄'이라고 답해도 실제로 닿았는지는 모른다. 그래서 업무 세션의 대화 기록(jsonl)에 메시지 파일 경로가 든 줄이 생겼는지
# $WorkerSendConfirmSeconds초 안에서 0.5초마다 본다(worker-transcript received). state: yes(들어감) | no(기록은 있는데 그 줄이 없음) | unknown(기록을 못 찾음).
# 지금 설정 폴더(Find-WorkerSession이 넣음)에서 찾는다.
$WorkerSendConfirmSeconds = 8
function Confirm-WorkerReceived($Hit, [string]$File) {
  $deadline = [DateTime]::UtcNow.AddSeconds($WorkerSendConfirmSeconds)
  $transcript = $null
  while ($true) {
    $r = Invoke-WorkerTranscript 'received' (Get-ClaudeConfigDir) "$($Hit.id)" "$($Hit.sessionId)" $File
    if (-not $r) { return [pscustomobject]@{ state = 'unknown'; transcript = $null } }
    $transcript = "$($r[1])"
    if ("$($r[0])" -eq '있음') { return [pscustomobject]@{ state = 'yes'; transcript = $transcript } }
    if ([DateTime]::UtcNow -ge $deadline) { return [pscustomobject]@{ state = 'no'; transcript = $transcript } }
    Start-Sleep -Milliseconds 500
  }
}

# 모니터링(watch-worker.ps1)의 판정: node src/cli.ts worker-status(src/workspace/worker-status.ts)가 목록(claude agents --json)·작업 상태 파일·
# 대화 기록, 그것들로 모를 때만 claude logs 화면 끝을 한 번에 읽어 JSON 한 줄로 준다. 판정 규칙(목록에 없음·승인 대기·쉼·일하는 중)은 거기 한 곳에 있다.
# $Claude: claude 실행 파일, $Prev: 지난번 결과의 signature(대화 기록이 바뀌었는지 progressed로 받는다).
# 명령이 실패하면 verdict 'error'와 오류 글(error)만 든 객체를 돌려준다.
# 설정 폴더는 이 프로세스의 것(Get-ClaudeConfigDir, Find-WorkerSession이 넣음)을 넘기고, node도 같은 CLAUDE_CONFIG_DIR을 물려받아 claude를 부른다.
function Get-WorkerStatus([string]$Claude, [string]$Id, [string]$Prev) {
  $cliArgs = @('worker-status', (Get-ClaudeConfigDir), $Id, '--claude', $Claude) + $(if ($Prev) { @('--prev', $Prev) } else { @() })
  $r = Invoke-SecretaryCli $cliArgs
  if ($r.code -ne 0 -or -not $r.out.Count) { return [pscustomobject]@{ verdict = 'error'; error = (($r.err | Select-Object -Last 3) -join ' / ') } }
  try { ($r.out -join "`n") | ConvertFrom-Json } catch { [pscustomobject]@{ verdict = 'error'; error = "$_" } }
}

# 세션의 마지막 컨텍스트 크기: 대화 기록 끝 4MB에서 마지막 모델 호출의 usage input + cache_read + cache_creation.
# 계산은 비서 프롬프트 훅과 같은 코드(src/core/transcript.ts lastContextTokens). 기록을 못 찾으면 $null.
function Get-SessionContext([string]$ConfigDir, [string]$SessionId) {
  if (-not $SessionId) { return $null }
  $out = Invoke-WorkerTranscript 'context' $ConfigDir $SessionId $SessionId
  if ($out -and "$($out[0])".Trim() -match '^\d+$') { [int]"$($out[0])".Trim() } else { $null }
}

function Get-WorkerStateFile { Join-Path (Get-SecretaryStateDir) 'worker-sessions.json' }
# 판단에 쓰는 지금 상태(읽기만). 고칠 때는 이것을 통째로 쓰지 않고 Update-WorkerState로 바꿀 항목만 넘긴다.
function Read-WorkerState { Read-JsonStateFile (Get-WorkerStateFile) }
# 상태 파일을 잠근 채 다시 읽어 $Remove의 id를 지우고 $Set(id → 항목)을 넣거나 바꿔 쓴다(common.ps1 Update-JsonStateFile).
# 시작 때 읽은 상태를 통째로 쓰면, 그사이 다른 업무 세션 스크립트(동시에 띄운 start-worker, 뒤에서 기다리던 worker-done -StopAfter)가 적은 항목이 지워진다.
function Update-WorkerState([string[]]$Remove = @(), [hashtable]$Set = @{}) {
  New-Item -ItemType Directory -Force (Get-SecretaryStateDir) | Out-Null
  $null = Update-JsonStateFile (Get-WorkerStateFile) {
    param($s)
    foreach ($r in $Remove) { if ($r) { $s.PSObject.Properties.Remove($r) } }
    foreach ($k in $Set.Keys) { $s | Add-Member -NotePropertyName $k -NotePropertyValue $Set[$k] -Force }
  }
}
# 상태 파일의 model 값: 공간이 모델을 정하지 않았으면 $null(JSON null). 값 없는 if 식을 그대로 저장하면
# PowerShell 5.1이 {}로 써서, 다시 읽은 {}가 늘 "설정 다름"이 되어 재사용이 안 됐다. 그때 저장된 {}도 $null로 읽는다.
function ConvertTo-WorkerModel($Value) {
  if ($Value -is [string] -and $Value) { return $Value }
  return $null
}
# 쉬는 업무 세션($Prev, 상태 파일 항목)의 설정이 이번 업무와 다르면 $true. effort는 없을 때 null·빈 글을 같은 것으로 본다.
function Test-WorkerSettingsDiffer($Prev, $Model, [string]$Effort, [bool]$Chrome, [bool]$LockTests) {
  (ConvertTo-WorkerModel $Prev.model) -ne (ConvertTo-WorkerModel $Model) -or "$($Prev.effort)" -ne $Effort -or
    [bool]$Prev.chrome -ne $Chrome -or [bool]$Prev.lock_tests -ne $LockTests
}
# 쉬는 세션을 한 start-worker가 맡았다는 표시(claimed_by = "<pid>@<시각>"): 맡은 쪽이 재사용하거나 끄는 동안 다른 start-worker는
# 고르지 않고 worker-done -StopAfter는 끄지 않는다. 맡은 쪽이 도중에 죽으면 $WorkerClaimStaleMinutes분 뒤부터 표시를 없는 것으로 본다.
$WorkerClaimStaleMinutes = 30
function Test-WorkerClaimed($Entry, [DateTime]$Now) {
  if (-not $Entry.claimed_by) { return $false }
  $at = [DateTime]::MinValue
  if (-not [DateTime]::TryParse(("$($Entry.claimed_by)" -split '@', 2)[-1], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$at)) { return $false }
  return ($Now - $at.ToUniversalTime()).TotalMinutes -lt $WorkerClaimStaleMinutes
}
# 이 실행($Claim)이 맡았다고 표시한 항목에서 표시를 지운다(재사용한 세션과 손대지 않고 남긴 쉬는 세션).
function Clear-WorkerClaim([string]$Claim) {
  $null = Update-JsonStateFile (Get-WorkerStateFile) {
    param($s)
    foreach ($cl in @($s.PSObject.Properties | ForEach-Object { $_.Value })) {
      if ($cl -and "$($cl.claimed_by)" -eq $Claim) { $cl.PSObject.Properties.Remove('claimed_by') }
    }
  }
}
function Add-WorkerReuseLog($Entry) {
  try {
    Add-Utf8Line (Join-Path (Get-SecretaryStateDir) 'worker-reuse.jsonl') ($Entry | ConvertTo-Json -Compress)
  } catch { [Console]::Error.WriteLine("업무 세션 재사용 기록을 못 남겼어요: $_") }
}

# ---- start-worker.ps1 ------------------------------------------------------------------------

function Start-Worker([string]$Folder, [string]$Name, [string]$Prompt, [string]$PromptFile, [string]$Provider, [string]$Effort, [switch]$Chrome, [switch]$LockTests, [switch]$New, [switch]$DryRun) {
  if ([bool]$Prompt -eq [bool]$PromptFile) { throw '-Prompt나 -PromptFile 가운데 하나만 줘요.' }
  if ($PromptFile) {
    if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) { throw "지시 파일이 없어요: $PromptFile" }
    $Prompt = Get-Content -Raw -Encoding UTF8 -LiteralPath $PromptFile
    if (-not "$Prompt".Trim()) { throw "지시 파일이 비어 있어요: $PromptFile" }
  }
  $claude = Initialize-ClaudeScript
  if (-not (Test-Path $Folder -PathType Container)) { throw "공간 폴더가 없어요: $Folder" }
  $info = Use-Provider $Provider
  if ($info.Type -notlike 'claude-*') { throw "'$($info.Name)'($($info.Type))는 Claude Code가 아니라 업무 세션에 못 써요. 결과만 받는 일은 run-job.ps1 -Provider $($info.Name)로 돌려요." }
  if ($info.Type -eq 'claude-subscription' -and -not (Test-ClaudeLogin $claude)) { throw 'Claude Code 터미널 버전에 로그인돼 있지 않아요. 이 PC에서 "claude auth login"을 먼저 실행해야 해요.' }
  # 개인정보를 보내지 않는 공급자면 지시와 거기 적힌 TASK.md에 호칭·기억 번호·다른 공간 이름이 있는지 보고, 있으면 멈춘다(providers.ps1).
  Assert-PrivateFreeBrief $info $Folder $PromptFile $Prompt
  Write-Output "공급자: $($info.Name)"

  # -Prompt(짧은 한 줄): Windows PowerShell 5.1은 큰따옴표가 든 인자를 네이티브 프로그램에 깨뜨려 넘기므로 작은따옴표로 바꾸고 줄바꿈을 공백으로 편다.
  # -PromptFile: 글을 원문 그대로 메시지 파일에 옮겨 두고(새 세션은 세션 id를 아직 몰라 start-<이름> 폴더에) 인자로는 그 파일을 읽으라는 한 줄만 넘긴다.
  # 쉬는 세션을 재사용하면 send-worker처럼 그 세션의 메시지 파일로 원문이 간다(아래 Send-WorkerMessage, Invoke-WorkerCompactReuse).
  $startMessage = $null
  if ($PromptFile) {
    $startMessage = Write-WorkerMessageIn ('start-{0}-{1}' -f ($Name -replace '[^\w.-]', '_'), [guid]::NewGuid().ToString('N').Substring(0, 6)) $Prompt
    $taskPrompt = Get-WorkerMessagePointer $startMessage
  } else { $taskPrompt = ($Prompt -replace '"', "'") -replace '\r?\n', ' ' }
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
  # 개인정보를 보내도 되는 공급자(providers.json의 personalDataAllowed)면 비서 기억 읽기 도구(recall·search_log, --readonly 기억 MCP)를 붙인다.
  # 아니면(게이트웨이·무료 플랜 등) 개인 기억이 믿기 어려운 곳으로 나가므로 붙이지 않는다(memory-mcp.ps1 Test-MemoryMcp).
  # --mcp-config·--allowedTools는 값을 여럿 받으므로 지시(맨 끝 인자)보다 앞, --settings 앞에 둔다.
  $mcpArg = if (Test-MemoryMcp $info) { @('--mcp-config', (New-MemoryMcpConfig), '--allowedTools', ($MemoryReadTools -join ',')) } else { @() }
  if ($DryRun) { "MCP 인자: $($mcpArg -join ' ')"; exit 0 }

  # 재사용 판단: 같은 공간·공급자의 쉬는 업무 세션(worker-done.ps1이 업무 끝난 시각을 적은 것) 중 가장 최근 것을 본다.
  # 캐시가 살아 있을 때 재사용(resume)하면 새 세션의 시작 비용(1~2.5만 토큰)을 아낀다(run-job 자동 재사용과 같은 기준, common.ps1).
  # 판단부터 상태 쓰기까지 다른 스크립트가 같은 세션을 건드리지 않게, 상태 파일을 잠근 채 다시 읽어 이 공간·공급자의 쉬는 세션을
  # 이 실행 몫으로 표시한다(claimed_by, Test-WorkerClaimed). 그사이 worker-done -StopAfter가 고른 세션을 끄거나 다른 start-worker가
  # 같은 세션에 업무를 보내던 틈을 막는다. 판단에 드는 오래 걸리는 일(목록 읽기, 컨텍스트, 메시지 보내기·확인, compact)은 잠금을
  # 쥔 채 하지 않는다: 다른 스크립트는 잠금을 30초까지만 기다리고(common.ps1 Invoke-WithFileLock), compact는 몇 분 걸린다.
  # 표시한 세션은 이 실행이 재사용하거나 끄고(아래 $idle 끄기), 재사용했으면 남은 것의 표시를 푼다(Clear-WorkerClaim).
  $config = Get-ClaudeConfigDir
  $now = [DateTime]::UtcNow
  $claim = "$PID@$($now.ToString('o'))"
  $idle = @(Update-JsonStateFile (Get-WorkerStateFile) {
      param($s)
      $mine = @($s.PSObject.Properties | ForEach-Object { $_.Value } |
        Where-Object { $_.folder -eq $folderFull -and $_.provider -eq $info.Name -and $_.done_at -and -not (Test-WorkerClaimed $_ $now) })
      foreach ($cl in $mine) { $cl | Add-Member -NotePropertyName claimed_by -NotePropertyValue $claim -Force }
      , $mine
    } | ForEach-Object { $_ } | Where-Object { $_ } | Sort-Object { [DateTime]::Parse($_.done_at) } -Descending)
  $prev = $idle | Select-Object -First 1
  $log = [ordered]@{ at = $now.ToString('o'); folder = $folderFull; provider = $info.Name; name = $Name; id = $null
    reused = $false; new_reason = $null; minutes_since_done = $null; context = $null }
  if ($prev) {
    $log.minutes_since_done = [math]::Round(($now - [DateTime]::Parse($prev.done_at).ToUniversalTime()).TotalMinutes, 1)
    $alive = Get-WorkerAgent $claude $prev.id
    if ($alive) { $log.context = Get-SessionContext $config $alive.sessionId }
    if ($New) { $log.new_reason = '-New' }
    elseif (-not $alive) { $log.new_reason = '세션 없음' }
    elseif ($log.minutes_since_done -ge $SessionReuseMinutes) { $log.new_reason = "$($SessionReuseMinutes)분 초과" }
    elseif ($null -eq $log.context) { $log.new_reason = '컨텍스트 모름' }
    elseif ($log.context -ge $SessionReuseMaxContext) { $log.new_reason = '컨텍스트 초과' }
    elseif (Test-WorkerSettingsDiffer $prev $model $Effort $Chrome $LockTests) { $log.new_reason = '설정 다름' }
    else {
      $n = [int]$prev.tasks + 1
      $msg = "새 업무 #$($n): 앞 업무는 끝났다. 아래 지시만 따르라(앞 업무의 파일·결정은 이번 지시서에 있는 것만 쓰고, 보고서는 이번 업무 폴더에 따로 쓴다). 지시: $Prompt"
      $sent = Send-WorkerMessage $claude $alive $msg
      if ($sent.sent) {
        $prev.done_at = $null; $prev.tasks = $n; $prev.task_name = $Name
        $prev.PSObject.Properties.Remove('claimed_by')
        Update-WorkerState -Set @{ "$($prev.id)" = $prev }
        Clear-WorkerClaim $claim
        $log.id = $prev.id; $log.reused = $true
        Add-WorkerReuseLog $log
        Write-Output "재사용: $($prev.id) · $($prev.name) (새 업무 #$n, 업무 끝난 지 $($log.minutes_since_done)분, 컨텍스트 $($log.context) 토큰)"
        exit 0
      }
      $log.new_reason = '보내기 실패'
      [Console]::Error.WriteLine("쉬는 업무 세션 $($prev.id)에 새 업무를 못 보냈어요: $($sent.out)")
    }
  } else { $log.new_reason = if ($New) { '-New' } else { '쉬는 세션 없음' } }
  # 재사용하지 않은 쉬는 세션은 끈다(공간마다 한 명). 일하는 중인 세션(업무 끝난 시각 없음)은 건드리지 않는다.
  $stopped = @()
  foreach ($old in $idle) {
    try { & $claude stop $old.id *> $null } catch {}
    $stopped += "$($old.id)"
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
  $workerExtra = @{ worktree = [pscustomobject]@{ bgIsolation = 'none' } }
  # 자동 판단(auto) 모드는 구독에서만 동작한다. 다른 공급자에서는 평범한 명령에도 승인 창이 떠서, 아무도 없는
  # 백그라운드 세션이 멈춘다. 그래서 허용 목록(worker-permissions.json)에 있는 것만 하고 나머지는 묻지 않고 거절하는
  # dontAsk 모드로 돌린다. 거절되면 업무 세션이 다른 방법을 찾거나 [질문]으로 묻는다.
  $usePermissions = $info.Type -ne 'claude-subscription'
  $permArg = if (-not $usePermissions) { @('--permission-mode', 'auto') } else {
    # 웹 검색 도구는 Anthropic 서버 기능이라 다른 공급자에는 없다. Bing 결과 페이지는 WebFetch로 읽힌다(구글·네이버·DuckDuckGo는 막힘).
    $safePrompt += ' (웹 검색 도구가 없으니, 검색이 필요하면 WebFetch로 https://www.bing.com/search?q=<검색어> 를 가져와 결과를 보라.)'
    # 허용 목록에 공간 폴더 전체 경로(//c/Users/...)의 Edit 규칙을 덧붙인다(common.ps1 New-ClaudeRunSettings -EditFolder).
    @('--permission-mode', 'dontAsk')
  }
  # 공간 밖 쓰기, git push, 게시·업로드, 큰 삭제(-LockTests면 테스트 파일 수정도), 비서 폴더를 건드리는 셸 명령(bin\ 진입점 부르기만 된다)을
  # 훅으로 막는다. 개인정보를 보내지 않는 공급자면 공간 폴더·공통 스킬 폴더 밖 읽기도 막는다(providers.ps1 Get-FolderGuardHook).
  # -PromptFile의 지시 사본 폴더는 읽기 제한이 붙은 세션도 읽게 한다(세션 id를 띄운 뒤에야 알아 자기 파일로 가려지지 않는다).
  $guardHook = Get-FolderGuardHook $info $folderFull -LockTests:$LockTests -ReadRoot @($(if ($startMessage) { Split-Path -Parent $startMessage }))
  # 같은 종류 조작이 한 턴에 여러 번(기준 this-secretary.local.json의 mistake-guards 키의 repeatLimit) 되풀이되면 막지 않고 도구·스크립트로 바꿀지 따져 보라고 알린다(src/mistake-guards/repeat-hook.ts, PostToolUse).
  # 계정에 붙인 claude.ai 커넥터(예: Google Calendar)는 업무에 쓰지 않으므로 업무 세션에는 붙이지 않는다.
  # 업무 세션은 이미 떠 있는 백그라운드 서비스의 환경을 물려받으므로, 공간 도구가 비서 진입점 폴더(bin\)를 찾는 비서 폴더 환경변수
  # (이 비서 번호의 SECRETARY_<번호>_DIR)도 여기서 넘긴다(common.ps1 Get-SecretaryDirVars).
  $workerEnv = [pscustomobject]@{ ENABLE_CLAUDEAI_MCP_SERVERS = 'false' }
  foreach ($v in (Get-SecretaryDirVars).GetEnumerator()) { $workerEnv | Add-Member -NotePropertyName $v.Key -NotePropertyValue $v.Value -Force }
  $workerExtra.env = $workerEnv
  $workerSettings = New-ClaudeRunSettings -Permissions:$usePermissions -EditFolder $folderFull -GuardHook $guardHook -RepeatHooks @(Get-RepeatHook) -Extra $workerExtra
  $settingsFile = Join-Path $env:TEMP "worker-settings-$Name.json"
  Write-Utf8File $settingsFile ($workerSettings | ConvertTo-Json -Depth 8)
  # id를 읽으려고 출력을 받아 둔다. PowerShell 5.1은 Stop일 때 네이티브 프로그램의 오류 출력을 예외로 바꾸므로 잠시 Continue로 둔다.
  $ErrorActionPreference = 'Continue'
  $out = @(& $claude --bg --name $Name @modelArg @effortArg @permArg @mcpArg --settings $settingsFile $safePrompt 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $out
  # 새 세션을 상태 파일에 적어 두면, 업무가 끝난 뒤(worker-done.ps1) 같은 공간의 다음 업무가 재사용할 수 있다.
  $add = @{}
  if (($out -join "`n") -match 'backgrounded\W+([0-9a-f]{6,})') {
    $id = $Matches[1]
    $add[$id] = [pscustomobject]@{ id = $id; name = $Name; task_name = $Name; folder = $folderFull; provider = $info.Name; config_dir = $config
      model = $model; effort = $Effort; chrome = [bool]$Chrome; lock_tests = [bool]$LockTests; started_at = $now.ToString('o'); done_at = $null; tasks = 1 }
    $log.id = $id
  }
  # 끈 쉬는 세션은 지우고 새 세션은 더한다(잠근 채 다시 읽어 바꾸므로 그사이 다른 공간의 start-worker가 적은 항목은 남는다).
  try { Update-WorkerState -Remove $stopped -Set $add } catch { [Console]::Error.WriteLine("업무 세션 상태를 못 남겼어요: $_") }
  Add-WorkerReuseLog $log
  exit $code
}

# ---- send-worker.ps1 -------------------------------------------------------------------------

# 업무 세션이 도는 공급자: start-worker가 상태 파일(worker-sessions.json)에 적은 provider와 providers.json의 personalDataAllowed.
# 상태 파일에 없거나(꺼져 지워짐, 다른 길로 띄움) 공급자 설정이 없으면 개인정보를 보내지 않는 공급자로 본다(안전한 쪽).
function Get-WorkerProviderInfo([string]$Id, $Hit) {
  $state = Read-WorkerState
  $entry = $null
  foreach ($k in @($Id, "$($Hit.id)") | Where-Object { $_ }) { if ($state.PSObject.Properties[$k]) { $entry = $state.PSObject.Properties[$k].Value; break } }
  $name = "$($entry.provider)"
  $p = $null
  if ($name) { try { $p = (Get-ProviderConfig).providers.$name } catch {} }
  [pscustomobject]@{ Name = $(if ($name) { $name } else { '(모름)' }); PersonalDataAllowed = [bool](Test-PersonalDataAllowed $p) }
}

# 메시지가 들어간 업무 세션의 업무 가운데 질문 대기(asking)인 것을 진행 중(running)으로 되돌리고 바꿨다는 줄을 낸다
# (node src/cli.ts worker-asking <id> --answered, src/workspace/worker-asking.ts markAnswered). 예전에는 비서가 답을 보낼 때마다
# update_task로 직접 되돌려야 해서, 잊으면 업무가 질문 대기로 남아 모니터링을 다시 띄울 대상에서 빠졌다. 실패해도 보내기는 성공으로 둔다.
function Set-WorkerAnswered([string]$Id) {
  $r = Invoke-SecretaryCli @('worker-asking', $Id, '--answered')
  if ($r.code -eq 0) { @($r.out) | Where-Object { "$_".Trim() } }
  else { "업무 상태를 진행 중으로 되돌리지 못했어요(update_task로 직접 바꿔요): $((@($r.err) | Select-Object -Last 1))" }
}

function Send-Worker([string]$Id, [string]$Message, [string]$MessageFile) {
  if ([bool]$Message -eq [bool]$MessageFile) { throw '-Message나 -MessageFile 가운데 하나만 줘요.' }
  if ($MessageFile) {
    if (-not (Test-Path -LiteralPath $MessageFile -PathType Leaf)) { throw "메시지 파일이 없어요: $MessageFile" }
    $Message = Get-Content -Raw -Encoding UTF8 -LiteralPath $MessageFile
  }
  $claude = Initialize-ClaudeScript
  $Id = ConvertTo-WorkerId $Id
  $hit = Find-WorkerSession $claude $Id
  if (-not $hit) { throw "업무 세션 $Id 이(가) 어느 계정의 목록에도 없어요." }
  # 개인정보를 보내지 않는 공급자의 세션이면 보낼 글(깨울 때 넣는 글도 같은 메시지 파일)에 호칭·기억 번호·다른 공간 이름이 있는지 보고, 있으면 보내지 않는다.
  Assert-PrivateFreeBrief (Get-WorkerProviderInfo $Id $hit) $hit.cwd $MessageFile $Message

  $sent = Send-WorkerMessage $claude $hit $Message
  $out = $sent.out
  if ($sent.sent) {
    # Haiku 답만 믿지 않고 업무 세션 대화 기록에 그 줄이 들어갔는지 본다(Confirm-WorkerReceived).
    $got = Confirm-WorkerReceived $hit $sent.file
    if ($got.state -eq 'yes') { '보냄'; "메시지 파일: $($sent.file)"; Set-WorkerAnswered $Id; exit 0 }
    # 기록을 못 찾으면 들어갔는지 알 길이 없다. 다시 보내면 같은 지시가 두 번 갈 수 있어 보낸 것으로 두고 확인 못 함을 알린다.
    if ($got.state -eq 'unknown') { '보냄'; "메시지 파일: $($sent.file)"; '확인 못 함: 업무 세션의 대화 기록을 못 찾아 메시지가 들어갔는지 보지 못했어요. 모니터링·worker-logs.ps1로 업무 세션이 받았는지 봐요.'; Set-WorkerAnswered $Id; exit 0 }
    "보냄 확인 안 됨: Haiku는 보냈다고 했지만 $($WorkerSendConfirmSeconds)초 안에 업무 세션 대화 기록($($got.transcript))에 메시지 줄이 보이지 않아요. 늦게 들어갈 수도 있으니 다시 보내기 전에 worker-logs.ps1로 받았는지 봐요."
    "메시지 파일: $($sent.file)"
    exit 1
  }

  # 메시지가 닿지 않은 까닭은 둘이다: 백그라운드 서비스가 꺼져 세션이 떠 있지 않거나, 세션은 떠 있는데 Haiku가 못 보냈다
  # (이름을 못 찾음, 답을 다르게 씀). 떠 있는 세션을 --bg --resume으로 부르면 다른 id의 사본이 뜨므로, 깨우기 전에
  # 목록을 다시 읽어(Test-WorkerUp) 꺼졌다고 확인될 때만 깨운다. 떠 있거나 확인하지 못하면 깨우지 않고 못 보냄으로 끝낸다(사본 방지 우선).
  $up = Test-WorkerUp $claude $hit
  if ($up.state -eq 'up') { "못 보냄: 세션이 떠 있는데 메시지가 닿지 않음($($up.detail)). 깨우면 사본이 생겨 깨우지 않았어요. Haiku 답: $out"; exit 1 }
  if ($up.state -ne 'off') { "못 보냄: 세션이 떠 있는지 확인하지 못해 깨우지 않음($($up.detail)). Haiku 답: $out"; exit 1 }

  # 꺼진 세션: 같은 세션을 옵션 없이 이어 깨우면서 메시지 파일을 읽으라는 한 줄을 첫 지시로 넣는다(옵션을 붙이면 사본이 생긴다).
  # Find-WorkerSession이 그 세션의 설정 폴더(CLAUDE_CONFIG_DIR)를 이미 넣어 두었다.
  $wake = Invoke-WorkerWake $claude $hit.cwd $hit.sessionId $sent.pointer
  if ($wake.ok) { '깨워서 보냄'; "메시지 파일: $($sent.file)"; Set-WorkerAnswered $Id; exit 0 }
  "못 보냄: $out / 깨우기 출력: $($wake.out)"
  exit 1
}

# ---- worker-logs.ps1 -------------------------------------------------------------------------

# 기본은 업무 세션의 마지막 답 원문(대화 기록 jsonl에서 그 답의 글 전체)을 보여 준다. claude logs 화면 출력은 화면을 다시 그릴 때마다
# 통째로 쌓이고 화면보다 긴 답은 앞이 남지 않아서다. -Screen이면 예전처럼 claude logs 화면 출력을 보여 준다.
# 기록을 못 찾거나 읽지 못하면 그렇다고 한 줄 알리고 화면 출력으로 돌아간다. 목록에서 빠진(꺼진) 세션도 기록이 남아 있으면
# 계정마다의 설정 폴더에서 찾아 보여 준다.
function Show-WorkerLogs([string]$Id, [switch]$Screen) {
  $claude = Initialize-ClaudeScript
  $Id = ConvertTo-WorkerId $Id
  $hit = Find-WorkerSession $claude $Id
  if (-not $Screen) {
    $configs = if ($hit) { @(Get-ClaudeConfigDir) } else { @(Get-AccountConfigDirs) }
    foreach ($config in $configs) {
      $answer = Invoke-WorkerTranscript 'answer' $config $Id "$($hit.sessionId)"
      if ($answer) { $answer; exit 0 }
    }
    Write-Output "대화 기록(jsonl)에서 업무 세션 $Id 의 마지막 답을 못 읽어서, claude logs 화면 출력을 대신 보여 드려요(화면보다 긴 답은 앞이 잘려요)."
    if (-not $hit) { Write-Output "업무 세션 $Id 이(가) 어느 계정의 목록에도 없어요."; exit 1 }
  }
  & $claude logs $Id
  exit $LASTEXITCODE
}

# ---- worker-done.ps1 -------------------------------------------------------------------------

function Use-ConfigDir([string]$Dir) {
  if ($Dir -and $Dir.TrimEnd('\') -ne (Join-Path $env:USERPROFILE '.claude')) { $env:CLAUDE_CONFIG_DIR = $Dir }
  else { Remove-Item env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
}

# -IdleMinutes를 안 주면 재사용 기준($SessionReuseMinutes)을 쓴다.
function Complete-Worker([string]$Id, [switch]$Stop, [string]$StopAfter, [int]$IdleMinutes = $SessionReuseMinutes) {
  $claude = Initialize-ClaudeScript
  $Id = ConvertTo-WorkerId $Id
  $stopWorker = { param($WorkerId) try { & $claude stop $WorkerId *> $null } catch {} }

  $state = Read-WorkerState
  $entry = $state.PSObject.Properties[$Id].Value

  # 뒤에서 띄운 끄기 대기: 정해진 시간 뒤 업무 끝난 시각이 그대로면(재사용되지 않았으면) 끈다.
  if ($StopAfter) {
    Start-Sleep -Seconds ($IdleMinutes * 60)
    # 잠근 채 다시 읽어, 업무 끝난 시각이 그대로일 때만 지운다(그사이 재사용된 세션은 start-worker가 done_at을 비웠다).
    # start-worker가 맡았다고 표시한 세션(claimed_by)은 그쪽이 재사용하거나 끄므로 건드리지 않는다.
    $entry = Update-JsonStateFile (Get-WorkerStateFile) {
      param($s)
      $e = $s.PSObject.Properties[$Id].Value
      if ($e -and "$($e.done_at)" -eq $StopAfter -and -not (Test-WorkerClaimed $e ([DateTime]::UtcNow))) { $s.PSObject.Properties.Remove($Id); $e }
    }
    if (-not $entry) { exit 0 }
    Use-ConfigDir $entry.config_dir
    & $stopWorker $Id
    Add-WorkerReuseLog ([ordered]@{ at = [DateTime]::UtcNow.ToString('o'); event = 'idle_stop'; folder = $entry.folder; provider = $entry.provider; name = $entry.name; id = $Id; tasks = $entry.tasks })
    exit 0
  }

  if (-not $entry -or $Stop) {
    if ($entry) { Use-ConfigDir $entry.config_dir } elseif (-not (Find-WorkerSession $claude $Id)) { Write-Output "업무 세션 $Id 이(가) 어느 계정의 목록에도 없어요(이미 꺼짐)."; exit 0 }
    & $stopWorker $Id
    if ($entry) { Update-WorkerState -Remove @($Id) }
    Write-Output "껐어요: $Id$(if (-not $Stop) { ' (상태 파일에 없는 세션이라 바로 껐어요)' })"
    exit 0
  }

  Use-ConfigDir $entry.config_dir
  $alive = Get-WorkerAgent $claude $Id
  if (-not $alive) {
    Update-WorkerState -Remove @($Id)
    Write-Output "업무 세션 $Id 이(가) 이미 목록에 없어요. 상태 파일에서 지웠어요."
    exit 0
  }
  $now = [DateTime]::UtcNow
  $doneAt = $now.ToString('o')
  $context = Get-SessionContext (Get-ClaudeConfigDir) $alive.sessionId
  # 재사용할 수 없는 세션(컨텍스트가 기준 이상이거나 기록을 못 찾음)은 기다리지 않고 바로 끈다.
  if ($null -eq $context -or $context -ge $SessionReuseMaxContext) {
    & $stopWorker $Id
    Update-WorkerState -Remove @($Id)
    Add-WorkerReuseLog ([ordered]@{ at = $doneAt; event = 'done_stop'; folder = $entry.folder; provider = $entry.provider; name = $entry.name; id = $Id; tasks = $entry.tasks; context = $context })
    Write-Output "껐어요: $Id (컨텍스트 $(if ($null -eq $context) { '모름' } else { "$context 토큰" })이라 재사용하지 않아요)."
    exit 0
  }
  $entry.done_at = $doneAt
  $entry | Add-Member -NotePropertyName context -NotePropertyValue $context -Force
  Update-WorkerState -Set @{ $Id = $entry }

  # 이 스크립트를 부른 쪽(비서의 명령)이 끝나면 자식 프로세스도 정리되므로, WMI로 부모와 상관없는 프로세스를 만든다.
  # conhost --headless로 띄워야 창이 잠깐 떴다 사라지지 않는다.
  $self = Join-Path $PSScriptRoot 'worker-done.ps1'
  $cmd = "conhost.exe --headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -Id $Id -StopAfter $doneAt -IdleMinutes $IdleMinutes"
  $null = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  $stopAt = ConvertTo-KstText $now.AddMinutes($IdleMinutes) 'HH:mm'
  Write-Output "업무 끝 표시: $Id (컨텍스트 $context 토큰). $($IdleMinutes)분 안에 같은 공간의 다음 업무가 오면 재사용하고, 아니면 $stopAt(KST)에 꺼져요."
}
