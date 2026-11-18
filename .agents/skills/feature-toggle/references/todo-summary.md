# 할 일 요약 (`todo-summary`, 처음부터 켜짐)

질문마다 질문 훅이 DB에서만 모은 할 일 요약(남은 질문, 도는 업무, 사용자 차례 안건, 사용자 할 일의 기한·조건, 오늘과 7일 안 일정)을 `<secretary-todo>`로 붙이고, 비서는 "다음 행동 및 순서: 없음"인 답 끝에 그 요약을 붙인다. 비서 할 일의 조건이 채워지면(날짜, 맡긴 업무 끝남, 커밋이 main에 들어감, 질문 닫힘) `<secretary-todo-due>`로 비서에게 알린다. 모델을 부르지 않는다.

- 할 일 값: 할 일 기억(`remember`의 kind=action)에 owner(user·secretary)·due·condition을 넣는다. 기억 정리 담당과 상황판 담당도 같은 값을 채운다. 비서는 `node src/cli.ts action-list`로 보고 `node src/cli.ts action-set <기억 번호> --owner user --due 2026-11-20 --cond task_done:<업무 번호>`로 고친다.
- 일정: 키 폴더(`%USERPROFILE%\.secretary\keys`)에 캘린더의 iCal 비밀 주소가 든 파일을 사용자가 직접 만들고(안에 `GOOGLE_CALENDAR_ICAL_SECRET_ADDRESS=<주소>`), `this-secretary.local.json`의 `todo-summary` 키에 `"calendarKeyFile": "<그 파일 이름>"`을 적으면 쉬는 시간 작업(`idle-jobs`)이 30분마다, 캘린더 도구를 쓴 턴 뒤 Stop 훅이 한 번 일정을 받는다. 키가 없으면 일정 항목만 빠진다.

## 켜는 순서

1. `features.json`의 `todo-summary`를 `"enabled": true`로.
2. 일정도 보려면 위 "일정"대로 키 파일과 설정 키를 둔다(키 값은 대화로 받지 않는다).

AGENTS.md에는 넣을 글이 없다. 요약을 언제 어디에 붙일지는 `<secretary-todo>` 안내가 질문마다 알려 준다.

## 끄는 순서

1. `"enabled": false`.
2. 할 일 값(`memory_actions` 표)과 받아 둔 일정은 DB에 그대로 남는다. 키 파일과 `todo-summary` 키는 지우지 않는다. 지우려면 따로 묻는다.
