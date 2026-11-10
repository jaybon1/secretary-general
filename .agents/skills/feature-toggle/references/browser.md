# 브라우저 작업 (`browser`, 처음부터 켜짐)

웹은 기본으로 Claude Code의 검색·페이지 읽기 도구로 본다. 로그인된 사이트나 클릭·입력이 필요한 일은 Ego Lite(설치돼 있을 때, `ego-browser` 명령)로, 그것도 없으면 크롬의 Claude in Chrome 확장으로 한다(`chrome-fallback` 스킬). Ego Lite로 연 페이지는 `bin/ego-grab.mjs`로 근거 파일을 남긴다.

## 쓰려면(사용자가 할 일)

- Ego Lite: 설치하면 비서와 업무 세션이 알아서 쓴다(`ego-browser skill` 출력을 따른다).
- Claude in Chrome: 크롬에 확장을 설치하고, 비서에게 브라우저 작업용 크롬 프로필 이름을 알려 준다(비서가 기억해 두고 `scripts/browser/open-chrome.ps1 -ProfileName <이름>`으로 연다).

## AGENTS.md에 넣을 글

처음부터 들어 있는 `## 브라우저 작업` 절이다.

## 끄는 순서

`"enabled": false`, AGENTS.md에서 `## 브라우저 작업` 절을 빼면 비서는 검색·페이지 읽기 도구만 쓴다. 켜려면 이 배포판 저장소의 AGENTS.md에서 그 절을 다시 가져온다.
