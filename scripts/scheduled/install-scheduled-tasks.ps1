# 비서의 Windows 예약 작업을 등록한다. 다시 실행해도 안전(같은 이름을 덮어씀). -Task로 고른 것만, 안 주면 셋 다.
#   server        'Secretary Remote Control' 로그인할 때 server-control.ps1 -Action restart -Now로 비서 서버(remote-server.ps1) 창을 숨겨 띄운다.
#                 비서 세션이 관리자 일(예약 작업 삭제 등)을 할 수 있게 가장 높은 권한(Highest)으로 띄우므로 관리자 PowerShell에서 등록한다.
#   backup        'Secretary DB Backup' 매일 -At(기본 22:30)에 backup-db.ps1(기억 DB를 이 PC의 backups\에 백업, 14일 보관, 토큰 없음).
#   idle-jobs     'Secretary Idle Jobs' -EveryMinutes(기본 5)분마다 idle-jobs.ps1(대화가 멈추면 상황판 미리 갱신, 정리 대기가 60건 넘으면 기억 정리).
#                 기록: %USERPROFILE%\.secretary\<고유 번호>\logs\idle-jobs.log
#   ntfy          'Secretary ntfy Server' 로그인할 때 ntfy 서버(끝 알림, 기능 phone-push)를 창 없이 띄운다: <-NtfyExe> serve --config <-NtfyConfig>.
#                 관리자 불필요(이 사용자, 로그온한 경우에만 실행). -Task ntfy로 고를 때만 등록한다(기본 목록에 없음). ntfy.exe가 없으면
#                 건너뛴다. server.yml 만들기와 함께 하려면 scripts/phone-push/install-ntfy.ps1.
# 작업 이름은 비서 폴더의 features.json(기능마다 tasks의 id·name)의 이름 뒤에 이 비서의 고유 번호(.secretary-id, 없으면 여기서 만든다)를
# 붙인 것이다. 예: 'Secretary Idle Jobs (A3F9)'. 한 PC에 비서가 여럿이어도 작업 이름이 겹치지 않는다(설치 상태 점검 src/setup/check-items.ts도
# 같은 이름으로 찾는다). 위 설명의 이름은 번호를 뺀 것이다.
# 꺼진 기능(enabled false)의 작업은 -Task로 골라도 건너뛰고(-DryRun에서도), 어느 기능 때문인지와 켜는 법을 한 줄로 찍는다
# (파일이 없거나 못 읽으면 작업 이름을 몰라 등록하지 않는다).
# server만 관리자 권한이 필요하다. 콘솔 프로그램을 바로 띄우면 창이 깜빡이므로 conhost --headless로 창 없이 띄운다(백업은 예전 방식 그대로).
# -DryRun: 등록하지 않고 만들 작업의 실행 명령·시점·설정을 찍는다(지금 등록된 것과 비교할 때).
# 지금 한 번 돌려 보기: Start-ScheduledTask -TaskName '<이름>'. 해제: Unregister-ScheduledTask -TaskName '<이름>' -Confirm:$false
#
# 번호 없는 옛 이름 옮기기: 번호가 붙기 전 이름(features.json의 이름 그대로)으로 등록된 작업이 이 비서의 파일(이 비서 폴더 안, 같은 번호의
# 옛 사본, 비서가 없어진 옛 자리)을 부르면 새 이름으로 등록한 뒤 옛 작업을 지운다(-DryRun은 '옮김(예정)'만 찍는다). 옛 작업의 매일 시각(backup,
# -At을 안 줬을 때), 반복 간격(idle-jobs, -EveryMinutes를 안 줬을 때), 사용 안 함 상태를 이어받는다. 다른 비서 파일을 부르거나 무엇을 부르는지
# 모르는 옛 이름 작업은 건드리지 않는다. server의 옛 작업도 관리자 PowerShell에서만 지워진다.
# 이름이 바뀐 작업 옮기기: 옮기기 표(-MovesFile, 안 주면 배포판의 scripts/update-moves.json)의 scheduledTasks({"<버전>": {"<옛 이름>": "<새 이름>"}},
# 번호 없는 이름)에 적힌 옛 이름으로 등록된 이 비서의 작업도 같은 방식으로 옮긴다. 이 비서 번호가 붙은 옛 이름이면 이 비서 것으로 보고(부르는 파일을
# 모르는 ntfy 작업도), 번호 없는 옛 이름이면 위처럼 부르는 파일로 가린다. ntfy는 -NtfyExe·-NtfyConfig를 안 주면 옛 작업의 ntfy.exe·server.yml을 이어받는다.
# 한 PC에 비서가 여럿이면: 이 비서 이름(번호 포함)으로 이미 등록된 작업이 이 PC의 다른 비서 폴더의 파일을 부르면(그 경로 위에 번호가 다른
# 비서 폴더가 있으면) 덮어쓰지 않고 건너뛴다(-DryRun에서도). 그래도 이 비서로 가져오려면 -TakeOver.
# -FeaturesFile: features.json 대신 읽을 파일, -MovesFile: 옮기기 표, -IdFile: .secretary-id 대신 읽고 만들 파일, -FakeTasksFile: 지금 등록된 작업을 작업 스케줄러 대신
# 이 JSON({"<이름>": {"execute","arguments","workingDirectory","state","startBoundary","interval"}})에서 읽는다(셋 다 테스트용, -DryRun과 함께).
#
# 예: 한 작업은 -File로  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled/install-scheduled-tasks.ps1 -Task server [-At 22:30] [-EveryMinutes 5] [-DryRun]
#     여러 작업은 -Command로  powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'scripts\scheduled\install-scheduled-tasks.ps1' -Task server,backup [-DryRun]"
#     (-File로 -Task server,backup을 주면 쉼표 목록이 이름 하나로 넘어가 거부된다). -Task를 안 주면 모두 등록한다.

