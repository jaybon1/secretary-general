# web-unblock 실행기. Python은 사용자 폴더 tools의 가상환경(%USERPROFILE%\tools\web-unblock-venv)을 쓴다.
# 다른 Python을 쓰려면 환경변수 WEB_UNBLOCK_PYTHON에 그 python.exe 경로를 넣는다.
# 사용: & "<스킬폴더>\scripts\run.ps1" fetch https://example.com
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = if ($env:WEB_UNBLOCK_PYTHON) { $env:WEB_UNBLOCK_PYTHON } else { Join-Path $env:USERPROFILE 'tools\web-unblock-venv\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $py)) { Write-Error "Python이 없음: $py (SKILL.md '4. 도구'의 가상환경 만들기)" }
$env:PYTHONIOENCODING = 'utf-8'
& $py -I (Join-Path $here 'unblock.py') @args
exit $LASTEXITCODE