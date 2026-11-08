/**
 * Read-only result folders on the dashboard: /share/<name>/<path>. A folder answers with a list (name, size, changed,
 * up; sorted on the page by name or modified time, SORT_SCRIPT), a file with itself: text kinds as text/plain, video and sound with Range so a phone can seek, images as they are.
 * A text file opens in a reading view by default (a page sized for a phone; Markdown rendered by markdown-it with raw
 * HTML shown as text and no script, other text unconverted with wrapped lines); ?raw=1 gives the file as it is (text/plain),
 * ?app=1 the same file as a download (Markdown as text/markdown). ?view=1, the reading view's old address, still works.
 *
 * Only GET and HEAD (the server refuses the rest). Never outside the share: a path with .., an encoded dot, slash or
 * backslash, a drive letter or a colon is refused (400), and what a junction or link resolves to must still be inside
 * the share's real folder (else 404). Hidden, from lists and direct addresses alike (404): in the secretary folder,
 * whatever git ignores there (the database, local settings, worktrees, ...) and backups/; everywhere, .git, .env and
 * *.env, the keys folder and files named like keys (keys folder rule: <platform>-<service>-<kind>-..., kind api-key,
 * oauth-client, oauth-token, token, password), database files (*.db, *.sqlite and their -wal/-shm/-journal), keys and
 * certificates (*.pem, *.key, *.p12, *.pfx, *.kdbx), and browser profile folders (cookies and saved logins live there:
 * a folder holding Chromium's "Local State", a Chromium profile with Preferences and Cookies or Network/, a Firefox
 * profile with prefs.js and cookies.sqlite) with everything under them. The hide checks run on the real path, so 8.3 short names and Windows'
 * trailing dots do not get around them.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export interface ShareOptions {
  /** name → folder */
  roots: Record<string, string>;
  /** The secretary folder: what git ignores there is hidden. */
  secretaryRoot: string;
  keysDir: string;
  /** The secretary folder's ignored paths (relative, '/', folders ending '/'); null when git could not say (then the whole folder is hidden). */
  ignored?: () => Promise<Set<string> | null>;
}

const TEXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.log', '.srt', '.vtt', '.yaml', '.yml', '.toml', '.ini', '.xml', '.ps1', '.py', '.ts', '.js', '.mjs', '.cjs', '.css', '.sh', '.bat', '.cmd', '.sql', '.tex', '.rst']);
const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};
/** Pages and pictures that can run script: their own sandbox, never the dashboard's origin. */
const SANDBOXED = new Set(['.html', '.htm', '.svg', '.xml']);
/** "Open in app": the same file as a download, Markdown as text/markdown. */
const APP_TYPES: Record<string, string> = { '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json' };

export const isText = (name: string) => TEXT.has(path.extname(name).toLowerCase());
export function contentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return TEXT.has(ext) ? 'text/plain; charset=utf-8' : (TYPES[ext] ?? 'application/octet-stream');
}

const KEY_KIND = /-(api-key|oauth-client|oauth-token|token|password)-/i;
/** Databases (with their side files), keys and certificates, password vaults. */
const SECRET_EXT = /\.(db|sqlite|sqlite3|db3)(-wal|-shm|-journal)?$|\.(pem|key|p12|pfx|kdbx)$/i;
/** A name hidden wherever it is. */
export function hiddenName(name: string): boolean {
  const n = name.toLowerCase();
  return n === '.git' || n === '.env' || n.endsWith('.env') || n.startsWith('.env.') || KEY_KIND.test(n) || SECRET_EXT.test(n);
}

const has = (dir: string, name: string) => fs.existsSync(path.join(dir, name));
/** A browser's user data or profile folder (cookies, saved logins). */
export function isBrowserProfile(dir: string): boolean {
  if (has(dir, 'Local State')) return true;
  if (has(dir, 'Preferences') && (has(dir, 'Cookies') || has(dir, 'Network'))) return true;
  return has(dir, 'prefs.js') && has(dir, 'cookies.sqlite');
}

