# 비서 서버(remote-server.ps1)를 채팅에서 다룬다. 사용자가 요청할 때 비서가 부른다(끄기는 없다).
#   restart: 5초 뒤 일회용 예약 작업 'Secretary Restart Once <계정> (<비서 고유 번호>)'이 서버를 정상 종료하고 새로 띄운다. 기본은 숨김, -Visible이면 창이 보인다.
#            비서 대화는 그 서버 안에서 돌므로 지금 세션과 따로 돌아야 한다. 이 세션은 끊긴다. 작업은 1분 뒤 작업 스케줄러가 지운다.
#   show / hide: 떠 있는 서버 창을 바로 보이거나 숨긴다. 보이는 창을 닫으면 서버가 꺼진다.
#   log: 그 계정의 최근 서버 기록 끝부분(-Lines 줄)을 보여 준다.
# -Provider subscription-b: 다른 구독(계정 b, c…) 서버(기능 account-handoff). 없으면 기본 계정(a) 서버.
# -Now: 기다리지 않고 바로 켠다(떠 있으면 정상 종료 뒤 다시). 로그인 자동 실행(install-tasks.ps1 -Task server), 바탕화면 바로가기, 위 예약 작업이
#       conhost.exe --headless로 이걸 부른다. 작업 스케줄러가 PowerShell을 바로 띄우면 콘솔이 Windows Terminal로 넘어가 숨겨지지 않고,
#       창 없는 이 스크립트가 Start-Process -WindowStyle로 띄운 서버 창은 conhost 창이라 숨기고 보일 수 있다.
# -Notify: 누르자마자 '켜는 중' 알림을 띄운다(바탕화면 바로가기용). 연결 알림은 서버 창이 따로 띄운다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/server/server-control.ps1 -Action restart -Provider subscription-b -Visible

param(
  [Parameter(Mandatory)] [ValidateSet('restart', 'show', 'hide', 'log')] [string]$Action,
  [string]$Provider,
  [switch]$Visible,
  [int]$Lines = 40,
  [switch]$Now,
  [switch]$Notify
)

. "$PSScriptRoot\..\lib\common.ps1"
. "$PSScriptRoot\server-lib.ps1"
$null = Use-Utf8Console
$account = Get-ServerAccount $Provider
$serverScript = Join-Path $PSScriptRoot 'remote-server.ps1'

Add-Type -Namespace Secretary -Name Window -MemberDefinition @'
public delegate bool EnumWindowsProc(System.IntPtr hwnd, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hwnd, out uint processId);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(System.IntPtr hwnd, System.Text.StringBuilder name, int size);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hwnd, int cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hwnd);
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint processId);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
'@

# 이 계정의 서버 창(remote-server.ps1을 돌리는 PowerShell).
function Get-ServerWindow {
  Get-WinProcess | Where-Object {
    $_.Name -in 'powershell.exe', 'pwsh.exe' -and (Test-ServerScriptCommand $_.CommandLine) -and (Get-ArgProvider $_.CommandLine) -eq "$Provider"
  } | Select-Object -First 1
}

# 콘솔 창은 conhost가 그리지만 창 주인으로는 그 콘솔의 프로그램(서버 창 PID)이 잡힌다. 숨긴 창도 찾는다.
function Get-ConsoleWindow([int]$processId) {
  $found = New-Object Collections.ArrayList
  $callback = [Secretary.Window+EnumWindowsProc] {
    param($hwnd, $lParam)
    $owner = 0
    $class = New-Object Text.StringBuilder 64
    [void][Secretary.Window]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    [void][Secretary.Window]::GetClassName($hwnd, $class, 64)
    if ($owner -eq $processId -and "$class" -eq 'ConsoleWindowClass') { [void]$found.Add($hwnd) }
    $true
  }
  [void][Secretary.Window]::EnumWindows($callback, [IntPtr]::Zero)
  $found | Select-Object -First 1
}

if ($Action -eq 'log') {
  $file = Get-ChildItem (Get-ServerLogDir $Provider) -Filter *.log -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  # 고유 번호별 폴더로 나눈 뒤 서버를 아직 다시 켜지 않았으면 기록이 옛 공용 폴더에만 있다. 그때만 그쪽을 보여 준다(다른 비서 것이 섞였을 수 있다고 적는다).
  $legacy = $false
  if (-not $file -and (Get-LegacyServerLogDir $Provider) -ne (Get-ServerLogDir $Provider)) {
    $file = Get-ChildItem (Get-LegacyServerLogDir $Provider) -Filter *.log -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    $legacy = [bool]$file
  }
  if (-not $file) { Write-Host "계정 $account 서버 기록이 아직 없어요 ($(Get-ServerLogDir $Provider))."; exit 0 }
  if ($legacy) { Write-Host "(이 비서 기록 폴더 $(Get-ServerLogDir $Provider)에 아직 기록이 없어 옛 공용 폴더를 보여 줘요. 서버를 다시 켜면 새 폴더에 쌓이고, 옛 폴더에는 이 PC의 다른 비서 기록이 섞였을 수 있어요.)" }
  Write-Host "== $($file.FullName) (끝 ${Lines}줄)"
  Get-Content $file.FullName -Encoding UTF8 -Tail $Lines
  exit 0
}

