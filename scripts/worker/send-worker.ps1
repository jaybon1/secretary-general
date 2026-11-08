# 백그라운드 업무 세션에 메시지(예: [질문]의 답)를 넣는다.
# 다른 설정 폴더(두 번째 구독 등)에서 도는 세션은 비서의 ListAgents에 보이지 않아 SendMessage가 닿지 않는다.
# 그래서 그 세션이 보이는 설정 폴더로 짧은 claude -p(Haiku, 도구는 ListAgents·SendMessage만)를 띄워 대신 보낸다.
# 끝난 뒤의 알림은 오지 않으므로, 보낸 뒤 watch-worker.ps1을 다시 띄워 둔다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker/send-worker.ps1 -Id <짧은 id> -Message <보낼 글>

param(
  [Parameter(Mandatory)] [string]$Id,
  [Parameter(Mandatory)] [string]$Message
)
$ErrorActionPreference = 'Stop'

# 실제 일은 worker-lib.ps1에 있다(입구만 이 파일, 권한 허용 목록이 스크립트 이름으로 구분한다).
. "$PSScriptRoot\worker-lib.ps1"
Send-Worker @PSBoundParameters
