# 예약 작업 'Secretary Idle Jobs (비서 고유 번호)'가 5분마다 창 없이(conhost --headless) 부른다: node src/cli.ts idle-jobs를 한 번 돌리고
# 출력 한 줄을 이 비서의 기록 폴더 %USERPROFILE%\.secretary\<고유 번호>\logs\idle-jobs.log에 붙인다(common.ps1 Get-SecretaryLogDir,
# 등록: install-scheduled-tasks.ps1 -Task idle-jobs, 내용: src/idle/idle-jobs.ts). 번호별로 나누기 전의 logs\idle-jobs.log는 그 자리에 둔다.
# conhost --headless 아래에서는 cmd /c의 따옴표가 풀리지 않아 기록이 남지 않았으므로(2026-11-05 시험) 이 스크립트를 거친다.
$ErrorActionPreference = 'Continue'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
. "$PSScriptRoot\..\lib\common.ps1"
$root = $SecretaryRoot
$logDir = Get-SecretaryLogDir $root
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'idle-jobs.log'
Set-Location $root
$out = (& node --no-warnings src\cli.ts idle-jobs 2>&1 | Out-String).Trim()
if ($LASTEXITCODE) { $out = "$(Get-Date -Format 'yyyy-MM-dd HH:mm') 실패(종료 코드 $LASTEXITCODE): $out" }
[IO.File]::AppendAllText($log, "$out`r`n", $utf8)
