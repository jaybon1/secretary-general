"""web-unblock 도구: 막힘 판별, 메타정보 추출, 대체 주소 목록, curl_cffi 재요청.

실행은 run.ps1을 거친다(Python은 %USERPROFILE%\\tools\\web-unblock-venv, 바꿀 때는 환경변수 WEB_UNBLOCK_PYTHON). 직접 부를 때:
  <python> -I unblock.py judge  <파일|->              저장된 HTML(WebFetch·Ego Lite 결과)을 판정
  <python> -I unblock.py meta   <파일|URL>            OGP·JSON-LD·제목·피드 링크 추출
  <python> -I unblock.py alt    <URL>                 시도해 볼 대체 주소 목록(요청 안 보냄)
  <python> -I unblock.py fetch  <URL> [--as chrome|safari|firefox|plain]
                                      [--variants] [--save 파일] [--text N]
판정 기준은 references/detect.md, 대체 주소는 references/public-routes.md·url-rewrite.md.
표준 라이브러리 + curl_cffi(fetch에서만)만 쓴다. 한 번 실행에 요청은 최대 6번, 사이 2초.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import re
import socket
import sys
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

# ---- 설정(바꿀 일이 있으면 여기만) ---------------------------------------
DELAY_SEC = 2.0            # 주소 바꿔 가며 받을 때 요청 사이 간격
MAX_REQUESTS = 6           # 한 번 실행에서 보내는 요청 수 상한
TIMEOUT_SEC = 20
TEXT_EXCERPT = 600         # 화면에 보여 줄 본문 글자 수 기본값
ACCEPT_LANG = "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 콘솔 한글 깨짐 방지
except Exception:
    pass

# ---- 판정용 문구 ------------------------------------------------------------
# 확정 문구: 정상 페이지 본문에는 거의 나오지 않는 WAF·챌린지 흔적.
HARD_MARKERS = [
    "<title>just a moment...</title>", "cf-chl-", "_cf_chl_opt",
    "attention required! | cloudflare", "sec-if-cpt-container",
    "powered and protected by akamai", "the requested url was rejected",
    "request unsuccessful. incapsula", "<title>access denied</title>",
    "captcha-delivery.com", "px-captcha",
]
# 주의: cdn-cgi/challenge-platform 스크립트는 Cloudflare가 정상 페이지에도 넣으므로 확정 문구에서 뺐다.
# 의심 문구: 기사 등 정상 본문에도 나올 수 있다. 작은 페이지에서만 결정적.
SOFT_MARKERS = [
    "access denied", "checking your browser", "verify you are human",
    "are you a robot", "unusual traffic", "captcha", "datadome", "g-recaptcha", "h-captcha",
    "cf-turnstile", "awswaf", "perimeterx", "자동입력 방지", "보안 확인",
    "로봇이 아닙니다", "비정상적인 접근", "접근이 차단", "접근 권한이 없",
    "사용권한", "권한이 없습니다", "잠시 후 다시 시도",
]
LOGIN_URL_HINTS = ["/login", "/signin", "/sign-in", "/accounts/", "nidlogin", "/auth", "sso."]
LOGIN_TEXT_HINTS = ["로그인", "sign in", "log in", "로그인이 필요", "login required"]
SPA_ROOT_RE = re.compile(
    r'<div[^>]+id=["\'](root|app|__next|__nuxt|svelte)["\'][^>]*>\s*</div>', re.I)

SMALL_BYTES = 3000
EMPTY_TEXT = 100           # 보이는 글자가 이보다 적으면 크기와 상관없이 OK로 보지 않는다
SOFT_DECISIVE_MAX = 20000


SKIP_TAGS = ("script", "style", "noscript", "template")


class PageScan(HTMLParser):
    """HTML 한 번 훑어서 판정·추출에 필요한 것만 모은다."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta: dict[str, str] = {}
        self.ldjson: list[str] = []
        self.links: dict[str, str] = {}
        self.frames: list[str] = []
        self.scripts = 0
        self.password_inputs = 0
        self.forms = 0
        self.text_parts: list[str] = []
        self._skip = 0          # script/style/noscript/template 안쪽 깊이
        self._in_title = False
        self._ld = False
        self._ld_buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag in SKIP_TAGS:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and "content" in a:
                self.meta.setdefault(key, a["content"].strip())
        elif tag == "link":
            rel = a.get("rel", "").lower()
            typ = a.get("type", "").lower()
            if rel in ("canonical", "amphtml"):
                self.links.setdefault(rel, a.get("href", ""))
            elif rel == "alternate" and ("rss" in typ or "atom" in typ):
                self.links.setdefault("feed", a.get("href", ""))
            elif rel == "alternate" and "oembed" in typ:
                self.links.setdefault("oembed", a.get("href", ""))
        elif tag == "script":
            self.scripts += 1
            if "ld+json" in a.get("type", "").lower():
                self._ld, self._ld_buf = True, []
        elif tag in ("iframe", "frame"):
            self.frames.append(a.get("src", ""))
        elif tag == "input" and a.get("type", "").lower() == "password":
            self.password_inputs += 1
        elif tag == "form":
            self.forms += 1

    def handle_endtag(self, tag):
        if tag == "script" and self._ld:
            self.ldjson.append("".join(self._ld_buf))
            self._ld = False
        if tag in SKIP_TAGS and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._ld:
            self._ld_buf.append(data)
            return
        if self._in_title:
            if not self.title:
                self.title = data.strip()
        elif not self._skip:
            s = data.strip()
            if s:
                self.text_parts.append(s)

    @property
    def text(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.text_parts)).strip()


