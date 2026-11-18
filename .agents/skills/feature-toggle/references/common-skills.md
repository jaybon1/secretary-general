# 공통 스킬 (`common-skills`, 처음부터 켜짐)

작업 공간과 비서가 함께 쓰는 쓰는 법을 공통 스킬(`workspaces\_skills\common-<이름>\`)로 둔다. 배포판이 싣는 공통 스킬(비서 프로그램 부르기 `common-secretary-programs`, Windows 셸 주의사항 `common-windows-shell`, 웹 조사 `common-web-research`, 막힌 페이지 읽기 `common-web-unblock`, 미리보기 페이지 `common-local-preview-pages`)은 비서 폴더 `common-skills\`에 있고, `node src/cli.ts skill-links`·`workspace-links`가 `workspaces\_skills`에 아직 없는 것만 복사해 깐다(이미 있는 같은 이름 폴더는 덮지 않는다). 비서 폴더가 쓰는 공통 스킬은 비서 폴더 맨 위 `common-skills.json`의 목록대로 `.agents/skills/common-<이름>` 링크로 붙는다. 공간 규칙(AGENTS.md)은 앞의 셋을 늘 가리키고, 작업 공간에는 앞의 둘이 목록과 상관없이 붙는다.

## 쓰려면(사용자가 할 일)

없다. 설치(`node src/cli.ts skill-links`)와 업데이트 마무리가 깐다. `_skills`의 공통 스킬은 고쳐도 된다. 업데이트가 사용자가 안 고친 파일은 새 판으로, 사용자만 고친 파일은 그대로 두고, 양쪽이 다 고친 파일은 묻는다. 비서 폴더 `common-skills\`는 설치 원본이라 고치지 않는다.

## AGENTS.md에 넣을 글

없다(공간 규칙은 비서 코드가 쓴다).

## 끄는 순서

이 기능에는 따로 켜고 끌 점검·알림·예약 작업이 없다. `"enabled": false`로 두어도 `_skills`의 공통 스킬과 링크는 그대로 둔다: 공간 규칙이 공통 스킬을 이름과 전체 경로로 가리키므로, 지우면 업무 세션이 비서 프로그램 부르는 법을 못 읽는다. 비서 폴더에서만 쓰지 않으려면 `common-skills.json`의 목록에서 그 이름을 빼고 `node src/cli.ts skill-links`를 돌린다.
