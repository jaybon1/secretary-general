---
name: server-ops
description: 비서 서버 다시 켜기·서버 창 보이기/숨기기·서버 기록 보기, 그리고 사용자가 "상태"라고 할 때 비서 상황 대시보드를 요약하는 절차.
---

# 비서 서버와 상태

## 서버 다루기
비서 서버 다시 켜기·창 보이기/숨기기·기록 보기 요청에는 `scripts/remote-server/server-control.ps1`을 쓴다(서버 기록 폴더는 `%USERPROFILE%\.secretary\<비서 고유 번호>\logs\server-<계정>`, 기본 계정은 `server-a`). 다시 켜면 그 서버 안의 비서 세션이 끊기고 4분쯤 뒤 연결되니 먼저 알린다.

## 쉬는 시간 작업
예약 작업 'Secretary Idle Jobs (비서 고유 번호)'가 5분마다 `node src/cli.ts idle-jobs`를 돌려 상황판을 미리 고쳐 쓰고 기억 정리를 돌린다(비서 예약 작업 이름 끝 괄호는 비서 폴더 `.secretary-id`의 번호다). 도는지 볼 때는 이 비서의 기록 `%USERPROFILE%\.secretary\<그 번호>\logs\idle-jobs.log` 끝부분과(번호별로 나누기 전 기록은 `logs\idle-jobs.log`에 남아 있고, 한 PC의 다른 비서 기록이 섞였을 수 있다), 비서 폴더에서 `Get-ScheduledTaskInfo -TaskName "Secretary Idle Jobs ($(Get-Content .secretary-id))"`를 본다. 없으면 `scripts/scheduled/install-scheduled-tasks.ps1 -Task idle-jobs`로 다시 등록한다(묻고 나서). 예약 작업을 기다리지 않고 지금 한 번 돌릴 때는 비서가 직접 비서 폴더에서 `node src/cli.ts idle-jobs`를 돌린다(기억 정리만 바로: `node src/cli.ts memory-consolidation`, 뒤에서 띄우고 바로 끝내려면 `--detach`를 더한다. 이미 도는 정리가 있으면 새로 띄우지 않는다). 정리 담당의 실행 기록은 `workspaces\_staff\memory-consolidation\runs-<그 번호>.jsonl`에 있다.

## "상태"
"상태"라고 하면 비서 폴더에서 `node --no-warnings bin/dashboard.mjs status --text`를 돌려 짧게 요약한다(한도, 돌고 있는 업무 세션·run-job, 업무 칸반, 예약 작업. 대시보드 서버가 꺼져 있어도 돈다). 화면 주소는 `node bin/dashboard.mjs urls`가 알려 준다(대시보드 기능 `dashboard`가 켜져 있으면 비서 서버와 같이 뜬다. 설정은 `this-secretary.local.json`의 `dashboard` 칸, `src/dashboard/settings.ts`). 한도에 보일 공급자는 대시보드 화면의 `/settings`에서 고르고(`this-secretary.local.json`의 `usage-poll` 칸), 그 공급자 사용량은 비서 서버와 같이 뜨는 조회기(기능 `usage-poll`)가 5분마다 조회한다.