param(
  [ValidateSet('server', 'backup', 'idle-jobs', 'ntfy')] [string[]]$Task = @('server', 'backup', 'idle-jobs'),
  [string]$At = '22:30',
  [int]$EveryMinutes = 5,
  # ntfy 작업만: 서버 실행 파일과 설정 파일(관리자 없이 쓰는 사용자 폴더), 작업 이름(안 주면 features.json의 이름 + 고유 번호).
  [string]$NtfyExe = (Join-Path $env:USERPROFILE '.secretary\ntfy\ntfy.exe'),
  [string]$NtfyConfig = (Join-Path $env:USERPROFILE '.secretary\ntfy\server.yml'),
  [string]$NtfyTaskName,
  [switch]$DryRun,
  [switch]$TakeOver,
  [string]$FeaturesFile,
  [string]$MovesFile,
  [string]$IdFile,
  [string]$FakeTasksFile
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
. "$PSScriptRoot\..\lib\common.ps1"
$root = $SecretaryRoot
# 작업은 실제 스크립트가 아니라 고정 진입점(bin\<이름>, src/core/paths.ts ENTRY_POINTS)를 부른다: 스크립트를 옮겨도 다시 등록하지 않아도 된다.
$bin = Join-Path $root 'bin'

# 이 비서의 고유 번호(없으면 지금 만든다).
$hadId = [bool](Read-SecretaryId -Root $root -File $IdFile)
$id = Get-SecretaryId -Root $root -File $IdFile
if (-not $id) { throw "비서 고유 번호 파일을 만들지 못해 작업 이름을 정할 수 없어요($(if ($IdFile) { $IdFile } else { Join-Path $root $SecretaryIdFile }))." }
if (-not $hadId) { Write-Host "비서 고유 번호를 새로 만들었어요: $id ($SecretaryIdFile, 예약 작업 이름 끝에 붙어요)" }

# 작업 id → 등록 이름(번호 포함), 작업 id → 번호 없는 옛 이름, 작업 id → 그 작업을 가진 꺼진 기능의 id.
if (-not $FeaturesFile) { $FeaturesFile = Join-Path $root 'features.json' }
$names = @{}
$oldNames = @{}
$off = @{}
try {
  foreach ($f in (Get-Content -LiteralPath $FeaturesFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json).features) {
    foreach ($k in $f.scheduledTasks) {
      $names[$k.id] = Get-TaskNameWithId $k.name $id
      $oldNames[$k.id] = $k.name
      if (-not $f.core -and $f.enabled -eq $false) { $off[$k.id] = $f.id }
    }
  }
} catch { throw "features.json을 못 읽어 작업 이름을 몰라요($FeaturesFile): $($_.Exception.Message)" }
if ($NtfyTaskName) { $names['ntfy'] = $NtfyTaskName }

# 지금 등록된 작업(없으면 $null). -FakeTasksFile이면 그 파일에서 작업 스케줄러가 주는 형식으로 만든다(테스트용).
$fake = if ($FakeTasksFile) { Get-Content -LiteralPath $FakeTasksFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
function Find-Task([string]$Name) {
  if (-not $FakeTasksFile) { return Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue }
  $t = $fake.PSObject.Properties[$Name]
  if (-not $t) { return $null }
  $v = $t.Value
  [pscustomobject]@{
    TaskName = $Name
    State = if ($v.state) { $v.state } else { 'Ready' }
    Actions = @([pscustomobject]@{ Execute = $v.execute; Arguments = $v.arguments; WorkingDirectory = $v.workingDirectory })
    Triggers = @([pscustomobject]@{ StartBoundary = $v.startBoundary; Repetition = [pscustomobject]@{ Interval = $v.interval } })
  }
}

# 이름이 바뀐 작업: 새 이름(번호 없음) → 옛 이름들. 옮기기 표가 없거나 못 읽으면 없음.
if (-not $MovesFile) { $MovesFile = Join-Path $root 'scripts\update-moves.json' }
$renamedFrom = @{}
if (Test-Path -LiteralPath $MovesFile -PathType Leaf) {
  try {
    $st = (Get-Content -LiteralPath $MovesFile -Raw -Encoding UTF8 | ConvertFrom-Json).scheduledTasks
    if ($st) {
      foreach ($v in $st.PSObject.Properties) {
        foreach ($m in $v.Value.PSObject.Properties) { $renamedFrom[$m.Value] = @($renamedFrom[$m.Value]) + @($m.Name) | Where-Object { $_ } }
      }
    }
  } catch { Write-Host "옮기기 표를 못 읽어 이름이 바뀐 옛 작업은 찾지 않아요($MovesFile): $($_.Exception.Message)" }
}

# 옛 이름으로 등록된 이 비서의 작업(옮길 것): 작업 id → @{ Name = 옛 등록 이름; Task = 그 작업 }. 번호 없는 옛 이름(features.json 이름 그대로,
# 이름이 바뀐 작업은 그 옛 이름도)은 부르는 파일이 이 비서 것일 때만, 이 비서 번호가 붙은 옛 이름은 다른 비서 파일을 부르지 않으면 넣는다.
$moves = @{}
foreach ($t in $Task) {
  if (-not $names[$t] -or $off.ContainsKey($t)) { continue }
  $candidates = @()
  if ($oldNames[$t] -ne $names[$t]) { $candidates += @{ Name = $oldNames[$t]; WithId = $false } } # legacy-name: task-name-no-id
  foreach ($o in @($renamedFrom[$oldNames[$t]])) {
    if (-not $o) { continue }
    $candidates += @{ Name = (Get-TaskNameWithId $o $id); WithId = $true }
    $candidates += @{ Name = $o; WithId = $false }
  }
  foreach ($c in $candidates) {
    if ($c.Name -eq $names[$t]) { continue }
    $old = Find-Task $c.Name
    if (-not $old) { continue }
    $oldFile = Get-TaskTargetFile @($old.Actions)[0]
    $mine = if ($c.WithId) { -not ($oldFile -and (Get-OtherSecretary $oldFile $root)) } else { $oldFile -and -not (Get-OtherSecretary $oldFile $root) }
    if ($mine) { $moves[$t] = @{ Name = $c.Name; Task = $old }; break }
  }
}
# 옛 작업의 시각·간격·ntfy 파일을 이어받는다(명령에서 따로 주지 않았을 때).
if ($moves['backup'] -and -not $PSBoundParameters.ContainsKey('At')) {
  $sb = "$(@($moves['backup'].Task.Triggers)[0].StartBoundary)"
  if ($sb) { try { $At = ([datetime]$sb).ToString('HH:mm') } catch {} }
}
if ($moves['idle-jobs'] -and -not $PSBoundParameters.ContainsKey('EveryMinutes')) {
  $iv = "$(@($moves['idle-jobs'].Task.Triggers)[0].Repetition.Interval)"
  if ($iv) { try { $EveryMinutes = [int][Xml.XmlConvert]::ToTimeSpan($iv).TotalMinutes } catch {} }
}
if ($moves['ntfy']) {
  $a = "$(@($moves['ntfy'].Task.Actions)[0].Arguments)"
  if ($a -match '--headless\s+"([^"]+)"\s+serve\s+--config\s+"([^"]+)"') {
    if (-not $PSBoundParameters.ContainsKey('NtfyExe')) { $NtfyExe = $Matches[1] }
    if (-not $PSBoundParameters.ContainsKey('NtfyConfig')) { $NtfyConfig = $Matches[2] }
  }
}
$user = "$env:USERDOMAIN\$env:USERNAME"
$headless = { param($script, $extra) New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`"$extra" -WorkingDirectory $root }

$defs = [ordered]@{
  server = @{
    Name = $names['server']
    Action = & $headless (Join-Path $bin 'server-control.ps1') ' -Action restart -Now'
    Trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    RunLevel = 'Highest'
    Description = '비서 폴더의 Claude Remote Control 서버 (다른 기기에서 새 비서 세션 열기)'
    Done = "등록됨: $($names['server']) (로그인할 때 실행). 지금 바로 시작: Start-ScheduledTask -TaskName '$($names['server'])'"
  }
  backup = @{
    Name = $names['backup']
    Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $bin 'backup-db.ps1')`"" -WorkingDirectory $root
    Trigger = New-ScheduledTaskTrigger -Daily -At $At
    # 그 시각에 PC가 꺼져 있었으면 켜진 뒤 바로 한 번 돈다(StartWhenAvailable).
    Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
    RunLevel = 'Limited'
    Description = '비서 기억 DB 매일 백업, 이 PC의 backups 폴더에 14일 보관 (scripts/scheduled/backup-db.ps1)'
    Done = "등록됨: $($names['backup']) (매일 $At). 지금 한 번 돌려 보기: Start-ScheduledTask -TaskName '$($names['backup'])'"
  }
  'idle-jobs' = @{
    Name = $names['idle-jobs']
    Action = & $headless (Join-Path $bin 'idle-jobs.ps1') ''
    Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    # 기억 정리는 5분을 넘겨 돌 수 있다. 겹친 실행은 프로그램이 DB 표시로 막으므로 작업 스케줄러는 겹쳐 띄워도 된다(Parallel).
    Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances Parallel
    RunLevel = 'Limited'
    Description = "비서 쉬는 시간 작업: 상황판 미리 갱신, 기억 정리 ($($EveryMinutes)분마다, src/idle/idle-jobs.ts)"
    Done = "등록됨: $($names['idle-jobs']) ($($EveryMinutes)분마다). 기록: $(Join-Path (Get-SecretaryHome) "$id\logs\idle-jobs.log")"
  }
  ntfy = @{
    Name = $names['ntfy']
    # 콘솔 프로그램이라 conhost --headless로 창 없이 띄운다. 일하는 폴더는 ntfy.exe가 있는 폴더.
    Action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$NtfyExe`" serve --config `"$NtfyConfig`"" -WorkingDirectory (Split-Path -Parent $NtfyExe)
    Trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    # 늘 떠 있는 서버: 시간 제한 없음, 꺼지면 1분 뒤 다시(서버 작업과 같다), 이미 떠 있으면 또 띄우지 않음.
    Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    RunLevel = 'Limited'
    Description = "끝 알림 ntfy 서버 ($NtfyConfig). 비서 Stop 훅이 답 첫 줄을 보낸다 (src/phone-push/ntfy.ts)"
    Done = "등록됨: $($names['ntfy']) (로그인할 때 실행). 지금 바로 시작: Start-ScheduledTask -TaskName '$($names['ntfy'])'"
  }
}

foreach ($t in $Task) {
  $d = $defs[$t]
  if (-not $d.Name) { Write-Host "건너뜀: '$t' - features.json에 이 작업의 이름(name)이 없어요."; continue }
  if ($off.ContainsKey($t)) {
    # 비서가 이 한 줄을 사용자에게 그대로 옮길 수 있게 쓴다(무엇이 꺼져 있고, 어떻게 켜는지).
    Write-Host "건너뜀: $($d.Name) - 꺼진 기능 '$($off[$t])'의 작업이라 등록하지 않았어요. 켜려면 features.json에서 '$($off[$t])'의 `"enabled`"를 true로 고친 뒤 이 명령을 다시 돌리세요."
    continue
  }
  if ($t -eq 'ntfy' -and -not $DryRun -and -not (Test-Path -LiteralPath $NtfyExe -PathType Leaf)) {
    Write-Host "건너뜀: $($d.Name) - ntfy 서버 실행 파일이 없어요($NtfyExe). 받아 둔 뒤 다시 돌리거나 -NtfyExe로 위치를 주세요."
    continue
  }
  $existing = Find-Task $d.Name
  $other = if ($existing) { Get-OtherSecretary (Get-TaskTargetFile @($existing.Actions)[0]) $root } else { $null }
  if ($other -and -not $TakeOver) {
    Write-Host "건너뜀: $($d.Name) - 이 비서 이름(번호 포함)의 작업이 이 PC의 다른 비서($other)의 파일을 불러요. 덮어쓰면 그 비서가 쓰던 작업이 이 비서로 바뀌어요. 그래도 이 비서로 가져오려면 -TakeOver를 붙여 다시 돌리세요."
    continue
  }
  $move = $moves[$t]
  # 옛 작업을 사용 안 함으로 두었으면 새 작업도 사용 안 함으로 둔다.
  $disabled = $move -and "$($move.Task.State)" -eq 'Disabled'
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $d.RunLevel
  if ($DryRun) {
    $s = $d.Settings
    "[$($d.Name)] $($d.Action.Execute) $($d.Action.Arguments) | wd=$($d.Action.WorkingDirectory)"
    "  trigger=$($d.Trigger.CimClass.CimClassName) start=$($d.Trigger.StartBoundary) days=$($d.Trigger.DaysOfWeek) rep=$($d.Trigger.Repetition.Interval)"
    "  limit=$($s.ExecutionTimeLimit) multi=$($s.MultipleInstances) startWhenAvailable=$($s.StartWhenAvailable) battery=$($s.DisallowStartIfOnBatteries)/$($s.StopIfGoingOnBatteries) restart=$($s.RestartCount)/$($s.RestartInterval) run=$($d.RunLevel)"
    if ($move) { "  옮김(예정): '$($move.Name)' → '$($d.Name)' (옛 작업은 지움$(if ($disabled) { ', 사용 안 함 상태 이어받음' }))" }
    if ($t -eq 'ntfy' -and -not (Test-Path -LiteralPath $NtfyExe -PathType Leaf)) { "  ntfy.exe 없음($NtfyExe): 실제로 돌리면 건너뜀" }
    continue
  }
  Register-ScheduledTask -TaskName $d.Name -Action $d.Action -Trigger $d.Trigger -Settings $d.Settings -Principal $principal -Description $d.Description -Force | Out-Null
  if ($disabled) { Disable-ScheduledTask -TaskName $d.Name | Out-Null }
  Write-Host "$($d.Done)$(if ($disabled) { ' (옛 작업처럼 사용 안 함으로 둠)' })"
  if ($move) {
    try {
      Unregister-ScheduledTask -TaskName $move.Name -Confirm:$false -ErrorAction Stop
      Write-Host "옮김: 옛 이름 작업 '$($move.Name)'을 지웠어요(새 이름 '$($d.Name)')."
    } catch { Write-Host "옛 이름 작업 '$($move.Name)'을 지우지 못했어요: $($_.Exception.Message). 관리자 PowerShell에서 Unregister-ScheduledTask -TaskName '$($move.Name)' -Confirm:`$false" }
  }
}