const win = process.platform === 'win32';
const norm = (p: string) => (win ? p.toLowerCase() : p);
/** p inside dir (or dir itself), on real paths. */
export function within(dir: string, p: string): boolean {
  const rel = path.relative(norm(dir), norm(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const realOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

/**
 * The URL path after /share/ as a share name and safe segments, or why not (400). Checked before decoding (an encoded
 * dot, slash, backslash or NUL) and after (empty, . or .., separators, colon, control characters, a trailing dot or space).
 */
export function parseSharePath(rawAfterShare: string): { name: string; segs: string[]; dir: boolean } | { bad: string } {
  if (/%(2e|2f|5c|00)/i.test(rawAfterShare) || rawAfterShare.includes('\\')) return { bad: '허용하지 않는 글자' };
  const parts = rawAfterShare.split('/');
  const dir = parts.length > 1 && parts[parts.length - 1] === '';
  if (dir) parts.pop();
  const segs: string[] = [];
  for (const p of parts) {
    let s: string;
    try {
      s = decodeURIComponent(p);
    } catch {
      return { bad: '주소 글자가 깨짐' };
    }
    // eslint-disable-next-line no-control-regex
    if (!s || s === '.' || s === '..' || /[/\\:*?"<>|\x00-\x1f]/.test(s) || /[. ]$/.test(s)) return { bad: '허용하지 않는 경로' };
    segs.push(s);
  }
  const [name, ...rest] = segs;
  if (!name) return { bad: '이름 없음' };
  return { name, segs: rest, dir };
}

/** bytes=a-b, a-, -n against size: the range, null when there is no usable Range header, 'bad' when it can't be met (416). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null; // several ranges or another unit: the whole file
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const href = (segs: string[]) => '/share/' + segs.map(encodeURIComponent).join('/');
const pad = (n: number) => String(n).padStart(2, '0');
function kstTime(ms: number): string {
  const d = new Date(ms + 9 * 3600e3);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function sendText(res: ServerResponse, code: number, text: string, head: boolean) {
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(head ? undefined : text);
}

export const LIST_STYLE = `
:root { --bg:#f4f5f7; --card:#fff; --text:#1c2128; --mute:#69727d; --line:#dfe3e8; --link:#2457c5; }
@media (prefers-color-scheme: dark) { :root { --bg:#12151a; --card:#1b2028; --text:#e6e9ee; --mute:#98a1ad; --line:#2c333d; --link:#7fa6f5; } }
* { box-sizing:border-box; }
body { margin:0; padding:12px 12px 40px; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,"Malgun Gothic",sans-serif; -webkit-text-size-adjust:100%; }
main { max-width:900px; margin:0 auto; }
a { color:var(--link); text-decoration:none; }
h1 { font-size:18px; margin:4px 0 10px; overflow-wrap:anywhere; }
.crumbs { color:var(--mute); font-size:14px; margin-bottom:8px; overflow-wrap:anywhere; }
ul { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:10px; }
li { padding:10px 12px; border-top:1px solid var(--line); }
li:first-child { border-top:0; }
.name { font-size:16px; overflow-wrap:anywhere; word-break:break-word; }
.meta { color:var(--mute); font-size:13px; margin-top:2px; display:flex; flex-wrap:wrap; gap:4px 12px; }
.app { font-size:13px; }
.empty { color:var(--mute); padding:12px; }
.sort { display:flex; gap:8px; margin:0 0 8px; }
.sort button { flex:1; min-height:44px; padding:8px 12px; font:inherit; font-size:15px; color:var(--text); background:var(--card); border:1px solid var(--line); border-radius:10px; cursor:pointer; }
.sort button[aria-pressed="true"] { border-color:var(--link); color:var(--link); font-weight:600; }
`;

/**
 * The list's order, chosen with the two buttons on the page and kept in the browser (localStorage) for every folder page:
 * by name or by date, i.e. modified time (files and folders alike, each by its own mtime: a folder's changes when an entry
 * right inside it is added, removed or renamed; no walk inside, which made big folders slow on the phone), folders
 * first either way as the server lists them. The same button again flips the direction; another button starts at its own (name A→Z, time newest first).
 * No query string: the address stays the folder's. Without script the server's order (folders first, then by name) stays.
 */
const SORT_SCRIPT = `
(function () {
  var KEY = 'share-sort';
  var ul = document.getElementById('list');
  var bar = document.getElementById('sort');
  if (!ul || !bar) return;
  var items = [].slice.call(ul.querySelectorAll('li[data-name]'));
  var coll = new Intl.Collator('ko', { numeric: true });
  var first = { name: 'asc', mtime: 'desc' };
  var st = null;
  try { st = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (!st || !(st.by in first) || (st.dir !== 'asc' && st.dir !== 'desc')) st = { by: 'name', dir: 'asc' };
  function apply() {
    items.sort(function (a, b) {
      var d = Number(b.dataset.dir) - Number(a.dataset.dir);
      if (d) return d;
      var r = st.by === 'mtime' ? Number(a.dataset.mtime) - Number(b.dataset.mtime) : 0;
      if (!r) r = coll.compare(a.dataset.name, b.dataset.name);
      return st.dir === 'asc' ? r : -r;
    });
    items.forEach(function (li) { ul.appendChild(li); });
    [].forEach.call(bar.querySelectorAll('button'), function (b) {
      var on = b.dataset.by === st.by;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.arrow').textContent = on ? (st.dir === 'asc' ? ' ↑' : ' ↓') : '';
    });
  }
  bar.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    var by = b.dataset.by;
    st = by === st.by ? { by: by, dir: st.dir === 'asc' ? 'desc' : 'asc' } : { by: by, dir: first[by] };
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {}
    apply();
  });
  apply();
})();
`;

function listPage(name: string, segs: string[], entries: { name: string; dir: boolean; size: number; mtime: number }[]): string {
  const title = [name, ...segs].join('/');
  const crumbs = [`<a href="/">대시보드</a>`];
  [name, ...segs].forEach((s, i) => crumbs.push(`<a href="${esc(href([name, ...segs.slice(0, i)]))}/">${esc(s)}</a>`));
  const up = segs.length ? `${href([name, ...segs.slice(0, -1)])}/` : '/';
  const rows = entries.map((e) => {
    const link = href([name, ...segs, e.name]) + (e.dir ? '/' : '');
    const meta = [e.dir ? '폴더' : sizeText(e.size), kstTime(e.mtime)];
    const text = !e.dir && isText(e.name);
    const app = text ? ` <a class="app" href="${esc(link)}?app=1">앱으로 열기</a> <a class="app" href="${esc(link)}?raw=1">원문</a>` : '';
    return `<li data-name="${esc(e.name)}" data-mtime="${Math.round(e.mtime)}" data-dir="${e.dir ? 1 : 0}"><div class="name"><a href="${esc(link)}">${e.dir ? '📁 ' : ''}${esc(e.name)}${e.dir ? '/' : ''}</a></div><div class="meta"><span>${meta.map(esc).join('</span><span>')}</span>${app}</div></li>`;
  });
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${LIST_STYLE}</style></head>
<body><main>
<div class="crumbs">${crumbs.join(' / ')}</div>
<h1>${esc(title)}</h1>
<div class="sort" id="sort"><button type="button" data-by="name" aria-pressed="false">이름<span class="arrow"></span></button><button type="button" data-by="mtime" aria-pressed="false">날짜<span class="arrow"></span></button></div>
<ul id="list">
<li><div class="name"><a href="${esc(up)}">⬆ 위로</a></div></li>
${rows.join('\n') || '<li class="empty">빈 폴더</li>'}
</ul>
<p class="crumbs">읽기 전용 · 글 파일은 이름을 누르면 읽기 화면(마크다운은 변환)으로 열고, "원문"은 파일 그대로, "앱으로 열기"는 같은 파일을 받아 폰의 앱으로 연다 · 시각은 고친 때(한국시간, 폴더는 바로 안에 항목을 더하거나 지우거나 이름을 바꾼 때) · "날짜"는 그 시각으로 정렬하고, 고른 정렬은 이 브라우저에 기억돼 모든 폴더에 같이 쓰인다</p>
</main><script>${SORT_SCRIPT}</script></body></html>`;
}

/** The reading view reads at most this much; a longer file says so and points to the original. */
const VIEW_MAX = 2 * 1024 * 1024;
const VIEW_STYLE = `
:root { --bg:#fff; --text:#1c2128; --mute:#69727d; --line:#dfe3e8; --link:#2457c5; }
@media (prefers-color-scheme: dark) { :root { --bg:#12151a; --text:#e6e9ee; --mute:#98a1ad; --line:#2c333d; --link:#7fa6f5; } }
body { margin:0; padding:12px 14px 40px; background:var(--bg); color:var(--text); font:17px/1.65 system-ui,"Malgun Gothic",sans-serif; -webkit-text-size-adjust:100%; }
main { max-width:860px; margin:0 auto; }
a { color:var(--link); text-decoration:none; }
.bar { color:var(--mute); font-size:14px; display:flex; flex-wrap:wrap; gap:4px 14px; padding-bottom:8px; border-bottom:1px solid var(--line); margin-bottom:10px; overflow-wrap:anywhere; }
pre { margin:0; font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
.cut { color:var(--mute); font-size:14px; margin-top:16px; }
`;

const MD_STYLE = `
.md h1,.md h2,.md h3,.md h4 { line-height:1.3; margin:1.2em 0 .5em; }
.md h1 { font-size:1.5em; } .md h2 { font-size:1.3em; border-bottom:1px solid var(--line); padding-bottom:.2em; } .md h3 { font-size:1.12em; }
.md p, .md ul, .md ol, .md blockquote, .md table, .md pre { margin:.6em 0; }
.md ul, .md ol { padding-left:1.4em; }
.md code { font:.9em/1.5 ui-monospace,Consolas,monospace; background:var(--code); padding:.1em .3em; border-radius:4px; }
.md pre { background:var(--code); padding:10px 12px; border-radius:8px; overflow-x:auto; white-space:pre; }
.md pre code { background:none; padding:0; }
.md blockquote { border-left:4px solid var(--line); margin-left:0; padding-left:12px; color:var(--mute); }
.md .tbl { overflow-x:auto; }
.md table { border-collapse:collapse; font-size:.92em; }
.md th, .md td { border:1px solid var(--line); padding:5px 8px; vertical-align:top; }
.md th { background:var(--code); }
.md img { max-width:100%; }
.md hr { border:0; border-top:1px solid var(--line); }
:root { --code:#f1f3f5; } @media (prefers-color-scheme: dark) { :root { --code:#232a33; } }
`;

type Md = { render(src: string): string };
let mdPromise: Promise<Md | null> | null = null;
/** markdown-it with raw HTML off (shown as text) and its link check on; null when the package is not there (then plain text). */
function markdown(): Promise<Md | null> {
  mdPromise ??= import('markdown-it')
    .then(({ default: MarkdownIt }) => {
      const md = new MarkdownIt({ html: false, linkify: true });
      const open = md.renderer.rules.table_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
      const close = md.renderer.rules.table_close ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
      md.renderer.rules.table_open = (...a) => '<div class="tbl">' + open(...a);
      md.renderer.rules.table_close = (...a) => close(...a) + '</div>';
      return md;
    })
    .catch(() => null);
  return mdPromise;
}

const isMarkdown = (name: string) => ['.md', '.markdown'].includes(path.extname(name).toLowerCase());

function viewPage(segs: string[], text: string, cut: boolean, html?: string): string {
  const name = segs[segs.length - 1];
  const raw = href(segs);
  const up = `${href(segs.slice(0, -1))}/`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title><style>${VIEW_STYLE}${html === undefined ? '' : MD_STYLE}</style></head>
<body><main>
<div class="bar"><a href="${esc(up)}">⬆ 폴더</a><a href="${esc(raw)}?raw=1">원문</a><a href="${esc(raw)}?app=1">앱으로 열기</a><span>${esc(name)}</span></div>
${html === undefined ? `<pre>${esc(text)}</pre>` : `<div class="md">${html}</div>`}
${cut ? '<p class="cut">앞 2MB만 보였습니다. 나머지는 "원문"에서 보세요.</p>' : ''}
</main></body></html>`;
}

export class Share {
  private ignoredCache: { at: number; set: Promise<Set<string> | null> } | null = null;
  private profileCache = new Map<string, { at: number; yes: boolean }>();
  private readonly secretaryReal: string | null;
  private readonly keysReal: string | null;
  readonly o: ShareOptions;

  constructor(o: ShareOptions) {
    this.o = o;
    this.secretaryReal = realOrNull(o.secretaryRoot);
    this.keysReal = realOrNull(o.keysDir);
  }

  get names(): string[] {
    return Object.keys(this.o.roots);
  }

  /** The secretary folder's ignored paths, asked of git at most every 30 seconds. */
  private ignored(): Promise<Set<string> | null> {
    if (this.ignoredCache && Date.now() - this.ignoredCache.at < 30000) return this.ignoredCache.set;
    const set = (this.o.ignored ?? (() => gitIgnored(this.o.secretaryRoot)))();
    this.ignoredCache = { at: Date.now(), set };
    return set;
  }

  /** Whether a real path is hidden (shareReal: the share's real folder; names inside it are checked). */
  async hidden(real: string, shareReal: string): Promise<boolean> {
    const rel = path.relative(shareReal, real);
    if (rel && rel.split(path.sep).some(hiddenName)) return true;
    // A browser profile folder hides itself and everything under it: check from the share's folder down to this path.
    const parts = rel ? rel.split(path.sep) : [];
    let dir = shareReal;
    for (let i = 0; i <= parts.length; i++) {
      if (i > 0) dir = path.join(dir, parts[i - 1]);
      if (this.profile(dir)) return true;
    }
    if (this.keysReal && within(this.keysReal, real)) return true;
    if (this.secretaryReal && within(this.secretaryReal, real)) {
      const inner = path.relative(this.secretaryReal, real).split(path.sep).join('/');
      if (!inner) return false;
      const lower = inner.toLowerCase();
      if (lower === 'backups' || lower.startsWith('backups/')) return true;
      const ignored = await this.ignored();
      if (!ignored) return true; // git could not say: nothing of the secretary folder is shown
      const key = norm(inner);
      for (const p of ignored) {
        const q = norm(p);
        if (q.endsWith('/') ? key === q.slice(0, -1) || key.startsWith(q) : key === q || key.startsWith(`${q}/`)) return true;
      }
    }
    return false;
  }

  /** Whether dir is a browser profile, remembered for 30 seconds (a list asks for every entry's ancestors). */
  private profile(dir: string): boolean {
    const now = Date.now();
    const hit = this.profileCache.get(dir);
    if (hit && now - hit.at < 30000) return hit.yes;
    if (this.profileCache.size > 5000) this.profileCache.clear();
    const yes = isBrowserProfile(dir);
    this.profileCache.set(dir, { at: now, yes });
    return yes;
  }

  /** Answers /share/... (rawPath: the URL path without the query). */
  async handle(req: IncomingMessage, res: ServerResponse, rawPath: string, query: URLSearchParams): Promise<void> {
    const head = req.method === 'HEAD';
    const parsed = parseSharePath(rawPath.slice('/share/'.length));
    if ('bad' in parsed) return sendText(res, 400, `잘못된 주소입니다(${parsed.bad})`, head);
    const root = this.o.roots[parsed.name];
    const rootReal = root ? realOrNull(root) : null;
    if (!rootReal) return sendText(res, 404, '없는 주소입니다', head);
    const real = realOrNull(path.join(rootReal, ...parsed.segs));
    if (!real || !within(rootReal, real) || (await this.hidden(real, rootReal))) return sendText(res, 404, '없는 주소입니다', head);
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      return sendText(res, 404, '없는 주소입니다', head);
    }
    if (st.isDirectory()) {
      if (!parsed.dir) {
        res.writeHead(301, { ...BASE_HEADERS, Location: `${href([parsed.name, ...parsed.segs])}/`, 'Cache-Control': 'no-store' });
        return void res.end();
      }
      const entries = await this.list(real, rootReal);
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(head ? undefined : listPage(parsed.name, parsed.segs, entries));
    }
    if (!st.isFile()) return sendText(res, 404, '없는 주소입니다', head);
    if (parsed.dir) return sendText(res, 404, '없는 주소입니다', head);
    const app = query.get('app') === '1';
    // A text file reads in the view unless the file itself is asked for (?raw=1, or ?app=1 for the download).
    if (isText(real) && !app && query.get('raw') !== '1') return this.sendView(res, real, st, [parsed.name, ...parsed.segs], head);
    return this.sendFile(req, res, real, st, app);
  }

  private async list(dirReal: string, rootReal: string) {
    const out: { name: string; dir: boolean; size: number; mtime: number }[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(dirReal);
    } catch {
      return out;
    }
    for (const name of names) {
      if (hiddenName(name)) continue;
      const real = realOrNull(path.join(dirReal, name));
      // A link out of the share (or a broken one) is not listed, as its address would not answer.
      if (!real || !within(rootReal, real) || (await this.hidden(real, rootReal))) continue;
      try {
        const st = fs.statSync(real);
        if (!st.isDirectory() && !st.isFile()) continue;
        out.push({ name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      } catch {
        // gone meanwhile, or not readable
      }
    }
    return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  }

  private async sendView(res: ServerResponse, real: string, st: fs.Stats, segs: string[], head: boolean) {
    let buf: Buffer;
    try {
      const fd = fs.openSync(real, 'r');
      try {
        buf = Buffer.alloc(Math.min(st.size, VIEW_MAX));
        buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return sendText(res, 404, '없는 주소입니다', head);
    }
    const cut = st.size > VIEW_MAX;
    // stream: a character cut at the 2MB edge is left out rather than shown broken. The BOM is dropped.
    const text = new TextDecoder('utf-8').decode(buf, { stream: cut });
    const md = isMarkdown(real) ? await markdown() : null;
    const html = md ? md.render(text) : undefined;
    // No script at all; pictures only from this server (a Markdown file's own images in the share).
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'" });
    res.end(head ? undefined : viewPage(segs, text, cut, html));
  }

  private sendFile(req: IncomingMessage, res: ServerResponse, real: string, st: fs.Stats, app: boolean) {
    const name = path.basename(real);
    const ext = path.extname(name).toLowerCase();
    const headers: Record<string, string | number> = {
      ...BASE_HEADERS,
      'Accept-Ranges': 'bytes',
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': 'no-cache',
    };
    if (app && isText(name)) {
      headers['Content-Type'] = `${APP_TYPES[ext] ?? 'text/plain'}; charset=utf-8`;
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    } else {
      headers['Content-Type'] = contentType(name);
      if (SANDBOXED.has(ext)) headers['Content-Security-Policy'] = 'sandbox allow-scripts';
    }
    const range = parseRange(req.headers.range, st.size);
    if (range === 'bad') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
      return void res.end();
    }
    const head = req.method === 'HEAD';
    if (range) {
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': range.end - range.start + 1 });
      if (head) return void res.end();
      return void fs.createReadStream(real, range).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (head || st.size === 0) return void res.end();
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  }
}

/** What git ignores in repo (files and wholly ignored folders, the latter ending '/'); null when git fails. */
export function gitIgnored(repo: string): Promise<Set<string> | null> {
  return new Promise((resolve) =>
    execFile(
      'git',
      ['-C', repo, '-c', 'core.quotepath=off', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000 },
      (err, out) => resolve(err ? null : new Set(out.split('\0').filter(Boolean))),
    ),
  );
}