def scan(html: str) -> PageScan:
    p = PageScan()
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    return p


def _hits(markers, low):
    return [m for m in markers if m in low]


def judge(body: str, status: int = 200, final_url: str = "", ctype: str = "",
          cookies: dict | None = None) -> dict:
    """본문을 보고 판정. verdict와 이유, 다음에 할 일을 돌려준다."""
    raw = body.encode("utf-8", "ignore")
    size = len(raw)
    low = body.lower()
    r = {"verdict": "OK", "status": status, "bytes": size, "reasons": []}

    def done(v, why, nxt):
        r.update(verdict=v, next=nxt)
        r["reasons"].append(why)
        return r

    if status == 429:
        return done("RATE_LIMITED", "status=429", "멈추고 간격을 벌린다. 같은 주소 반복 금지")
    if status in (401, 407):
        return done("AUTH", f"status={status}", "로그인 필요. Ego Lite(사용자 로그인 상태)로")
    if status in (404, 410):
        return done("NOT_FOUND", f"status={status}", "주소 확인. 아카이브 검색")
    if status >= 500:
        return done("SERVER_ERROR", f"status={status}", "잠시 뒤 한 번만 다시. 또는 아카이브")
    if status == 0:
        return done("NO_RESPONSE", "응답 없음", "연결 문제. 다른 단계로")

    hard = _hits(HARD_MARKERS, low)
    if hard:
        return done("CHALLENGE", "hard:" + ",".join(hard[:3]),
                    "브라우저 없는 재시도 그만. 공개 경로 → Ego Lite. 캡차면 handOff")
    if cookies and "~-1~" in cookies.get("_abck", ""):
        r["reasons"].append("akamai _abck 미해결")

    stripped = body.lstrip()[:1]
    if "json" in ctype or stripped in ("{", "["):
        try:
            obj = json.loads(body)
            if obj in (None, {}, [], ""):
                return done("EMPTY_JSON", "JSON이 비었음", "파라미터 확인")
            r["reasons"].append("json")
            r["next"] = "그대로 쓴다"
            return r
        except Exception:
            pass
    if "<rss" in low[:2000] or "<feed" in low[:2000]:
        r["reasons"].append("feed xml")
        r["next"] = "그대로 쓴다"
        return r

    p = scan(body)
    text = p.text
    r.update(title=p.title, text_chars=len(text), scripts=p.scripts, frames=len(p.frames))

    fu = final_url.lower()
    if p.password_inputs or any(h in fu for h in LOGIN_URL_HINTS):
        if p.password_inputs or len(text) < 3000:
            why = "password 입력칸" if p.password_inputs else f"로그인 주소로 이동: {final_url}"
            if any(h in (p.title or "").lower() for h in LOGIN_TEXT_HINTS) or p.password_inputs:
                return done("LOGIN", why, "Ego Lite(사용자 로그인 상태). 로그인 대신 해 주지 않음")

    routes = _route_hint(final_url)
    if len(text) < 200 and (SPA_ROOT_RE.search(body) or p.scripts >= 3 or "enable javascript" in low):
        return done("JS_SHELL", f"보이는 글자 {len(text)}자, script {p.scripts}개",
                    routes + "meta로 OGP·JSON-LD 건지기 → 공개 API/모바일판 → Ego Lite")

    soft = _hits(SOFT_MARKERS, low)
    if soft and (len(soft) >= 2 or size <= SOFT_DECISIVE_MAX or len(text) < 400):
        return done("CHALLENGE?", "soft:" + ",".join(soft[:3]),
                    "차단 의심. 화면 문구 확인 후 공개 경로 → Ego Lite")
    if soft:
        r["reasons"].append("본문 언급 정도: " + soft[0])

    if p.frames and len(text) < 500 and ("<frameset" in low or len(p.frames) <= 3):
        return done("FRAME_SHELL", "frame/iframe 껍데기: " + ", ".join(f[:80] for f in p.frames[:2]),
                    routes + "frame src를 직접 받거나 m. 주소(url-rewrite.md). Ego Lite면 subtree snapshot")
    if status >= 400:
        return done("BLOCKED", f"status={status}", routes + "공개 경로 → Ego Lite")
    if len(text) < EMPTY_TEXT:
        return done("EMPTY", f"보이는 글자 {len(text)}자({size}B, script {p.scripts}개) — 크기와 상관없이 본문 없음",
                    routes + "meta로 OGP·JSON-LD 건지기 → 공개 API/피드·모바일판 → Ego Lite(렌더링)")
    if size < SMALL_BYTES:
        complete = "</html>" in low or "</body>" in low
        if complete and len(text) >= 64:
            r["reasons"].append(f"작지만 완결된 페이지 {size}B")
        else:
            return done("TOO_SMALL", f"{size}B, 보이는 글자 {len(text)}자",
                        routes + "껍데기 의심. 다른 주소나 Ego Lite")
    if "akamai _abck 미해결" in r["reasons"]:
        r["verdict"] = "SUSPECT"
        r["next"] = "본문이 원하는 내용인지 눈으로 확인"
        return r
    r["next"] = "그대로 쓴다(원하는 내용이 실제로 있는지 한 번 확인)"
    return r


