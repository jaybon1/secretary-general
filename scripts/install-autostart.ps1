# Windows에 로그인하면 remote-server.ps1이 최소화된 창으로 자동 실행되도록 작업 스케줄러에 등록한다.
# 현재 사용자 작업이라 관리자 권한은 필요 없다. 해제: Unregister-ScheduledTask -TaskName 'Secretary Remote Control' -Confirm:$false

$taskName = 'Secretary Remote Control'
$script = Join-Path $PSScriptRoot 'remote-server.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$script`"" `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description '비서 폴더의 Claude Remote Control 서버 (다른 기기에서 새 비서 세션 열기)' -Force | Out-Null
Write-Host "등록됨: $taskName (로그인할 때 실행). 지금 바로 시작: Start-ScheduledTask -TaskName '$taskName'"
