# Ego Lite에서 막혔을 때

먼저 `ego-browser skill`을 실행하고 그 출력을 따른다. 아래는 그 API(v2.2.0 기준) 이름에 맞춘 예시다.
PowerShell에서는 heredoc이 없으니 아래 코드를 UTF-8 `.mjs` 파일(작업 폴더 안, 라운드마다 새 파일)로 쓰고 이렇게 부른다:

```powershell
ego-browser nodejs -e "await import('file:///C:/<작업폴더>/ego/round-01.mjs')"
```

- TaskSpace는 일 하나에 하나. 막혔다고 새 공간을 만들지 않는다. 이름으로 다시 잡는다: `await taskSpace("<일 이름>")`.
- 한 라운드 끝에 snapshot을 찍어 다음 라운드가 바로 쓰게 한다.

## 1. 사람처럼 들어가기 (홈 → 검색창)

검색 결과·목록 주소로 바로 가면 막히는 사이트가 있다(쿠팡, 2026-10-23). 홈에서 검색창에 입력하면 통과했다.

```js
const task = await taskSpace("coupang-price-20261102");
const page = task.page("p1");
await page.goto("https://www.coupang.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500 + Math.random() * 1500);      // 홈에서 잠깐 머문다
console.log(await page.snapshot());                         // 검색창 ref를 찾는다
```

```js
// 다음 라운드: 앞 snapshot에서 찾은 검색창 ref를 쓴다
const task = await taskSpace("coupang-price-20261102");
const page = task.page("p1");
await page.click("@15", { label: "검색창 클릭" });
await page.keyboard.type("무선 키보드", { delay: 120 });     // 한 글자씩 입력
await page.waitForTimeout(600);
await page.keyboard.press("Enter");
await page.waitForLoadState("domcontentloaded");
console.log({ url: await page.url(), title: await page.title() });
console.log(await page.snapshot());
```

- 한국어 입력은 `.mjs` 파일 안에만 둔다(`-e` 인자에 넣지 않는다).
- 통과 여부는 결과 목록이 보이는지로 판단한다. 다시 '사용권한 없음'이면 한 번만 천천히 반복하고, 그래도 막히면 handOff.

## 2. 천천히·기다리기

- 고정 지연보다 상태를 기다린다: `waitForSelector("loc=css:.result-item", { state: "visible" })`, `waitForURL`, `waitForFunction`.
- 페이지 이동 사이에는 1~3초 둔다. 같은 사이트에서 페이지를 짧은 간격으로 여러 개 열지 않는다.
- 아래까지 있는 목록은 `page.mouse.wheel(0, 600, { label: "목록 내리기" })`로 조금씩 내리고 기다린다. 또는 `snapshot({ scope: "full_page" })`.
- `goto`에 `referer`를 줄 수 있다(같은 사이트 홈 주소 정도). 남의 사이트인 척하는 Referer는 쓰지 않는다(사이트가 속인 것을 알아채면 자동 접근으로 보고 막을 수 있기 때문이다).

## 3. iframe은 그 부분만

네이버 지도 목록처럼 iframe 안에 내용이 있으면 전체 snapshot에서 잘 안 보인다. `iframe` 줄의 ref로 그 부분만 뜬다.

```js
const page = (await taskSpace("naver-map-20261102")).page("p1");
const snap = await page.snapshot();
console.log(snap);                                          // "iframe ... @12" 같은 줄을 찾는다
```

```js
const page = (await taskSpace("naver-map-20261102")).page("p1");
console.log(await page.snapshot({ scope: "subtree", root: "@12" }));
```

- subtree에서 받은 ref로 iframe 안을 클릭한다. 다른 선택자는 여전히 바깥 문서를 먼저 찾는다.
- 대량 추출이 필요하면 `page.evaluate`는 바깥 문서에서 돈다. 같은 출처 iframe이면 `document.querySelector("iframe").contentDocument`로 읽을 수 있다(다른 출처면 안 됨).

## 4. 막힘 판별

```js
const page = (await taskSpace("<일 이름>")).page("p1");
const fs = await import("node:fs/promises");
const html = await page.evaluate(() => document.documentElement.outerHTML);
await fs.mkdir("C:/<작업폴더>/raw", { recursive: true });
await fs.writeFile("C:/<작업폴더>/raw/p1.html", html, "utf8");
console.log({ url: await page.url(), title: await page.title() });
```