def _route_hint(url: str) -> str:
    """알려진 사이트면 공개 경로(예: Reddit .rss)를 next 앞에 붙일 문구로 만든다."""
    if not url:
        return ""
    try:
        known = [(l, u) for l, u in alt_urls(url)
                 if not l.startswith(("Wayback", "archive.today", "모바일(", "www 빼기"))
                 and "403" not in l]
    except Exception:
        return ""
    if not known:
        return ""
    return "먼저 공개 경로: " + "; ".join(f"{l} {u}" for l, u in known[:2]) + " → 안 되면 "


def extract_meta(html: str) -> dict:
    p = scan(html)
    og = {k: v for k, v in p.meta.items() if k.startswith(("og:", "article:", "product:", "twitter:"))}
    plain = {k: p.meta[k] for k in ("description", "author", "keywords") if k in p.meta}
    ld = []
    for blk in p.ldjson:
        try:
            ld.append(json.loads(blk.strip()))
        except Exception:
            ld.append({"_unparsed": blk.strip()[:300]})
    return {"title": p.title, "meta": plain, "og": og, "links": p.links,
            "jsonld": ld, "jsonld_types": _ld_types(ld)}


def _ld_types(ld) -> list[str]:
    out = []

    def walk(o):
        if isinstance(o, dict):
            t = o.get("@type")
            if t:
                out.extend(t if isinstance(t, list) else [t])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(ld)
    return sorted(set(map(str, out)))


# ---- 대체 주소 --------------------------------------------------------------
def _host(u):
    return (urlsplit(u).hostname or "").lower()


def _swap_host(u, h):
    s = urlsplit(u)
    return urlunsplit(s._replace(netloc=h + (f":{s.port}" if s.port else "")))


def host_variants(url: str) -> list[tuple[str, str]]:
    h = _host(url)
    out = []
    if h.startswith("www."):
        out.append(("모바일(www→m)", _swap_host(url, "m." + h[4:])))
        out.append(("www 빼기", _swap_host(url, h[4:])))
    elif h.count(".") == 1:
        out.append(("모바일(m. 붙이기)", _swap_host(url, "m." + h)))
    elif not h.startswith("m."):
        out.append(("모바일(sub→m.sub)", _swap_host(url, "m." + h)))
    return out


