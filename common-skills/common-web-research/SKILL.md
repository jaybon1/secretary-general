---
name: common-web-research
description: Ego Lite로 공개 웹 페이지를 열어 원문을 저장하고 숫자를 근거와 함께 모으는 조사 절차, 연 페이지를 근거 txt로 남기는 비서 프로그램(ego-grab) 쓰는 법, 여러 페이지·원본을 연달아 받을 때의 주의사항(회차 파일, 로그, 앞 페이지 섞임, 429, 수집 금지 사이트).
---

# 웹 조사 (Ego Lite)

Ego Lite(`ego-browser` 명령)가 설치돼 있을 때 쓴다. 없으면 검색·페이지 읽기 도구(WebSearch·WebFetch)로 읽고, 보고서에 "원문 미저장(WebFetch 요약)"으로 표시한다.

## 절차

- Ego 스크립트는 `.mjs` 파일로 쓰고 `ego-browser nodejs -e "await import('file:///...')"`로 돌린다. 회차마다 새 파일(`round-NN-<내용>.mjs`)로 둔다.
  이유: 이전 회차 결과와 섞이지 않게 하기 위해서다.
- URL마다 제한시간을 두고, 진행 상황과 실패는 화면 출력 대신 로그 파일(`run.log`)에 덧붙여 쓴다.
  이유: 백그라운드 실행에서는 화면 출력이 비어 남지 않는다.
- 저장하는 원문 맨 위에 `URL:`, 최종 URL, 제목, `FETCHED:`(KST 시각)를 적는다.
  이유: 보고서의 숫자마다 출처 URL과 확인 시각을 파일 단위로 댈 수 있게 한다.

## 연 페이지를 근거로 남기기 (ego-grab)

조사에서 연 페이지는 비서 프로그램 `ego-grab.mjs`의 `grab`으로 본문을 txt로 저장해 근거로 남긴다. 이유: 확인 담당과 비서가 보고서의 주장을 원문과 대조할 수 있다.

- 회차 파일(`round-NN-<내용>.mjs`)에 아래처럼 쓰고 `ego-browser nodejs -e "await import('file:///<그 파일 전체 경로>')"`로 돌린다.

  ```js
  import { grab } from "file:///<bin>/ego-grab.mjs";
  await grab(
    [{ name: "remotion-license", url: "https://..." }, { name: "pricing", url: "https://...", max: 40000 }],
    { out: "<업무 폴더>/pages", space: "<업무 이름>" },
  );
  ```

- `<bin>`은 비서 진입점 폴더의 실제 전체 경로로 펼쳐 쓴다(공간 맨 위 `secretary-link.local.json`의 `bin` 값, 역슬래시는 `/`로). 이유: Ego Lite 안의 node(`ego-browser nodejs`)는 환경변수를 받지 못하고, 업무 세션은 비서 폴더의 다른 파일(`scripts/…`)을 부를 수 없다(찾는 법은 `common-secretary-programs` 스킬).
- 항목마다 `name`(저장 파일 이름, 확장자 빼고), `url`, `max`(저장할 글자 수, 기본 20000)를 준다. `out` 폴더에 `<name>.txt`로 저장되고, 머리에 `URL:`·`FINAL:`(최종 URL)·`TITLE:`·`FETCHED:`(KST 시각)가 붙는다. `space`는 Ego Lite 작업 공간(TaskSpace) 이름이다.
- 본문 상자(article·main 등)의 글이 300자 이하이면 페이지 전체 글을 저장한다. 화면에는 항목마다 `ok <name> <글자 수>`나 `FAIL <name>: <오류>`가 찍히니, 회차마다 로그 파일로 받아 FAIL만 다시 받는다.
- `grab`은 페이지마다 about:blank를 거치고, load 시간 초과라도 "navigation committed"면 본문을 읽어 저장한다(아래 주의사항의 두 경우). 직접 받기 스크립트를 쓸 때만 이 처리를 따로 넣는다.

## 주의사항

- Ego Lite로 여러 페이지를 연달아 받아 저장할 때는 페이지마다 about:blank를 거치고, 저장한 파일 머리의 제목(TITLE)이 파일 이름과 맞는지 확인한다.
  이유: `goto`가 실패(ERR_ABORTED)하면 앞 페이지 본문이 저장될 수 있다.
- Ego Lite `page.goto`가 광고 때문에 load 시간 초과로 끝나도 오류 글에 "navigation committed"가 있으면 본문은 떠 있으니 실패로 넘기지 말고 본문을 읽어 저장한다. `ego-grab`의 `grab`(위 절)은 이 경우와 about:blank 거치기, `FETCHED:`를 이미 처리하니, 직접 받기 스크립트를 쓸 때만 이 처리를 넣는다.
  이유: 광고 많은 언론 페이지 한 회차 41개 중 FAIL 12개의 11개가 이 경우였고, committed 처리로 다시 받자 모두 저장됐다.
- 구글 이미지(udm=2)·네이버 이미지 검색 결과 화면은 페이지를 연 같은 `ego-browser nodejs` 프로세스에서 찍으면(`page.screenshot()`·`Page.captureScreenshot`) 30~40초 뒤 시간 초과로 멈춘다(제목·본문 읽기는 된다). 그래서 "열기 프로세스 1번 + 찍기 프로세스 최대 3번"으로 나눈다. 찍기 프로세스는 `page.cdp("Page.bringToFront")` 뒤 `page.cdp("Page.captureScreenshot", {format:"jpeg", quality:92}, {timeout:25000})`를 부르고, 실패하면 프로세스를 끝내고 새로 띄워 다시 찍는다(보통 두 번째 프로세스에서 찍힌다). 로그인된 프로필이면 오른쪽 위 계정 머리글자 원이 찍히므로 쓰기 전에 흐린다.
  이유: 같은 프로세스에서 다시 시도하면 매번 멈춰 9쪽에 6분을 썼다(2026-11-15, 7쪽 모두 같은 꼴).
- 위키미디어 원본을 연달아 받으면 429가 난다. 기다렸다 다시 받는다.
- Reddit은 자동 수집하지 않는다(정책상 승인 없는 API·수집 금지, 브라우저 자동 조회 포함). 링크를 사람에게 넘겨 사람이 본다. 다시 넣으려면 API 승인부터 받는다.
