# 기억 DB를 백업하고(node src/cli.ts db-backup), 파일 이름의 날짜(secretary-YYYYMMDD-HHMM.db)로 KeepDays일이 지난 백업을 지운다.
# 윈도우 예약 작업 'Secretary DB Backup (비서 고유 번호)'이 매일 부른다(토큰 없음, 등록: scripts/scheduled/install-scheduled-tasks.ps1 -Task backup). 이 PC 밖으로는 보내지 않는다.
# 해제(비서 폴더에서): Unregister-ScheduledTask -TaskName "Secretary DB Backup ($(Get-Content .secretary-id))" -Confirm:$false (만든 백업 파일은 남는다)
# 실행마다 결과(백업 성공·실패)를 비서 기록 폴더의 db-backup.jsonl에 한 줄 남긴다(src/core/backup-record.ts). 마지막 성공한 백업이 3일보다 오래되면 세션 시작 훅이 비서에게 알린다.
param([int]$KeepDays = 14)

# 네이티브 명령(node)의 stderr가 예외가 되지 않게 Continue로 두고 종료 코드로 판단한다.
$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\..\lib\common.ps1"
$root = $SecretaryRoot
Set-Location $root
$backups = Join-Path $root 'backups'
$cutoff = (Get-Date).AddDays(-$KeepDays).ToString('yyyyMMdd')
$pattern = '^secretary-(\d{8})-\d{4}\.db$'
$node = (Get-Command node).Source
$local = @()

# 이번 실행의 결과를 기록 파일에 한 줄 남기고(node src/cli.ts backup-record) 결과 글을 내고 끝낸다. 기록이 실패해도 종료 코드는 그대로다.
function Exit-Backup([string]$Message, [int]$Code, [string]$Backup, [string]$Reason) {
  $run = [ordered]@{ backup = $Backup }
  if ($Reason) { $run.reason = $Reason }
  $run.kept = @($local).Count
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "secretary-backup-record-$PID.json"
  try {
    [IO.File]::WriteAllText($tmp, ($run | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    & $node src/cli.ts backup-record --file $tmp 2>$null | Out-Null
  } catch {
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Output $Message
  exit $Code
}

& $node src/cli.ts db-backup 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Exit-Backup "백업 실패 (node 종료 코드 $LASTEXITCODE)" 1 'failed' "node 종료 코드 $LASTEXITCODE" }

foreach ($f in Get-ChildItem $backups -File) {
  if ($f.Name -match $pattern -and $Matches[1] -lt $cutoff) { Remove-Item $f.FullName -Force }
}
$local = @(Get-ChildItem $backups -File | Where-Object { $_.Name -match $pattern })
Exit-Backup "백업 완료: backups\에 $($local.Count)개 ($KeepDays일 보관)" 0 'ok' ''
