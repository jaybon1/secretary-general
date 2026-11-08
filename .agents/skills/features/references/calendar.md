# 일정 → Google Calendar (`calendar`)

대화에 날짜가 있는 일(약속, 예약, 마감, 기념일)이 나오면 비서가 묻지 않고 Google Calendar에 넣는다. claude.ai의 Google Calendar 커넥터를 쓴다(이 PC에 따로 설치하는 것 없음, 비용 없음). 절차는 `calendar` 스킬(`.agents/skills/calendar/SKILL.md`).

## 켜는 순서

1. 사용자가 할 일: claude.ai(또는 Claude 앱) 설정의 커넥터에서 Google Calendar를 연결한다. 이 세션에 `mcp__claude_ai_Google_Calendar__list_events` 같은 도구가 보이면 된 것이다(안 보이면 새 세션에서 다시 본다).
2. `features.json`의 `calendar`를 `"enabled": true`로.
3. `.agents/skills/calendar/SKILL.md` 머리말의 `disable-model-invocation: true` 줄을 지운다(꺼져 있는 동안 비서가 이 스킬을 스스로 부르지 않게 둔 줄이다).
4. 아래 글을 AGENTS.md의 `## 브라우저 작업` 절 바로 앞에 넣는다.
5. 시험: 사용자에게 알리고 `list_events`로 오늘 일정을 한 번 읽어 연결을 확인한다(넣지는 않는다).

## AGENTS.md에 넣을 글

```
## 일정 → Google Calendar (자동)

사용자가 날짜가 있는 일(약속, 예약, 마감, 기념일 등)을 말하면 묻지 않고 그 자리에서 Google Calendar에 넣는다. 절차는 `calendar` 스킬을 불러 따른다.
```

## 끄는 순서

`"enabled": false`, AGENTS.md에서 위 절을 빼고, `calendar` 스킬 머리말에 `disable-model-invocation: true` 줄을 다시 넣는다. 캘린더의 일정과 커넥터 연결은 그대로 둔다.
