# 막힘 판별 상세

`scripts/unblock.py`의 `judge()`가 이 순서대로 본다. 앞에서 결론이 나면 뒤는 보지 않는다.

## 1. 상태 코드

| 코드 | 판정 | 뜻 |
|---|---|---|
| 429 | RATE_LIMITED | 너무 자주 요청함. **멈추고 간격을 벌린다.** 지문을 바꿔 다시 두드리지 않는다 |
| 401, 407 | AUTH | 로그인·프록시 인증이 필요하다. 다른 지문으로 해도 소용없다 |
| 404, 410 | NOT_FOUND | 주소가 틀렸거나 지워졌다. 아카이브를 본다 |
| 5xx | SERVER_ERROR | 한 번만 나중에 다시 해 본다 |
| 403, 406 등 | 본문을 더 본다 | WAF 챌린지 페이지가 403으로 오는 일이 많다 |

## 2. 확정 문구 (있으면 CHALLENGE)

정상 본문에는 거의 나오지 않는 WAF 흔적이다. 대소문자 무시.

- Cloudflare: `<title>Just a moment...</title>`, `cf-chl-`, `_cf_chl_opt`, `Attention Required! | Cloudflare`
- Akamai: `sec-if-cpt-container`, `Powered and protected by Akamai`
- F5/기타: `The requested URL was rejected`
- Imperva: `Request unsuccessful. Incapsula`
- DataDome: `captcha-delivery.com`
- PerimeterX(HUMAN): `px-captcha`
- 제목이 `Access Denied`

주의: `/cdn-cgi/challenge-platform/` 스크립트는 Cloudflare가 **정상 페이지에도** 넣는다. 그것만으로 차단이라 보지 않는다.

## 3. 의심 문구 (작은 페이지에서만 CHALLENGE?)

`access denied`, `checking your browser`, `verify you are human`, `are you a robot`, `unusual traffic`, `captcha`, `datadome`, `g-recaptcha`, `h-captcha`, `cf-turnstile`, `awswaf`, `perimeterx`, 한국어: `자동입력 방지`, `보안 확인`, `로봇이 아닙니다`, `비정상적인 접근`, `접근이 차단`, `접근 권한이 없`, `사용권한`, `권한이 없습니다`, `잠시 후 다시 시도`.

- 두 개 이상 나오거나, 페이지가 20KB 이하거나, 보이는 글자가 400자 미만이면 CHALLENGE?로 본다.
- 큰 페이지에 하나만 나오면 본문 언급으로 보고 넘어간다(기사, 문의 폼의 reCAPTCHA 등).
- 한국어 문구 목록은 우리가 고른 일반 표현이다. 실제 차단 화면과 맞춰 본 것은 쿠팡 '사용권한 없음' 한 건뿐이고, 나머지는 확인 안 됨. 새 문구를 보면 사례로 남긴다(SKILL.md 7절).

## 4. 응답 모양

- **JSON**: 비지 않은 JSON이면 작아도 성공이다(공개 API는 수백 바이트일 수 있다). `{}`·`[]`면 EMPTY_JSON.
- **RSS/Atom**: `<rss`, `<feed`로 시작하면 성공.
- **LOGIN**: `<input type="password">`가 있거나, 최종 주소에 `/login`, `/signin`, `/accounts/`, `nidlogin`, `/auth`, `sso.`가 있고 제목이 로그인류면.
- **JS_SHELL**: 보이는 글자(스크립트·스타일 제외) 200자 미만인데 `<div id="root|app|__next|__nuxt"></div>`나 script 3개 이상, 또는 "enable JavaScript" 문구.
- **FRAME_SHELL**: 보이는 글자 500자 미만이고 `<frameset>`이나 iframe 1~3개만 있다. 데스크톱 `blog.naver.com`이 이렇다(2026-11-02 확인: 2,852B, 보이는 글자 0, iframe 1개).
- **BLOCKED**: 위에 안 걸린 4xx(403·406 등).
- **EMPTY**: 보이는 글자 100자 미만이면 **바이트 크기와 상관없이** 실패로 본다. 큰 페이지도 글자가 없으면 껍데기다(2026-11-02 확인: `www.reddit.com/r/ClaudeAI/`가 200, 8,417B, 보이는 글자 0, script 1개, 제목 "Reddit" — JS_SHELL 조건(script 3개 이상·root div)에 안 걸려 예전에는 OK로 잘못 나왔다). 짧은 차단 문구 페이지는 앞의 CHALLENGE?에서 먼저 걸린다.
- **TOO_SMALL**: 3,000바이트 미만이면서 `</html>`·`</body>`로 끝나지 않음(글자가 100자 이상이어도). example.com(577B, 보이는 글자 156자)은 완결된 페이지라 OK.

판정 순서: 상태 코드 → 확정 문구 → JSON·피드 → LOGIN → JS_SHELL → 의심 문구(CHALLENGE?) → FRAME_SHELL → BLOCKED → EMPTY → TOO_SMALL → SUSPECT → OK.

JS_SHELL·FRAME_SHELL·BLOCKED·EMPTY·TOO_SMALL에서는 최종 주소가 알려진 사이트(Reddit, X, 유튜브, GitHub, HN, arXiv, 위키백과, 네이버 블로그 등)면 `next` 맨 앞에 "먼저 공개 경로: …"로 `alt`의 공개 경로 1~2개를 붙인다(예: Reddit → `https://www.reddit.com/r/ClaudeAI.rss`). `judge`로 저장 파일을 볼 때는 `--url`을 줘야 붙는다.
- **SUSPECT**: Akamai `_abck` 쿠키 값에 `~-1~`가 있으면 센서가 안 풀린 상태다. 본문이 원하는 내용인지 눈으로 확인한다.

크기는 글자 수가 아니라 **바이트**로 잰다(한글은 글자당 3바이트).

## 5. 원하는 내용이 있는가

판정이 OK여도 원하는 것이 실제로 있는지 본다. 상품이면 가격, 기사면 본문 문단, 목록이면 항목 수.
가장 확실한 증거는 "있어야 할 요소"(예: 상품 카드, `article p`)가 실제로 있는 것이다.

## 6. WebFetch 결과에서

WebFetch는 원문 대신 요약을 준다. 다음 답이면 막힌 것으로 친다:
"페이지에 내용이 없다", "JavaScript가 필요하다", "로그인이 필요하다", "Access Denied", "보안 확인", 403/429 오류, 제목만 있고 본문 언급이 없음.

## 7. Ego Lite 화면에서

```js
// 판정용 원문을 작업 폴더에 저장 → run.ps1 judge로 판정
const fs = await import("node:fs/promises");
const html = await page.evaluate(() => document.documentElement.outerHTML);
await fs.writeFile("C:/<작업폴더>/raw/page.html", html, "utf8");
console.log({ url: await page.url(), title: await page.title(), bytes: html.length });
```

간단히 볼 때는 화면 제목과 보이는 글자 수만:

```js
console.log(await page.evaluate(() => ({
  title: document.title,
  textChars: (document.body?.innerText || "").trim().length,
  password: !!document.querySelector("input[type=password]"),
  iframes: [...document.querySelectorAll("iframe")].map((f) => f.src).slice(0, 5),
})));
```

---
판정 문구와 단계 구성의 일부는 insane-search(`engine/validators.py`, MIT, © 2026 fivetaku)를 참고해 우리 말로 다시 썼다.
