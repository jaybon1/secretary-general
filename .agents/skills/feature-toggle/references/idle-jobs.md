# 쉬는 시간 작업 (`idle-jobs`, 처음부터 켜짐)

예약 작업 'Secretary Idle Jobs (비서 고유 번호)'가 5분마다 `node src/cli.ts idle-jobs`를 돌린다(관리자 권한 필요 없음). 대화가 10분 멈추면 상황판을 미리 고쳐 쓰고, 정리 안 된 대화가 60건 넘고 30분 멈추면 기억 정리를 돌린다. 둘 다 같은 구독의 Haiku로 돌아 그만큼 사용량을 쓴다. 기록: `%USERPROFILE%\.secretary\<비서 고유 번호>\logs\idle-jobs.log`.

## 켜는 순서(설치 때 이미 했으면 건너뜀)

1. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled/install-scheduled-tasks.ps1 -Task idle-jobs`
2. `features.json`의 `idle-jobs`가 `"enabled": true`인지, AGENTS.md `## 정리` 절이 아래 글로 시작하는지 본다.

## AGENTS.md에 넣을 글

```
기억 정리는 쉬는 시간에 저절로 돈다(정리 안 된 대화 60건 이상 + 30분 대화 없음, 예약 작업 'Secretary Idle Jobs (비서 고유 번호)').
```
(`## 정리` 절 첫 문단의 첫 문장이다. 처음부터 들어 있다.)

## 끄는 순서

1. 비서 폴더에서 `Unregister-ScheduledTask -TaskName "Secretary Idle Jobs ($(Get-Content .secretary-id))" -Confirm:$false`
2. `"enabled": false`. AGENTS.md `## 정리` 절의 위 문장을 "`/consolidate`로 기억을 정리한다(정리 대기 대화가 많다는 안내가 오면 제안한다)."로 바꾼다.
3. 그 뒤로 상황판은 새 세션을 열 때만 고쳐 쓰이고, 기억 정리는 `/consolidate`로 한다. `/consolidate`는 쉬는 시간 작업과 상관없이 같은 정리 담당(`src/staff/memory-consolidation.json`)을 뒤에서 띄우고, 결과는 "기억 정리 확인"으로 본다.
