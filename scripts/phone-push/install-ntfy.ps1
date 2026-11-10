# 끝 알림(기능 notify)의 ntfy 서버를 관리자 없이 이 사용자로 띄우게 준비한다. 다시 실행해도 안전하다.
#   1. server.yml이 없으면 만든다(사용자 폴더, 있으면 그대로 둔다). 이 PC 안(127.0.0.1)에서만 듣고, 폰은 Tailscale Serve를 거쳐 들어온다.
#   2. 예약 작업 'Secretary ntfy Server (고유 번호)'를 등록한다: 로그인할 때, 로그온한 경우에만, 창 없이 ntfy.exe serve --config <server.yml>.
#      등록은 scripts/scheduled/install-scheduled-tasks.ps1 -Task ntfy가 한다(작업 이름·고유 번호·다른 비서 작업 보호가 다른 예약 작업과 같다).
# ntfy.exe 받기는 하지 않는다(받을 주소·확인 방법은 설치 안내 문서). 서비스(sc.exe)·C:\ProgramData는 쓰지 않는다(관리자 필요).
# -DryRun: 아무것도 쓰지 않고 할 일(만들 server.yml 내용, 등록할 작업)을 찍는다.
# -WebPush -WebPushEmail <관리자 메일>: 웹 푸시(PC 브라우저가 탭을 닫아도 알림)도 켠다. 새로 만드는 server.yml에 `ntfy webpush keys`로 만든
#   키(web-push-public-key·web-push-private-key)와 web-push-file(설정 옆 webpush.db), web-push-email-address(푸시 서비스에 알리는 연락처)를
#   넣는다. ntfy가 base-url을 요구하므로 -BaseUrl도 준다. 개인 키는 server.yml에만 쓰고 화면·기록에 찍지 않는다.
#   server.yml이 이미 있으면 고치지 않고, 웹 푸시 줄이 없을 때 넣는 법만 찍는다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phone-push/install-ntfy.ps1 [-NtfyExe <ntfy.exe>] [-ConfigFile <server.yml>]
#       [-TaskName <작업 이름>] [-Listen 127.0.0.1:2586] [-BaseUrl https://<이 PC>.ts.net:8443] [-WebPush -WebPushEmail <메일>] [-DryRun]
# 지금 바로 시작: Start-ScheduledTask -TaskName '<작업 이름>'. 해제: Unregister-ScheduledTask -TaskName '<작업 이름>' -Confirm:$false

param(
  [string]$NtfyExe = (Join-Path $env:USERPROFILE '.secretary\ntfy\ntfy.exe'),
  [string]$ConfigFile = (Join-Path $env:USERPROFILE '.secretary\ntfy\server.yml'),
  [string]$TaskName,
  [string]$Listen = '127.0.0.1:2586',
  [string]$BaseUrl,
  [switch]$WebPush,
  [string]$WebPushEmail,
  [switch]$DryRun,
  # 시험용(install-scheduled-tasks.ps1에 그대로 넘긴다).
  [string]$FeaturesFile,
  [string]$IdFile,
  [string]$FakeTasksFile
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
. "$PSScriptRoot\..\lib\common.ps1"

if ($Listen -notmatch '^[\w.\[\]:-]*:\d{1,5}$') { throw "-Listen은 '주소:포트' 꼴이어야 해요: $Listen" }
if ($BaseUrl -and $BaseUrl -notmatch '^https?://[^\s/]+$') { throw "-BaseUrl은 경로 없는 http(s) 주소여야 해요: $BaseUrl" }
if ($WebPushEmail -and -not $WebPush) { throw '-WebPushEmail은 -WebPush와 함께 줘요.' }

# 1. server.yml (ntfy 문서 docs.ntfy.sh/config의 칸 이름). 캐시는 설정 파일 옆에 둔다: 폰이 잠깐 끊겨도 다시 붙으면 놓친 알림을 받는다.
$dir = Split-Path -Parent $ConfigFile
$cache = Join-Path $dir 'cache.db'
# YAML 큰따옴표 안에서는 역슬래시를 두 개로 쓴다.
$webPushFile = "web-push-file: `"$((Join-Path $dir 'webpush.db') -replace '\\', '\\')`""
$exeThere = Test-Path -LiteralPath $NtfyExe -PathType Leaf
$configThere = Test-Path -LiteralPath $ConfigFile

# 웹 푸시(-WebPush, 새 server.yml에만): ntfy webpush keys가 stdout에 낸 키를 받아 server.yml에만 쓴다(찍지 않는다).
$webPushLines = @('# 웹 푸시(PC 브라우저가 탭을 닫아도 알림)를 켜려면 install-ntfy.ps1을 -WebPush로 돌려 만들거나, 설치 안내 문서대로 web-push-* 네 줄을 넣는다.')
if ($WebPush -and -not $configThere) {
  if (-not $BaseUrl) { throw '-WebPush에는 -BaseUrl도 줘요(ntfy는 웹 푸시에 base-url이 있어야 떠요).' }
  if ($WebPushEmail -notmatch '^[^\s"@]+@[^\s"@]+\.[^\s"@]+$') { throw "-WebPush에는 -WebPushEmail <메일 주소>도 줘요(푸시 서비스에 알리는 관리자 연락처): '$WebPushEmail'" }
  if ($DryRun) {
    $pub = '<ntfy webpush keys로 만들 공개 키>'
    $priv = '<ntfy webpush keys로 만들 개인 키, 이 파일에만 씀>'
  } elseif (-not $exeThere) {
    throw "웹 푸시 키를 만들려면 ntfy.exe가 있어야 해요(받아 둔 뒤 다시 돌린다): $NtfyExe"
  } else {
    $keys = & $NtfyExe webpush keys | Out-String
    $pub = if ($keys -match '(?m)^web-push-public-key:\s*(\S+)') { $Matches[1] }
    $priv = if ($keys -match '(?m)^web-push-private-key:\s*(\S+)') { $Matches[1] }
    $keys = $null
    if ($LASTEXITCODE -ne 0 -or -not $pub -or -not $priv) { throw "ntfy webpush keys에서 키를 받지 못했어요(종료 코드 $LASTEXITCODE). server.yml은 만들지 않았어요." }
  }
  $webPushLines = @(
    '# 웹 푸시(PC 브라우저가 탭을 닫아도 알림). 개인 키는 이 파일에만 둔다(대화·기록에 붙이지 않는다).'
    "web-push-public-key: `"$pub`""
    "web-push-private-key: `"$priv`""
    $webPushFile
    "web-push-email-address: `"$WebPushEmail`""
  )
}
$yaml = @(
  '# 비서 끝 알림 ntfy 서버 설정 (scripts/phone-push/install-ntfy.ps1이 만듦, 고쳐도 다시 덮어쓰지 않는다)'
  "listen-http: `"$Listen`""
  $(if ($BaseUrl) { "base-url: `"$BaseUrl`"" } else { '# base-url: "https://<이 PC>.ts.net:8443"   # 폰이 여는 주소(Tailscale Serve를 붙인 뒤 채운다)' })
  'behind-proxy: true'
  "cache-file: `"$($cache -replace '\\', '\\')`""
  'cache-duration: "12h"'
  '# 인증을 걸 때만 주석을 푼다(설치 안내 문서 4번):'
  "# auth-file: `"$((Join-Path $dir 'user.db') -replace '\\', '\\')`""
  '# auth-default-access: "deny-all"'
  $webPushLines
  ''
) -join "`n"
$pub = $null; $priv = $null