그다음 PowerShell에서 `& $wu judge "C:\<작업폴더>\raw\p1.html" --url "<위 url>"`. 판정 기준은 `detect.md`.
화면으로 보는 편이 빠르면 `page.screenshot()` 한 번.

## 5. 팝업·알림 권한·대화상자

- **브라우저가 띄우는 권한 창(알림·위치·기기 선택)은 사용자 몫이다.** 누르거나 닫아서 피해 가지 않는다.
- 알림 권한 창이 뜨는 사이트는 조사 순서 **맨 뒤**에 연다. 그 창 때문에 진행이 막히면:
  1. `await task.handOff()` 후 라운드를 끝내고 사용자에게 "권한 창을 처리해 달라"고 알린다. 또는
  2. 공개 페이지면 WebFetch로 대신 읽고 보고서에 "원문 미저장(WebFetch 요약)"이라고 적는다.
- 페이지의 JS `alert/confirm`은 `receipt.dialog`나 `page.info()`에 나온다. 내용을 읽고 작업에 맞게 `acceptDialog()`/`dismissDialog()`로 처리한다(이건 페이지 대화상자라 권한 창과 다르다).
- 사이트 자체 레이어 팝업(광고·쿠키 동의)은 화면 요소다. 닫기 버튼을 누르는 것은 괜찮지만, 동의 내용을 사용자 대신 정하지 않는다(필요한 최소 선택만, 애매하면 묻는다).

## 6. 자동화 흔적 확인 (확인만)

사이트가 왜 막는지 짐작할 때 값을 **읽기만** 한다. 덮어쓰거나 숨기는 코드는 쓰지 않는다.

```js
const page = (await taskSpace("<일 이름>")).page("p1");
console.log(await page.evaluate(() => ({
  webdriver: navigator.webdriver,               // true면 자동화 표시가 켜진 것
  userAgent: navigator.userAgent,
  languages: navigator.languages,
  platform: navigator.platform,
  plugins: navigator.plugins.length,
  hardwareConcurrency: navigator.hardwareConcurrency,
  hasChromeObj: typeof window.chrome === "object",
  suspiciousGlobals: Object.keys(window).filter((k) => /^(cdc_|__playwright|__pw|__selenium|_phantom|callPhantom)/.test(k)),
  visibility: document.visibilityState,
})));
```

- 결과는 보고서·사례에 적기만 한다. 사람이 보는 실제 창이라 대개 사람 브라우저와 같게 나온다.
- Ego Lite는 페이지 쪽에 CDP 콘솔을 숨긴다. `page.cdp("egoAutomated.disable")`는 디버깅할 때만 쓰고, 끄면 사이트가 CDP를 알아챌 수 있다.

## 7. 캡차·보안 확인이 떴을 때

```js
const task = await taskSpace("<일 이름>");
console.log({ spaceId: task.spaceId, url: await task.page("p1").url() });
await task.handOff();
// 여기서 라운드를 끝낸다. finish()를 부르지 않는다(사용자가 캡차를 푸는 동안 작업 공간이 살아 있어야, 끝난 뒤 takeOverTaskSpace(spaceId)로 이어 받을 수 있다).
```

사용자에게: 어느 사이트, 어떤 창(캡차/보안 확인), 끝나면 알려 달라는 말. 사용자가 끝냈다고 하면:

```js
const task = await takeOverTaskSpace(<spaceId>);
const userPage = task.userPage();
// 라벨이 없으면 adopt
```

- 네이버 쇼핑은 사용자가 한 번 풀면 홈·검색 주소 모두 한동안 통과했다. 그 사이에 필요한 것을 한꺼번에 본다(그래도 천천히).
- 캡차가 또 뜨면 또 넘긴다. 반복되면 그 사이트는 멈추고 보고한다.

## 8. Claude in Chrome으로 넘길 때

Ego Lite에서 안 되고 사용자 Chrome 세션이 필요할 때만. 네이버 계열은 Claude in Chrome이 확장 자체 제한으로 열지 않으니 넘기지 않는다.
