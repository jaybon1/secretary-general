# Windows에 로그인하면 remote-server.ps1이 숨긴 창으로 자동 실행되도록 작업 스케줄러에 등록한다.
# 창 없이(conhost --headless) server-control.ps1 -Now를 불러 서버 창을 숨겨 띄우고 작업은 바로 끝난다(이유는 server-control.ps1).
# 비서 세션이 관리자 일(예약 작업 삭제 등)을 할 수 있게 가장 높은 권한(Highest)으로 띄운다. 그래서 등록은 관리자 PowerShell에서 한다. 해제: Unregister-ScheduledTask -TaskName 'Secretary Remote Control' -Confirm:$false

$taskName = 'Secretary Remote Control'
$script = Join-Path $PSScriptRoot 'server-control.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Action restart -Now" `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description '비서 폴더의 Claude Remote Control 서버 (다른 기기에서 새 비서 세션 열기)' -Force -ErrorAction Stop | Out-Null
} catch {
  Write-Host "등록하지 못했어요: $_"
  Write-Host '가장 높은 권한 작업은 관리자 PowerShell에서만 등록돼요. 시작 메뉴에서 PowerShell을 오른쪽 클릭 > 관리자 권한으로 실행한 뒤 다시 실행하세요.'
  exit 1
}
Write-Host "등록됨: $taskName (로그인할 때 실행). 지금 바로 시작: Start-ScheduledTask -TaskName '$taskName'"