if ($Action -in 'show', 'hide') {
  $window = Get-ServerWindow
  if (-not $window) { Write-Host "계정 $account 서버 창이 떠 있지 않아요."; exit 1 }
  $hwnd = Get-ConsoleWindow $window.ProcessId
  if (-not $hwnd) { Write-Host "계정 $account 서버 창(PID $($window.ProcessId))을 찾지 못했어요. 보이게 하려면 -Action restart -Visible로 다시 켜세요."; exit 1 }
  # SW_RESTORE(9)는 숨긴 창과 최소화한 창을 모두 펼쳐 보인다. SW_HIDE(0).
  $show = $Action -eq 'show'
  [void][Secretary.Window]::ShowWindow($hwnd, $(if ($show) { 9 } else { 0 }))
  if ([Secretary.Window]::IsWindowVisible($hwnd) -ne $show) { Write-Host "계정 $account 서버 창(PID $($window.ProcessId))이 바뀌지 않았어요."; exit 1 }
  Write-Host "계정 $account 서버 창(PID $($window.ProcessId))을 $(if ($show) { '보이게' } else { '숨김으로' }) 했어요."
  exit 0
}

$style = if ($Visible) { 'Normal' } else { 'Hidden' }
if (-not $Now) {
  $at = (Get-Date).AddSeconds(5)
  $argument = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action restart -Now"
  if ($Provider) { $argument += " -Provider $Provider" }
  if ($Visible) { $argument += ' -Visible' }
  $trigger = New-ScheduledTaskTrigger -Once -At $at
  $trigger.EndBoundary = $at.AddMinutes(1).ToString('s')
  $settings = New-ScheduledTaskSettingsSet -DeleteExpiredTaskAfter ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  # a·b 서버 모두 가장 높은 권한으로 띄운다(install-tasks.ps1 -Task server, 바탕화면 바로가기의 관리자 권한 실행과 같게).
  # 권한이 서버 창보다 낮으면 그 콘솔에 붙지도, 남은 서버를 끄지도 못해 새 서버가 "already served"로 계속 거절된다.
  # 가장 높은 권한 작업은 관리자 권한 세션에서만 등록된다.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $taskAction = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $argument -WorkingDirectory $SecretaryRoot
  try {
    Register-ScheduledTask -TaskName (Get-TaskNameWithId "Secretary Restart Once $account" (Get-SecretaryId)) -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
  } catch { Write-Host "다시 켜기 예약 작업을 등록하지 못했어요: $_"; exit 1 }
  Write-Host "$($at.ToString('HH:mm:ss'))에 계정 $account 서버를 $(if ($Visible) { '창이 보이게' } else { '숨김으로' }) 다시 켭니다. 그 서버 안의 비서 세션은 끊겨요. 정상 종료 뒤에도 클라우드가 예전 등록을 3분쯤 잡고 있어(`"already served`") 새 서버는 4분쯤 뒤에 연결돼요."
  exit 0
}

if ($Notify) {
  $name = if ($Provider) { "비서-$($Provider -replace '^subscription-', '')" } else { '비서' }
  & "$PSScriptRoot\notify.ps1" -Title $name -Text '서버를 켜는 중이에요. 3~4분 뒤 연결되면 다시 알려 드려요.'
}

# 여기부터 -Now. 떠 있는 서버를 Ctrl+C로 정상 종료한다(강제로 끄면 클라우드에 등록이 몇 분 남아 새 서버가 "already served"로 거절당한다).
$window = Get-ServerWindow
if ($window) {
  $servers = @(Get-WinProcess -Filter "ParentProcessId=$($window.ProcessId)" | Where-Object Name -eq 'claude.exe')
  $helpers = @(Get-WinProcess | Where-Object { $_.CommandLine -match "--parent\s+$($window.ProcessId)(\s|$)" })
  # 그 창의 콘솔에 붙어 Ctrl+C를 보내고, 이 작업은 무시한다. 무시 설정은 새로 띄우는 창에 물려지므로 띄우기 전에 되돌린다.
  [void][Secretary.Window]::FreeConsole()
  if ([Secretary.Window]::AttachConsole($window.ProcessId)) {
    [void][Secretary.Window]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
    [void][Secretary.Window]::GenerateConsoleCtrlEvent(0, 0)
    foreach ($s in $servers) { Wait-Process -Id $s.ProcessId -Timeout 30 -ErrorAction SilentlyContinue }
    Wait-Process -Id $window.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    [void][Secretary.Window]::FreeConsole()
    [void][Secretary.Window]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
  }
  # 도우미는 서버 창이 꺼지면 30초 안에 따라 꺼지는데, 그 사이 새 서버 창이 띄운 도우미는 "이미 떠 있음"으로 끝나 버리므로 먼저 끈다.
  foreach ($h in $helpers) { taskkill /T /F /PID $h.ProcessId 2>$null | Out-Null }
}
# 재시작을 부른 턴은 끝나기 전에 끊겨 Stop 훅이 대화를 저장하지 못한다(11/6 'h2' 답이 빠져 새 세션이 같은 질문을 다시 물음).
# 서버가 꺼진 지금은 턴 중인 세션이 없으니, 비서 대화 기록을 기다림 없이 모두 저장한다.
Push-Location $SecretaryRoot
try { & node --no-warnings src\cli.ts catch-up *> $null } catch {} finally { Pop-Location }
# 정상 종료되지 않고 남은 서버 창·서버는 새 서버 창이 시작할 때 정리한다.
$serverArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', $style, '-File', "`"$serverScript`"")
if ($Provider) { $serverArgs += @('-Provider', $Provider) }
Start-Process powershell.exe -ArgumentList $serverArgs -WindowStyle $style -WorkingDirectory $SecretaryRoot