"ntfy.exe: $NtfyExe $(if ($exeThere) { '(있음)' } else { '(없음: 받아 둔 뒤 다시 돌린다. 작업 등록은 건너뛴다)' })"
if ($configThere) {
  "server.yml: $ConfigFile (있음, 그대로 둠)"
  if ($WebPush -and -not (Select-String -LiteralPath $ConfigFile -Pattern '^\s*web-push-public-key:' -Quiet)) {
    '웹 푸시: server.yml에 web-push 줄이 없어요. 이 파일은 고치지 않으니 넣으려면:'
    "  1. 이 PC의 PowerShell에서 직접 & `"$NtfyExe`" webpush keys 를 돌려, 나온 web-push-public-key·web-push-private-key 두 줄을 server.yml 끝에 붙인다(개인 키는 대화·기록에 붙이지 않는다)."
    "  2. 같이 붙인다: $webPushFile 과 web-push-email-address: `"<관리자 메일>`" (base-url 줄도 있어야 한다)."
    "  3. ntfy 서버를 다시 띄운다: Stop-ScheduledTask·Start-ScheduledTask -TaskName '<Secretary ntfy Server (고유 번호)>'."
  }
} elseif ($DryRun) {
  "server.yml: $ConfigFile (만들 예정, 내용:)"
  $yaml -split "`n" | Where-Object { $_ } | ForEach-Object { "  $_" }
} else {
  New-Item -ItemType Directory -Force $dir | Out-Null
  Write-Utf8File $ConfigFile $yaml
  "server.yml: $ConfigFile (만듦$(if ($WebPush) { ', 웹 푸시 키 넣음: 개인 키는 이 파일에만' }))"
}
$yaml = $null

# 2. 예약 작업(install-scheduled-tasks.ps1이 이름·고유 번호를 정하고 등록한다).
$taskArgs = @{ Task = @('ntfy'); NtfyExe = $NtfyExe; NtfyConfig = $ConfigFile }
if ($TaskName) { $taskArgs.NtfyTaskName = $TaskName }
if ($DryRun) { $taskArgs.DryRun = $true }
if ($FeaturesFile) { $taskArgs.FeaturesFile = $FeaturesFile }
if ($IdFile) { $taskArgs.IdFile = $IdFile }
if ($FakeTasksFile) { $taskArgs.FakeTasksFile = $FakeTasksFile }
& (Join-Path $PSScriptRoot '..\scheduled\install-scheduled-tasks.ps1') @taskArgs
