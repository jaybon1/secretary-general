---
name: work-skill-writing
description: 사용자가 가르친 업무 처리 기준·절차를 업무 스킬(공통 스킬 폴더의 common-<업무>)로 쓰거나 고치는 방법. 업무 기준을 배웠을 때, "규칙으로 넣어 줘"가 업무 내용일 때, 스킬 폴더 구성이나 링크를 만들 때 먼저 불러 따른다.
---

# 업무 스킬 쓰기

## 어디에 쓰는가
- 공통 스킬 폴더 `../workspaces/_skills/common-<업무>/SKILL.md`에 쓴다. 폴더 이름과 머리말(`---`)의 `name`이 같은 `common-<업무>`다.
- 스킬 목록도 매 세션 읽히므로 업무 분야마다 스킬 하나로 묶는다.

## 비서가 직접 하는 업무의 스킬
- 비서 폴더 맨 위 `common-skills.json`의 `skills`에 그 이름(`common-<업무>`)을 넣고 `node src/cli.ts skill-links`를 돌린다. 같은 이름의 `.agents/skills/common-<업무>` 링크(정션)와 Antigravity용 `.agents/skills.json`이 생긴다.
- 비서 폴더 `.agents/skills/`에는 비서 자신의 운영 스킬(위임, 정리, 일정 등)만 실제 폴더로 둔다. `.claude/skills`는 `.agents/skills`를 가리키는 링크(정션) 하나다(공간도 같은 구조, 링크는 `skill-links`·`workspace-links`가 만든다).

## 폴더 구성 (agentskills.io 사양)
- SKILL.md(500줄 미만)에는 원칙과 "언제 어느 파일을 읽을지"만 둔다.
- 세부(사례, 예외, 목록)는 `references/`, 스킬이 쓰는 코드는 `scripts/`, 템플릿·설정·데이터는 `assets/`에 둔다.
- 설치 상태 점검 `setup-check`가 사양을 검사한다.
- 남이 만든 설치본·가상환경은 `%USERPROFILE%\tools`에 두고 그 기준으로 찾는다.
