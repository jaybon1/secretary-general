# 백그라운드 업무 세션에 메시지(예: [질문]의 답, 새 지시)를 넣는다. 공급자·설정 폴더와 상관없이 업무 세션에 보내는 길은 이것 하나다.
# 다른 설정 폴더(두 번째 구독 등)에서 도는 세션은 비서의 ListAgents에 보이지 않아 SendMessage가 닿지 않는다.
# 그래서 그 세션이 보이는 설정 폴더로 짧은 claude -p(Haiku, 도구는 ListAgents·SendMessage만)를 띄워 대신 보낸다.
# 글은 원문 그대로 메시지 파일(임시 폴더 secretary-worker-messages\<세션 id>\)에 쓰고, 업무 세션에는 그 파일을 읽으라는 한 줄만 보낸다
# (명령 인자로 넘긴 글은 큰따옴표·줄바꿈이 깨지고, Haiku가 긴 글을 다시 치면 바뀔 수 있다). 여러 줄이거나 따옴표가 든 글은 -MessageFile로 넘긴다.
# 끝난 뒤의 알림은 오지 않으므로, 보낸 뒤 watch-worker.ps1을 다시 띄워 둔다.
# 그 세션의 공급자(start-worker가 남긴 상태 기록, 없으면 모름)가 개인정보를 넣으면 안 되는 공급자면, 글에 사용자 호칭·기억/대화 번호·
# 다른 작업 공간 이름이 있을 때 보내지 않고 멈춘다(providers.ps1 Assert-PrivateFreeBrief).
# 출력: '보냄'(종료 0), 세션이 꺼져 있어 깨우며 넣었으면 '깨워서 보냄'(종료 0), 그다음 줄에 '메시지 파일: <경로>'. Haiku 답이 '보냄' 한 마디가 아니면
# 닿지 않은 것으로 본다. 세션이 떠 있는데 닿지 않았거나 떠 있는지 확인하지 못하면 깨우지 않고(깨우면 사본이 뜬다) '못 보냄: …'(종료 1).
# '보냄'을 받으면 몇 초 안에 업무 세션 대화 기록에 메시지 파일 경로가 든 줄이 생겼는지 본다: 없으면 '보냄 확인 안 됨: …'(종료 1),
# 대화 기록을 못 찾으면 '보냄' 뒤에 '확인 못 함: …' 한 줄(종료 0: 다시 보내면 같은 글이 두 번 갈 수 있다).
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worker/send-worker.ps1 -Id <짧은 id> (-MessageFile <UTF-8 파일> | -Message <한 줄 글>)

param(
  [Parameter(Mandatory)] [string]$Id,
  [string]$Message,
  [string]$MessageFile
)
$ErrorActionPreference = 'Stop'

# 실제 일은 worker-lib.ps1에 있다(진입점만 이 파일, 권한 허용 목록이 스크립트 이름으로 구분한다).
. "$PSScriptRoot\worker-lib.ps1"
Send-Worker @PSBoundParameters