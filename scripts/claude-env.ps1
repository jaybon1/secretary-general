# 다른 스크립트가 dot-source 해서 쓰는 공용 함수.
# 데스크톱 앱 세션 안에서 실행하면 앱 전용 환경변수(ANTHROPIC_BASE_URL 등)가 따라와
# 별도로 띄우는 claude 프로세스가 앱의 연결을 잘못 쓰게 되므로 지운다.

# 이 PC의 PowerShell 5.1은 기본으로 CP949로 내보내 비서(UTF-8로 읽음)에게 한글이 깨져 보인다.
# 비서가 출력을 읽는 스크립트는 맨 처음 이걸 불러 오류 문구까지 UTF-8로 내보낸다. 인코딩을 돌려준다.
function Use-Utf8Console {
  $utf8 = New-Object Text.UTF8Encoding $false
  $global:OutputEncoding = $utf8
  try { [Console]::OutputEncoding = $utf8 } catch {}
  $utf8
}

function Get-ClaudeExe {
  $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path $fallback) { return $fallback }
  throw 'claude 실행 파일을 찾지 못했어요. https://claude.ai/install.ps1 로 Claude Code를 설치하세요.'
}

function Clear-HostClaudeEnv {
  Get-ChildItem env: | Where-Object Name -match '^(CLAUDE|ANTHROPIC)' | ForEach-Object {
    Remove-Item -LiteralPath "env:$($_.Name)" -ErrorAction SilentlyContinue
  }
  # 비서 서버가 켜진 뒤 설치한 프로그램(예: Python)은 서버의 옛 PATH에 없으므로, 레지스트리의 최신 PATH를 다시 읽는다.
  $env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
}

# 비서 서버(remote-server.ps1) 기록 폴더. 날짜별 파일로 14일 치 둔다.
function Get-ServerLogDir { Join-Path $env:USERPROFILE '.secretary\logs\server' }

function Test-ClaudeLogin([string]$claude) {
  try { return [bool]((& $claude auth status 2>$null | Out-String | ConvertFrom-Json).loggedIn) } catch { return $false }
}
