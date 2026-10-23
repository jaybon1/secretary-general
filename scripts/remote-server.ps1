# 비서 폴더에서 Remote Control 서버 모드를 띄운다.
# 다른 기기(claude.ai/code, Claude 앱)의 세션 목록에서 이 폴더의 새 비서 세션을 열 수 있게 된다.
# 서버는 네트워크가 오래 끊기면 스스로 끝나므로, 끝나면 잠시 뒤 다시 띄운다.
# 로그인할 때 자동 실행: scripts/install-autostart.ps1

. "$PSScriptRoot\claude-env.ps1"
$null = Use-Utf8Console
Clear-HostClaudeEnv
# 원격 세션은 /chrome의 "기본으로 켜기"를 무시하고, 시작 환경의 이 변수로만 Claude in Chrome을 연결한다.
# 서버가 만드는 세션이 이 변수를 물려받아 이 PC의 크롬을 쓴다.
$env:CLAUDE_CODE_ENABLE_CFC = '1'
$claude = Get-ClaudeExe
Set-Location (Split-Path -Parent $PSScriptRoot)

# 예전 서버가 남아 있으면 새 서버가 "This folder is already served"로 거절당하므로 먼저 끈다.
# 그 서버가 띄운 세션까지 함께 끈다(/T).
function Stop-Leftover([string]$label, [scriptblock]$match) {
  $found = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and (& $match $_) })
  foreach ($p in $found) {
    Write-Host "[비서 서버] 남아 있던 $label 정리 (PID $($p.ProcessId))"
    taskkill /T /F /PID $p.ProcessId 2>$null | Out-Null
  }
  foreach ($p in $found) { Wait-Process -Id $p.ProcessId -Timeout 15 -ErrorAction SilentlyContinue }
}
# 이 스크립트가 두 번 떠 있으면 서로 자리를 뺏으며 계속 실패한다.
Stop-Leftover '서버 창' { param($p) $p.Name -in 'powershell.exe', 'pwsh.exe' -and $p.CommandLine -like "*$PSCommandPath*" }

Add-Type -Namespace Secretary -Name ConsoleCtrl -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int std);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);
'@

# Ctrl+C로 끝난 서버는 바꿔 둔 콘솔 설정을 되돌리지 않아 한글이 "비비서서"처럼 겹쳐 찍힌다. 서버가 끝날 때마다 처음 설정으로 되돌린다.
$consoleModes = foreach ($std in -10, -11) {
  $handle = [Secretary.ConsoleCtrl]::GetStdHandle($std); $mode = 0
  if ([Secretary.ConsoleCtrl]::GetConsoleMode($handle, [ref]$mode)) { @{ Handle = $handle; Mode = $mode } }
}
function Restore-Console {
  foreach ($c in $consoleModes) { [Secretary.ConsoleCtrl]::SetConsoleMode($c.Handle, $c.Mode) | Out-Null }
  $null = Use-Utf8Console
}

# 서버 아래 떠 있는 비서 세션 수. 세션을 보관하면 그 프로세스도 같이 끝난다.
function Get-SessionCount([int]$serverPid) {
  @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$serverPid" | Where-Object { $_.CommandLine -match '--sdk-url' }).Count
}

# 세션이 0개면 다른 기기에서는 서버가 오프라인으로 보여 새 세션을 못 연다. 서버는 켜질 때만 세션을 미리 만들므로 다시 켠다.
# 강제로 끄면 클라우드에 등록이 몇 분 남아 거절당하므로, Ctrl+C로 정상 종료시킨다(이 창은 그동안 Ctrl+C를 무시).
function Stop-ServerGracefully([Diagnostics.Process]$server) {
  [Secretary.ConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
  try {
    [Secretary.ConsoleCtrl]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
    if (-not $server.WaitForExit(30000)) { taskkill /T /F /PID $server.Id 2>$null | Out-Null; $server.WaitForExit() }
  } finally {
    [Secretary.ConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
  }
}

while ($true) {
  # 로그인 직후에는 네트워크가 아직 없어 서버가 미리 만드는 세션이 실패한다.
  while (-not (Test-NetConnection api.anthropic.com -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    Write-Host '[비서 서버] 인터넷 연결을 기다리는 중…'
    Start-Sleep -Seconds 10
  }
  if (-not (Test-ClaudeLogin $claude)) {
    Write-Host '[비서 서버] Claude 로그인이 필요해요. 새 터미널에서 "claude auth login"을 실행하세요. 5분 뒤 다시 확인합니다.'
    Start-Sleep -Seconds 300
    continue
  }
  # 서버는 이 파일에 적힌 예전 세션을 다시 붙잡는데, 그 세션이 보관됐으면 바로 죽고 새 세션을 만들지 않는다.
  # 지우면 매번 새 세션을 미리 만든다.
  $pointer = Join-Path $env:USERPROFILE ".claude\projects\$((Get-Location).Path -replace '[:\\/]', '-')\bridge-pointer.json"
  Remove-Item $pointer -ErrorAction SilentlyContinue
  Stop-Leftover '비서 서버' { param($p) $p.Name -eq 'claude.exe' -and $p.CommandLine -match '\sremote-control\s' -and $p.CommandLine -match '비서' }
  # 의미 검색 도우미(모델 약 1GB)를 이 창에 묶어 띄운다. 창이 살아 있는 동안 계속 떠 있고, 창이 꺼지면 30초 안에 따라 꺼진다.
  # 이미 떠 있으면 도우미가 알아서 그냥 끝나므로 매번 불러도 된다(도우미가 죽었을 때 다시 살리는 역할).
  Start-Process (Get-Command node).Source -ArgumentList 'src/cli.ts', 'embed-server', '--parent', $PID -WindowStyle Hidden
  Write-Host "[비서 서버] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 서버 시작"
  $server = Start-Process $claude -ArgumentList 'remote-control', '--name', '비서', '--permission-mode', 'auto' -NoNewWindow -PassThru
  $null = $server.Handle  # 끝난 뒤 종료 코드를 읽으려면 미리 잡아 둬야 한다.
  $emptySince = $null
  $restarting = $false
  # 1분마다 세션 수를 센다. 두 번 연달아 0개면(1분 넘게 0개) 다시 켠다.
  # 0개가 된 뒤 4~5분이면 다른 기기에서 새 세션을 못 열게 되므로 그보다 일찍 잡는다.
  $checkMinutes = 1
  while (-not $server.WaitForExit($checkMinutes * 60000)) {
    if ((Get-SessionCount $server.Id) -gt 0) { $emptySince = $null; continue }
    if (-not $emptySince) { $emptySince = Get-Date; continue }
    Write-Host "[비서 서버] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 비서 세션이 ${checkMinutes}분 넘게 0개라 새 세션을 만들려고 서버를 다시 켭니다."
    Stop-ServerGracefully $server
    $restarting = $true
  }
  Restore-Console
  if ($restarting) { continue }
  Write-Host "[비서 서버] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 서버 종료(코드 $($server.ExitCode)). 30초 뒤 다시 시작합니다."
  Start-Sleep -Seconds 30
}
