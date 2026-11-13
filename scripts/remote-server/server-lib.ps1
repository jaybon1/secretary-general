# 비서 서버(remote-server.ps1)·서버 다루기(server-control.ps1)가 함께 쓰는 함수. lib/common.ps1 다음에 dot-source 한다.

# 비서 서버(remote-server.ps1) 창 명령줄의 -Provider 값. 계정 a 서버는 ''.
# 같은 규칙이 TS 쪽 설치 상태 점검(setup-check)에도 있다(src/setup/check-items.ts의 argProvider·serverWindow). 고치면 둘 다 고친다.
function Get-ArgProvider([string]$commandLine) { if ($commandLine -match '-Provider\s+"?([\w.-]+)') { $Matches[1] } else { '' } }

# 이 비서 폴더의 remote-server.ps1을 돌리는 명령줄인가. 옛 자리(scripts\ 바로 아래, scripts\server\)에서 뜬 서버 창도 같은 창으로 본다
# (옮긴 뒤 처음 다시 켤 때 옛 창을 찾아 끄게). TS 쪽 짝: src/setup/check-items.ts serverWindow.
function Test-ServerScriptCommand([string]$commandLine) {
  $commandLine -match ([regex]::Escape("$ScriptsDir\") + '((remote-)?server\\)?remote-server\.ps1')
}

# 비서 서버의 계정 이름: -Provider 없음 → a, subscription-b → b.
function Get-ServerAccount([string]$provider) { if ($provider) { $provider -replace '^subscription-', '' } else { 'a' } }

# 비서 서버 기록 폴더. 이 비서의 기록 폴더(~/.secretary/<고유 번호>/logs, common.ps1 Get-SecretaryLogDir) 안에 계정마다 따로 둔다(server-a, server-b).
function Get-ServerLogDir([string]$provider) { Join-Path (Get-SecretaryLogDir) "server-$(Get-ServerAccount $provider)" }

# 옛 서버 기록 폴더: 2026-11-09까지의 ~/.secretary/logs/<고유 번호>/server-a, 그 폴더가 없으면 고유 번호별로 나누기 전의 공용 ~/.secretary/logs/server-a.
# 옮기지 않고 두며, 새 폴더에 기록이 아직 없을 때만 server-control.ps1 -Action log가 본다.
function Get-LegacyServerLogDir([string]$provider) { # legacy-name: log-dir
  $name = "server-$(Get-ServerAccount $provider)"
  $id = Read-SecretaryId
  if ($id) {
    $mine = Join-Path (Get-SecretaryHome) "logs\$id\$name"
    if (Test-Path -LiteralPath $mine) { return $mine }
  }
  Join-Path (Get-SecretaryHome) "logs\$name"
}
