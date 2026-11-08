# 오래 걸릴 수 있는 run-job을 비서의 백그라운드 명령과 떼어 돌리는 공용 함수. run-job.ps1의 -Detach가 dot-source 한다.
# 왜: 비서가 백그라운드 명령으로 기다리면 시간제한(1시간 이하)에 닿을 때 그 명령과 아래 프로세스가 함께 꺼진다(2026-11-05 확인).
# 대화 캐시가 1시간이라 시간제한을 더 늘리지 않고, 일은 따로 띄운 뒤 scripts/run-job/wait-job.ps1로 55분($CacheWakeMinutes)씩 나눠 기다린다.
# 띄운 일의 기록은 이 비서의 기록 폴더(~/.secretary/state/<비서 번호>, common.ps1 Get-SecretaryStateDir)의 bg-jobs/<id>/:
# job.json(id, pid, script, label, started_at), out.txt(출력), err.txt(오류 출력),
# exit.txt(끝나면 종료 코드). 띄우는 명령이 바로 끝나므로 띄운 프로세스는 그 명령의 시간제한에 걸리지 않는다.

. "$PSScriptRoot\common.ps1"
function Get-BgJobRoot { Join-Path (Get-SecretaryStateDir) 'bg-jobs' }
# 그 일의 기록 폴더. 비서 번호 폴더로 옮기기 전에 띄운 일(옛 자리 ~/.claude/usage/bg-jobs/<id>)도 끝까지 기다릴 수 있게, 새 자리에 없고
# 옛 자리에 있으면 옛 자리를 준다(둘 다 없으면 새 자리).
function Get-BgJobDir([string]$Id) {
  $dir = Join-Path (Get-BgJobRoot) $Id
  $old = Join-Path (Join-Path (Get-UsageDir) 'bg-jobs') $Id
  if (-not (Test-Path -LiteralPath $dir) -and (Test-Path -LiteralPath $old)) { return $old }
  $dir
}

# PowerShell 작은따옴표 글(' 와 둥근 작은따옴표는 두 번 써서 감싼다).
function ConvertTo-PsLiteral([string]$Text) { "'" + ($Text -replace "['‘’‚‛]", '$0$0') + "'" }

# 스크립트를 받은 인자 그대로(-Detach만 빼고) 따로 띄우고, 기다리는 법을 출력한다.
# 인자는 인코딩한 명령(-EncodedCommand)에 넣어 따옴표·공백·한글이 깨지지 않게 하고, 긴 지시(-Prompt)는 파일로 넘긴다.
# 작업 폴더는 지금 위치 그대로라 상대 경로 인자도 같은 곳을 가리킨다.
function Start-DetachedSelf([string]$ScriptPath, $BoundParams, [string]$Label) {
  $id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (Get-Random -Maximum 9999)
  $dir = Join-Path (Get-BgJobRoot) $id
  New-Item -ItemType Directory -Force $dir | Out-Null
  $set = foreach ($k in @($BoundParams.Keys)) {
    if ($k -eq 'Detach') { continue }
    $v = $BoundParams[$k]
    if ($k -eq 'Prompt') {
      $pf = Join-Path $dir 'prompt.txt'
      [IO.File]::WriteAllText($pf, [string]$v, (New-Object Text.UTF8Encoding $false))
      "`$p['PromptFile'] = $(ConvertTo-PsLiteral $pf)"; continue
    }
    if ($v -is [Management.Automation.SwitchParameter] -or $v -is [bool]) { "`$p['$k'] = `$$([bool]$v)" }
    elseif ($v -is [array]) { "`$p['$k'] = @($((@($v) | ForEach-Object { ConvertTo-PsLiteral "$_" }) -join ', '))" }
    else { "`$p['$k'] = $(ConvertTo-PsLiteral "$v")" }
  }
  $exitFile = Join-Path $dir 'exit.txt'
  $cmd = @(
    'try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}'
    # 진행 표시는 숨은 창에서 오류 출력(err.txt)에 CLIXML로 쌓이기만 하므로 끈다.
    "`$ProgressPreference = 'SilentlyContinue'"
    '$p = @{}'
    $set
    '$code = 0'
    "try { & $(ConvertTo-PsLiteral $ScriptPath) @p; if (`$null -ne `$LASTEXITCODE) { `$code = `$LASTEXITCODE } } catch { [Console]::Error.WriteLine(`"`$_`"); `$code = 1 }"
    "Set-Content -LiteralPath $(ConvertTo-PsLiteral $exitFile) -Value `$code -Encoding ascii"
    'exit $code'
  ) -join "`n"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
  $proc = Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand $enc" -WindowStyle Hidden -PassThru `
    -WorkingDirectory (Get-Location).Path -RedirectStandardOutput (Join-Path $dir 'out.txt') -RedirectStandardError (Join-Path $dir 'err.txt')
  $job = [ordered]@{ id = $id; pid = $proc.Id; script = (Split-Path -Leaf $ScriptPath); label = $Label; started_at = [DateTime]::UtcNow.ToString('o') }
  [IO.File]::WriteAllText((Join-Path $dir 'job.json'), ($job | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  "뒤에서 시작: $id (PID $($proc.Id)) $Label"
  "기다리기: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/wait-job.ps1 -Id $id"
}
