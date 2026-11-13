# 업무 세션이 업무를 끝냈다고 상태 파일(이 비서의 기록 폴더 ~/.secretary/<비서 번호>/state/worker-sessions.json)에 적는다. 세션은 바로 끄지 않고 쉬게 둔다.
# 55분 안에 같은 공간·공급자의 다음 업무가 오면 start-worker.ps1이 그 세션을 재사용한다. 안 오면 뒤에서 띄운 이 스크립트가
# 55분 뒤 그동안 재사용되지 않았는지(업무 끝난 시각이 그대로인지) 보고 claude stop으로 끈다. AI를 부르지 않아 토큰이 들지 않는다.
# 상태 파일에 없는 세션(이 방식 전에 띄운 세션)과 -Stop을 주면 지금처럼 바로 끈다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker/worker-done.ps1 -Id <짧은 id> [-Stop]
# (-StopAfter <업무 끝난 시각>은 스스로를 뒤에서 띄울 때만 쓴다.)

param(
  [Parameter(Mandatory)] [string]$Id,
  [switch]$Stop,
  [string]$StopAfter,
  [int]$IdleMinutes
)
$ErrorActionPreference = 'Stop'

# 실제 일은 worker-lib.ps1에 있다(진입점만 이 파일, 권한 허용 목록이 스크립트 이름으로 구분한다).
. "$PSScriptRoot\worker-lib.ps1"
Complete-Worker @PSBoundParameters