def alt_urls(url: str) -> list[tuple[str, str]]:
    h = _host(url)
    s = urlsplit(url)
    path = s.path.rstrip("/")
    enc = quote(url, safe="")
    out: list[tuple[str, str]] = []

    if h.endswith(("x.com", "twitter.com")):
        m = re.search(r"/status(?:es)?/(\d+)", url)
        if m:
            tid = m.group(1)
            out += [("X tweet-result(JSON)", f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&token=a"),
                    ("X oEmbed", f"https://publish.twitter.com/oembed?url=https://twitter.com/i/status/{tid}&omit_script=1"),
                    ("X 장문 보충(제3자 fxtwitter)", f"https://api.fxtwitter.com/i/status/{tid}")]
        else:
            handle = path.strip("/").split("/")[0] if path else ""
            if handle:
                out.append(("X 프로필 타임라인(syndication)",
                            f"https://syndication.twitter.com/srv/timeline-profile/screen-name/{handle}"))
    elif "reddit.com" in h or h == "redd.it":
        base = urlunsplit(("https", "www.reddit.com", path, "", ""))
        out += [("Reddit RSS", base + ".rss"), ("Reddit JSON(자주 403)", base + ".json")]
    elif "youtube.com" in h or h == "youtu.be":
        out += [("YouTube oEmbed", f"https://www.youtube.com/oembed?url={enc}&format=json"),
                ("자막: yt-dlp(명령)", f'python -m yt_dlp --skip-download --write-sub --write-auto-sub --sub-lang "ko,en" --sub-format vtt "{url}"')]
    elif h == "github.com":
        parts = path.strip("/").split("/")
        if len(parts) >= 2:
            o, r = parts[0], parts[1]
            out += [("GitHub API repo", f"https://api.github.com/repos/{o}/{r}"),
                    ("GitHub README(raw)", f"https://raw.githubusercontent.com/{o}/{r}/HEAD/README.md")]
            if len(parts) >= 4 and parts[2] in ("issues", "pull"):
                out.append(("GitHub API issue/PR", f"https://api.github.com/repos/{o}/{r}/issues/{parts[3]}"))
            if len(parts) >= 5 and parts[2] == "blob":
                out.append(("GitHub raw 파일", f"https://raw.githubusercontent.com/{o}/{r}/{'/'.join(parts[3:])}"))
    elif h == "news.ycombinator.com":
        m = re.search(r"id=(\d+)", url)
        if m:
            out.append(("HN Firebase item", f"https://hacker-news.firebaseio.com/v0/item/{m.group(1)}.json"))
            out.append(("HN Algolia item(댓글 트리)", f"https://hn.algolia.com/api/v1/items/{m.group(1)}"))
    elif h.endswith("arxiv.org"):
        m = re.search(r"/(?:abs|pdf|html)/([0-9]{4}\.[0-9]{4,5}|[a-z\-]+/[0-9]{7})", url)
        if m:
            out.append(("arXiv API(Atom)", f"https://export.arxiv.org/api/query?id_list={m.group(1)}"))
    elif h.endswith("wikipedia.org"):
        m = re.search(r"/wiki/([^?#]+)", url)
        if m:
            out.append(("Wikipedia 요약 REST", f"https://{h}/api/rest_v1/page/summary/{m.group(1)}"))
    elif h == "blog.naver.com":
        out.append(("네이버 블로그 모바일", _swap_host(url, "m.blog.naver.com")))
        q = dict(x.split("=", 1) for x in s.query.split("&") if "=" in x)
        parts = path.strip("/").split("/")
        if q.get("blogId") and q.get("logNo"):
            out.append(("네이버 블로그 모바일(쿼리형)", f"https://m.blog.naver.com/{q['blogId']}/{q['logNo']}"))
        elif len(parts) >= 1 and parts[0]:
            out.append(("네이버 블로그 RSS", f"https://rss.blog.naver.com/{parts[0]}.xml"))
    elif h.endswith("naver.com") and not h.startswith("m."):
        out.append(("네이버 모바일(m. 붙이기)", _swap_host(url, "m." + h)))

    if not out:  # 알려진 사이트 경로가 없을 때만 m.·www 바꾸기
        out += host_variants(url)
    out += [("Wayback 최근본 확인", f"https://archive.org/wayback/available?url={enc}"),
            ("Wayback 최근 원본(툴바 없음)", f"https://web.archive.org/web/2id_/{url}"),
            ("archive.today 검색(사람이 여는 용)", f"https://archive.ph/newest/{url}")]
    return out


# ---- 네트워크 ----------------------------------------------------------------
def _safe_target(url: str) -> None:
    s = urlsplit(url)
    if s.scheme not in ("http", "https") or not s.hostname:
        raise SystemExit(f"http(s) 주소만 받는다: {url}")
    try:
        for info in socket.getaddrinfo(s.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                raise SystemExit(f"내부망 주소는 받지 않는다: {s.hostname} → {ip}")
    except socket.gaierror as e:
        raise SystemExit(f"이름 풀이 실패: {s.hostname} ({e})")


def get(url: str, mode: str):
    _safe_target(url)
    headers = {"Accept-Language": ACCEPT_LANG,
               "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7"}
    if mode == "plain":
        import ssl
        import urllib.request
        try:
            import certifi  # venv에 curl_cffi와 함께 들어 있음. Windows 인증서 저장소 문제 회피
            ctx = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            ctx = ssl.create_default_context()
        req = urllib.request.Request(url, headers={**headers, "User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC, context=ctx) as resp:
                data = resp.read()
                return resp.status, resp.geturl(), resp.headers.get("content-type", ""), data, {}
        except urllib.error.HTTPError as e:
            return e.code, url, e.headers.get("content-type", ""), e.read(), {}
    from curl_cffi import requests as cr
    resp = cr.get(url, impersonate=mode, headers=headers, timeout=TIMEOUT_SEC, allow_redirects=True)
    cookies = {}
    try:
        cookies = {c.name: c.value for c in resp.cookies.jar}
    except Exception:
        pass
    return resp.status_code, str(resp.url), resp.headers.get("content-type", ""), resp.content, cookies


def decode(data: bytes, ctype: str) -> str:
    m = re.search(r"charset=([\w-]+)", ctype or "", re.I)
    enc = m.group(1) if m else None
    if not enc:
        m2 = re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', data[:4000], re.I)
        enc = m2.group(1).decode() if m2 else "utf-8"
    try:
        return data.decode(enc, "replace")
    except LookupError:
        return data.decode("utf-8", "replace")


def cmd_fetch(a):
    targets = [("원래 주소", a.url)]
    if a.variants:
        targets += [t for t in host_variants(a.url)]
    results = []
    sent = 0
    for label, u in targets:
        if sent >= MAX_REQUESTS:
            break
        if sent:
            time.sleep(DELAY_SEC)
        sent += 1
        try:
            status, final, ctype, data, cookies = get(u, a.mode)
        except SystemExit:
            raise
        except Exception as e:
            results.append({"try": label, "url": u, "verdict": "ERROR", "error": f"{type(e).__name__}: {e}"[:200]})
            continue
        body = decode(data, ctype)
        v = judge(body, status, final, ctype, cookies)
        v.update({"try": label, "url": u, "final_url": final, "mode": a.mode})
        if v["verdict"] in ("OK", "EMPTY", "JS_SHELL", "FRAME_SHELL") and "<" in body[:200]:
            md = extract_meta(body)
            v["meta"] = {"og:title": md["og"].get("og:title"), "og:description": md["og"].get("og:description"),
                         "jsonld_types": md["jsonld_types"], "links": md["links"]}
            if v["verdict"] == "OK":
                v["excerpt"] = scan(body).text[:a.text]
        if a.save:
            out = Path(a.save)
            if len(targets) > 1:
                out = out.with_name(f"{out.stem}-{sent}{out.suffix}")
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            v["saved"] = str(out)
        results.append(v)
        if v["verdict"] == "OK" or v["verdict"] in ("RATE_LIMITED", "AUTH", "NOT_FOUND"):
            break  # 성공했거나 더 해도 소용없는 신호면 멈춤
    print(json.dumps(results if len(results) > 1 else results[0], ensure_ascii=False, indent=2))


def _read_src(src: str) -> str:
    if src == "-":
        return sys.stdin.buffer.read().decode("utf-8", "replace")
    if re.match(r"https?://", src):
        status, final, ctype, data, _ = get(src, "chrome")
        return decode(data, ctype)
    return Path(src).read_bytes().decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser(description="web-unblock 도구")
    sub = ap.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge", help="저장된 HTML 판정")
    j.add_argument("src")
    j.add_argument("--url", default="", help="최종 주소(로그인 이동 판정용)")
    j.add_argument("--status", type=int, default=200)
    m = sub.add_parser("meta", help="OGP·JSON-LD 추출")
    m.add_argument("src")
    al = sub.add_parser("alt", help="대체 주소 목록")
    al.add_argument("url")
    f = sub.add_parser("fetch", help="받아서 판정")
    f.add_argument("url")
    f.add_argument("--as", dest="mode", default="chrome",
                   choices=["chrome", "safari", "firefox", "plain"])
    f.add_argument("--variants", action="store_true", help="www→m 등 주소 바꿔 이어서 시도")
    f.add_argument("--save", help="받은 원문 저장 경로(작업 폴더 안)")
    f.add_argument("--text", type=int, default=TEXT_EXCERPT)
    a = ap.parse_args()

    if a.cmd == "judge":
        print(json.dumps(judge(_read_src(a.src), a.status, a.url), ensure_ascii=False, indent=2))
    elif a.cmd == "meta":
        print(json.dumps(extract_meta(_read_src(a.src)), ensure_ascii=False, indent=2))
    elif a.cmd == "alt":
        for lbl, u in alt_urls(a.url):
            print(f"{lbl}\t{u}")
    elif a.cmd == "fetch":
        cmd_fetch(a)


if __name__ == "__main__":
    main()
