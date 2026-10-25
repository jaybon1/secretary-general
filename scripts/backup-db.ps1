# 기억 DB를 이 PC의 비서 폴더 backups/에 백업하고(node src/cli.ts backup), KeepDays일이 지난 백업을 지운다.
# 날짜는 파일 이름(secretary-YYYYMMDD-HHMM.db)으로 본다. 다른 PC나 인터넷으로는 보내지 않는다. AI를 부르지 않아 토큰이 들지 않는다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-db.ps1 [-KeepDays 14]
# 매일 자동 실행 등록: ... backup-db.ps1 -Install [-At 03:00]   (작업 스케줄러 'Secretary DB Backup', 이 사용자로 매일 그 시각)
# 등록 끄기: ... backup-db.ps1 -Uninstall
param(
  [int]$KeepDays = 14,
  [switch]$Install,
  [switch]$Uninstall,
  [string]$At = '03:00'
)

# 네이티브 명령(node)의 stderr가 예외가 되지 않게 Continue로 두고 종료 코드로 판단한다.
$ErrorActionPreference = 'Continue'
$taskName = 'Secretary DB Backup'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "예약 작업 '$taskName'을 지웠어요. 이미 만든 백업 파일은 그대로 있어요."
  exit 0
}
if ($Install) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -KeepDays $KeepDays"
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  # 그 시각에 PC가 꺼져 있었으면 다음에 켰을 때 돌린다.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  Write-Output "예약 작업 '$taskName' 등록: 매일 $At, 백업 위치 $(Join-Path (Split-Path $PSScriptRoot -Parent) 'backups'), ${KeepDays}일 보관. 끄기: -Uninstall"
  exit 0
}

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$backups = Join-Path $root 'backups'
$cutoff = (Get-Date).AddDays(-$KeepDays).ToString('yyyyMMdd')
$pattern = '^secretary-(\d{8})-\d{4}\.db$'

& (Get-Command node).Source src/cli.ts backup 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "백업 실패 (node 종료 코드 $LASTEXITCODE)"; exit 1 }

foreach ($f in Get-ChildItem $backups -File) {
  if ($f.Name -match $pattern -and $Matches[1] -lt $cutoff) { Remove-Item $f.FullName -Force }
}
$local = @(Get-ChildItem $backups -File | Where-Object { $_.Name -match $pattern })
Write-Output "백업 완료: $backups 에 $($local.Count)개 (${KeepDays}일 보관)"
