# 기억 DB를 백업하고(node src/cli.ts backup), 파일 이름의 날짜(secretary-YYYYMMDD-HHMM.db)로 KeepDays일이 지난 백업을 지운다.
# 윈도우 예약 작업 'Secretary DB Backup (비서 고유 번호)'이 매일 부른다(토큰 없음, 등록: scripts/tasks/install-tasks.ps1 -Task backup). 이 PC 밖으로는 보내지 않는다.
# 해제(비서 폴더에서): Unregister-ScheduledTask -TaskName "Secretary DB Backup ($(Get-Content .secretary-id))" -Confirm:$false (만든 백업 파일은 남는다)
param([int]$KeepDays = 14)

# 네이티브 명령(node)의 stderr가 예외가 되지 않게 Continue로 두고 종료 코드로 판단한다.
$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\..\lib\common.ps1"
$root = $SecretaryRoot
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
Write-Output "백업 완료: backups\에 $($local.Count)개 ($KeepDays일 보관)"
