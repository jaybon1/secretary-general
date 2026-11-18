# 주소 바꾸기 · 메타정보 · 아카이브 · 지문 흉내

브라우저 없이 해 볼 것들이다. 한 사이트에 몇 번만 시도하고, 안 되면 Ego Lite로 넘어간다.

## 1. 주소 바꾸기 규칙

| 규칙 | 예 | 언제 |
|---|---|---|
| `www.` → `m.` | `www.example.com/a` → `m.example.com/a` | 서버에서 다 그려 주는 모바일판이 있는 사이트 |
| 도메인 앞에 `m.` | `example.com/a` → `m.example.com/a` | 하위 도메인 없는 주소 |
| 하위 도메인 앞에 `m.` | `blog.x.com/a` → `m.blog.x.com/a` | 포털형(blog./cafe./kin.). 데스크톱은 frame 껍데기, 모바일은 본문 |
| `www.` 빼기 | `www.example.com` → `example.com` | 가끔 www만 막는 곳 |
| AMP | HTML의 `<link rel="amphtml" href=…>` | 언론사. 가볍고 JS가 적다 |
| 피드 | `<link rel="alternate" type="application/rss+xml">` | 블로그·언론사 |
| frame `src` 직접 | 껍데기 안 iframe의 `src` | FRAME_SHELL일 때 |

- 모바일판이 오히려 JS 껍데기만 주는 사이트도 있다. 받은 뒤 반드시 판정한다.
- `run.ps1 fetch <URL> --variants`가 위 1~4번을 2초 간격으로 차례로 받고, 성공하면 멈춘다.

## 2. 네이버 계열

| 대상 | 바꾼 주소 | 확인 |
|---|---|---|
| 블로그 글 | `blog.naver.com/<id>/<logNo>` → `m.blog.naver.com/<id>/<logNo>` | 2026-11-02: 데스크톱 2,852B 껍데기(iframe 1개) → 모바일 25,719B |
| 블로그 글(쿼리형) | `blog.naver.com/PostView.naver?blogId=<id>&logNo=<n>` → `m.blog.naver.com/<id>/<n>` | 확인 안 됨 |
| 블로그 최근 글 | `https://rss.blog.naver.com/<id>.xml` | 2026-11-02: `naverofficial` 99KB RSS |
| 카페·지식iN·뉴스 등 | 호스트 앞에 `m.` | 확인 안 됨. 카페는 회원 공개 글이 많아 로그인 필요 |

- Claude in Chrome은 네이버 계열을 **확장 자체 제한**으로 열지 않는다. 사이트가 막은 것이 아니므로 Ego Lite나 위 주소로 간다.
- 네이버 지도·쇼핑은 브라우저가 필요할 때가 많다(`ego-lite.md`, `cases.md`).

## 3. 메타정보 건지기

본문이 막히거나 JS 껍데기여도 `<head>`에 정보가 남아 있는 경우가 많다. `run.ps1 meta <파일|URL>`.

- **OGP**: `og:title`, `og:description`, `og:image`, `og:url`, `article:published_time`, `twitter:*`
- **JSON-LD**(`<script type="application/ld+json">`): 가장 쓸모가 크다.
  - `NewsArticle`/`ReportageNewsArticle`: `headline`, `datePublished`, `author`, 가끔 `articleBody`
  - `Product`: `name`, `offers.price`, `offers.priceCurrency`, `aggregateRating`
  - `ItemList`/`CollectionPage`: 검색·목록 페이지의 항목
  - `Person`, `Organization`, `BreadcrumbList`
- **Next.js**: `<script id="__NEXT_DATA__">`의 JSON, App Router는 `self.__next_f.push(...)` 조각에 본문이 들어 있다.
- 보고서에는 "메타정보만 확인(본문 미확인)"이라고 적는다. 메타 설명은 사이트가 쓴 홍보 문구일 수 있다.
- Ego Lite에서도 같다: `page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent))`.

## 4. 아카이브

- 있는지 확인: `https://archive.org/wayback/available?url=<URL>` → `archived_snapshots.closest.url`
- 원본 그대로(툴바 없음): `https://web.archive.org/web/2id_/<URL>` (가장 최근 본으로 이동). `id_` 없이 열면 툴바가 붙어 FRAME_SHELL처럼 보인다(2026-11-02 확인).
- 목록: `https://web.archive.org/cdx/search/cdx?url=<URL>&output=json&limit=5`
- archive.today(`archive.ph/newest/<URL>`)는 자주 캡차를 띄운다. 캡차가 나오면 거기서 멈춘다.
- **유료 기사를 아카이브로 읽지 않는다.** 유료벽을 넘는 접근은 사이트가 자동 접근으로 보고 막을 수 있기 때문이다. 지워진 공개 글, 바뀌기 전 판을 볼 때만 쓴다. 보고서에 아카이브 날짜를 적는다.

## 5. 지문 흉내로 다시 받기 (curl_cffi)

WebFetch·일반 HTTP 라이브러리는 TLS·HTTP/2 지문이 브라우저와 달라 봇으로 걸리는 일이 있다. curl_cffi는 크롬·사파리 지문을 흉내 낸다.

- **약관 위험**: 많은 사이트가 자동 접속을 약관으로 금지한다. 지문 흉내는 그 판정을 피하는 방법이라 위반이 될 수 있다. 공개 페이지를 몇 번 읽는 데만 쓰고, 로그인·유료 영역에는 쓰지 않는다.
- `run.ps1 fetch <URL>`(기본 `--as chrome`), 안 되면 `--as safari` 한 번. 비교용으로 `--as plain`.
- 2026-11-02 확인: `reddit.com/r/programming/`은 plain이면 403 "Blocked", 공개 피드 `.rss`는 chrome 지문으로 200.
- CHALLENGE(확정 문구)가 나오면 지문·Referer를 바꿔 가며 계속 두드리지 않는다. Ego Lite로 넘어간다.
- 429면 멈춘다. 도구는 한 번 실행에 최대 6번, 2초 간격으로만 보낸다.

## 6. 제3자 리더 (기본은 안 씀)

`r.jina.ai/<URL>` 같은 리더 서비스는 대상 주소를 제3자에게 넘긴다. 공개 주소이고 다른 방법이 다 막혔을 때만, 사용자가 괜찮다고 한 경우에 쓴다. 보고서에 썼다고 적는다.

---
주소 바꾸기 규칙과 메타정보 항목의 일부는 insane-search(`engine/url_transforms.py`, `references/metadata.md`, MIT, © 2026 fivetaku)를 참고해 우리 말로 다시 썼다.
