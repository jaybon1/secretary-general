// The dashboard (feature 'dashboard', src/dashboard/): its data helpers (moved from the dashboard workspace), settings,
// and the web server over real HTTP on a free port, with /share on folders made here (never the real ones).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gitIn, tempDir, tempStore, write } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { entryPath, secretaryStateDir } from '../src/core/paths.ts';
import {
  accountName,
  ago,
  kanban,
  kst,
  limitsFor,
  recentRunJobs,
  resultText,
  runJobsActive,
  runJobState,
  sessionIdOf,
  workers,
  untilText,
  type Collected,
  type Limit,
  type Meter,
  type Procs,
} from '../src/dashboard/collect.ts';
import { listen, type Listening } from '../src/dashboard/server.ts';
import { DEFAULT_PORT, dashboardOn, dashboardUrls, defaultShare, readSettings } from '../src/dashboard/settings.ts';
import { gitIgnored, hiddenName, parseRange, parseSharePath, Share } from '../src/dashboard/share.ts';
import { statusText } from '../src/dashboard/status-text.ts';
import { readUsageChoice, saveUsageChoice, usageSettingsView } from '../src/usage/usage-settings.ts';
import { labeler, type ProviderInfo } from '../src/usage/providers.ts';

test('the task board has a review column next to running, shown as the user\'s turn', () => {
  const s = tempStore();
  const ws = s.createWorkspace({ kind: 'solo', name: 'video', title: '영상', purpose: '영상 제작', folder: 'C:/ws/video', agents: [] });
  const t = s.createTask({ workspaceId: ws.id, name: 'cut', title: '쇼츠 편집', goal: 'g', outputDir: 'o', review: true });
  s.updateTask(t.id, { status: 'review' });
  const cols = kanban(s.db.location()!);
  assert.deepEqual(cols.map((c) => c.status), ['ready', 'running', 'review', 'failed', 'done', 'cancelled']);
  const review = cols.find((c) => c.status === 'review')!;
  assert.match(review.label, /검수 대기/);
  assert.deepEqual(review.items.map((x) => x.title), ['쇼츠 편집']);
});

test('kst: UTC to Korean time, 24-hour, across midnight', () => {
  assert.equal(kst('2026-10-25T09:21:00Z'), '10/25 18:21');
  assert.equal(kst('2026-10-25T15:00:00Z'), '10/26 00:00');
  assert.equal(kst('nope'), null);
});

test('ago / untilText', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(ago('2026-10-25T11:59:40Z', now), '방금');
  assert.equal(ago('2026-10-25T09:20:00Z', now), '2시간 40분 전');
  assert.equal(untilText('2026-10-25T12:30:00Z', now), '30분 뒤');
  assert.equal(untilText('2026-10-25T11:00:00Z', now), null);
});

test('resultText / accountName', () => {
  assert.equal(resultText(0), '성공');
  assert.equal(resultText(267009), '지금 실행 중');
  assert.match(resultText(1073807364), /실패 또는 중단/);
  assert.equal(accountName(undefined), '계정 a');
  assert.equal(accountName('subscription-b'), '계정 b');
});

test('sessionIdOf: fresh, resumed and background host command lines; unrelated ones null', () => {
  // 2026-11-04 real command lines (shortened): a resumed account-a work session and its host, a fresh work session
  const resumed = String.raw`C:\Users\u\.local\bin\claude.exe --resume C:\Users\u\.claude\projects\C--Users-u-ws-x\9f3d7459-f844-45f8-b5e1-a282becde09f.jsonl --name overseas-reaction-test-1-a --effort medium`;
  const host = String.raw`claude.exe --bg-pty-host \\.\pipe\cc-daemon-735717510267983e-pty-9f3d7459 200 50 -- claude.exe --resume C:/p/9f3d7459-f844-45f8-b5e1-a282becde09f.jsonl --name overseas-reaction-test-1-a`;
  const fresh = String.raw`claude.exe --session-id 10c07087-8b68-4106-a6ae-05c84c730db6 --name fix-worker-session-status --model sonnet`;
  assert.equal(sessionIdOf(resumed), '9f3d7459');
  assert.equal(sessionIdOf(host), '9f3d7459');
  assert.equal(sessionIdOf(fresh), '10c07087');
  assert.equal(sessionIdOf('claude.exe --resume C:/a/b/9f3d7459-f844.jsonl'), '9f3d7459');
  assert.equal(sessionIdOf('claude.exe remote-control --name 비서 --permission-mode auto'), null);
  assert.equal(sessionIdOf('claude.exe --type=renderer --user-data-dir=C:/x'), null);
});

test('settings: defaults without a local file; the file adds hosts and changes port, shares and the public address', () => {
  const root = path.join(tempDir(), 'secretary');
  fs.mkdirSync(root);
  const d = readSettings(root);
  assert.equal(d.problem, null);
  assert.deepEqual(d.settings.hosts, ['127.0.0.1']);
  assert.equal(d.settings.port, DEFAULT_PORT);
  assert.deepEqual(d.settings.share, defaultShare(root));
  assert.deepEqual(Object.keys(d.settings.share), ['ai-agent'], 'inbox and notes are seen inside ai-agent');
  assert.equal(d.settings.share['ai-agent'], path.dirname(root));
  assert.deepEqual(dashboardUrls(d.settings), [`http://127.0.0.1:${DEFAULT_PORT}/`]);

  write(
    path.join(root, 'scripts', 'dashboard.local.json'),
    '\uFEFF' + JSON.stringify({ hosts: ['100.1.2.3', '127.0.0.1'], port: 8123, publicUrl: 'https://pc.example.ts.net/', share: { 'ai-agent': null, notes: '../notes', out: '../out', 'bad/name': 'x' }, refreshSec: 1 }),
  );
  const s = readSettings(root);
  assert.deepEqual(s.settings.hosts, ['127.0.0.1', '100.1.2.3'], '127.0.0.1 always, once');
  assert.equal(s.settings.port, 8123);
  assert.equal(s.settings.refreshSec, 30, 'out of range: the default');
  assert.deepEqual(Object.keys(s.settings.share), ['notes', 'out']);
  assert.equal(s.settings.share.out, path.join(path.dirname(root), 'out'));
  assert.match(s.problem!, /refreshSec=1 무시/);
  assert.match(s.problem!, /share 이름 'bad\/name' 무시/);
  assert.deepEqual(dashboardUrls(s.settings), ['http://127.0.0.1:8123/', 'http://100.1.2.3:8123/', 'https://pc.example.ts.net/']);
});

test('the feature switch: on without features.json or with it on, off when features.json turns it off', () => {
  const root = tempDir();
  assert.equal(dashboardOn(root), true);
  write(path.join(root, 'features.json'), JSON.stringify({ features: [{ id: 'dashboard', enabled: false, files: [], checks: [], notices: [], tasks: [], rules: [] }] }));
  assert.equal(dashboardOn(root), false);
});

test('share paths: dot segments, encoded dots and slashes, backslashes, drive letters, colons and trailing dots are refused', () => {
  assert.deepEqual(parseSharePath('ai-agent/ws/a%20b%20%ED%95%9C.md'), { name: 'ai-agent', segs: ['ws', 'a b 한.md'], dir: false });
  assert.deepEqual(parseSharePath('ai-agent/ws/'), { name: 'ai-agent', segs: ['ws'], dir: true });
  for (const bad of ['ai-agent/../x', 'ai-agent/%2e%2e/x', 'ai-agent/%2E%2e%2Fx', 'ai-agent/a%2fb', 'ai-agent/a%5cb', 'ai-agent/a\\b', 'ai-agent/C:/Windows', 'ai-agent/x//y', 'ai-agent/.env.', 'ai-agent/a ', 'ai-agent/f.txt:stream', 'ai-agent/a%00', 'ai-agent/%E0%A4%A', '']) {
    assert.ok('bad' in parseSharePath(bad), bad);
  }
});

test('ranges: a-b, a-, -n; past the end or empty is 416; no or several ranges is the whole file', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'bad');
  assert.equal(parseRange('bytes=5-2', 10), 'bad');
  assert.equal(parseRange('bytes=-0', 10), 'bad');
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
});

test('hidden names: .git, .env, *.env, key file names', () => {
  for (const n of ['.git', '.GIT', '.env', '.env.local', 'naver.env', 'naver-apihub-api-key-someone-content-tool.txt', 'x-oauth-token-y', 'a.db', 'a.DB-wal', 'a.db-shm', 'x.sqlite', 'x.sqlite3-journal', 'c.pem', 'c.key', 'c.p12', 'c.pfx', 'v.kdbx']) assert.ok(hiddenName(n), n);
  for (const n of ['env.md', 'report.md', 'environment.txt', 'token-usage.md', 'db.md', 'keynote.txt', 'key.md']) assert.ok(!hiddenName(n), n);
});

// ---- the server over HTTP -------------------------------------------------------------------------

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}
let server: Listening;
let port = 0;
let base = '';
const VIDEO = Buffer.from(Array.from({ length: 64 }, (_, i) => i));

function req(p: string, { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    // path as given (no normalizing), so the server sees exactly what a crafted request would send
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  base = tempDir();
  const ai = path.join(base, 'ai-agent');
  const sec = path.join(ai, 'secretary');
  write(path.join(sec, '.gitignore'), 'secretary.db\nscripts/*.local.json\nlocal/\nbackups/\n');
  write(path.join(sec, 'AGENTS.md'), '# 규칙\n');
  write(path.join(sec, 'secretary.db'), 'db');
  write(path.join(sec, 'scripts', 'pc.local.json'), '{"key":"x"}');
  write(path.join(sec, 'local', 'x.txt'), 'local');
  write(path.join(sec, 'backups', 'error', 'bad.db'), 'quarantined');
  write(path.join(ai, 'workspaces', 'w', 'report.md'), '# 보고서\n본문 한글\n');
  write(path.join(ai, 'workspaces', 'w', 'a b 한글.txt'), '공백과 한글\n');
  write(path.join(ai, 'workspaces', 'w', 'data.csv'), 'a,b\n1,2\n');
  write(path.join(ai, 'workspaces', 'w', 'page.html'), '<script>fetch("/api/status")</script>');
  write(path.join(ai, 'workspaces', 'w', '.env'), 'SECRET=1');
  write(path.join(ai, 'workspaces', 'w', 'naver.env'), 'SECRET=1');
  write(path.join(ai, 'workspaces', 'w', 'naver-apihub-api-key-me-tool.txt'), 'SECRET=1');
  write(path.join(ai, 'workspaces', 'w', '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(ai, 'workspaces', 'w', 'clip.mp4'), VIDEO);
  fs.writeFileSync(path.join(ai, 'workspaces', 'w', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(path.join(ai, 'workspaces', 'w', 'cache.db'), 'db');
  write(path.join(ai, 'workspaces', 'w', 'cert.pem'), 'pem');
  write(path.join(ai, 'workspaces', 'w', 'big.txt'), '가'.repeat(700000) + '끝');
  // Browser profiles: a Chromium user data folder, a Chromium profile alone, a Firefox profile.
  write(path.join(ai, 'workspaces', 'w', 'chrome-data', 'Local State'), '{}');
  write(path.join(ai, 'workspaces', 'w', 'chrome-data', 'Default', 'notes.txt'), 'inside');
  write(path.join(ai, 'workspaces', 'w', 'prof', 'Preferences'), '{}');
  write(path.join(ai, 'workspaces', 'w', 'prof', 'Network', 'x.txt'), 'x');
  write(path.join(ai, 'workspaces', 'w', 'ff', 'prefs.js'), '');
  write(path.join(ai, 'workspaces', 'w', 'ff', 'cookies.sqlite'), '');
  write(path.join(ai, 'workspaces', 'w', 'ff', 'readme.txt'), 'x');
  write(path.join(ai, 'inbox', 'note.md'), 'inbox');
  write(path.join(ai, 'keys', 'k.txt'), 'key folder');
  write(path.join(base, 'outside', 'secret.txt'), 'outside');
  // A junction inside the share pointing out of it (made without admin rights on Windows).
  fs.symlinkSync(path.join(base, 'outside'), path.join(ai, 'workspaces', 'out-link'), 'junction');
  const git = gitIn(sec);
  git('init', '-q');
  git('add', '.gitignore', 'AGENTS.md');
  git('commit', '-q', '-m', 'x');
  const share = new Share({ roots: { 'ai-agent': ai, inbox: path.join(ai, 'inbox'), gone: path.join(base, 'nope') }, secretaryRoot: sec, keysDir: path.join(ai, 'keys') });
  server = await listen({ refreshSec: 30, share, status: async () => ({ ok: true }) }, ['127.0.0.1'], 0, { onTaken: () => assert.fail('taken'), onError: (h, e) => assert.fail(`${h} ${e.code}`) });
  port = server.ports['127.0.0.1'];
  assert.ok(port > 0);
});

after(() => server?.close());

test('first page: the dashboard with a link to each share; health; status JSON; nothing but GET and HEAD', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type']!, /text\/html/);
  for (const n of ['ai-agent', 'inbox', 'gone']) assert.ok(r.text.includes(`href="/share/${n}/"`), n);
  assert.ok(!r.text.includes('__SHARES__') && !r.text.includes('__REFRESH__'));
  assert.equal((await req('/api/health')).text, '{"ok":true}');
  assert.deepEqual(JSON.parse((await req('/api/status')).text), { ok: true });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const x = await req('/share/ai-agent/workspaces/w/report.md', { method });
    assert.equal(x.status, 405, method);
    assert.equal(x.headers.allow, 'GET, HEAD');
  }
  assert.equal((await req('/share/')).status, 302);
  assert.equal((await req('/nope')).status, 404);
  assert.equal((await req('/share/gone/')).status, 404, 'a share whose folder is not there');
  assert.equal((await req('/share/unknown/')).status, 404);
});

test('folders: a list with up, sizes and times, no hidden or outside entries; without the slash a redirect', async () => {
  const top = await req('/share/ai-agent/');
  assert.equal(top.status, 200);
  assert.ok(top.text.includes('href="/share/ai-agent/workspaces/"'));
  assert.ok(top.text.includes('href="/share/ai-agent/secretary/"'));
  assert.ok(!top.text.includes('keys'), 'the keys folder is not listed');
  assert.ok(top.text.includes('⬆ 위로') && top.text.includes('href="/"'));
  assert.match(top.text, /name="viewport"/);
  const w = await req('/share/ai-agent/workspaces/w/');
  assert.equal(w.status, 200);
  for (const shown of ['report.md', 'clip.mp4', 'pic.png', 'data.csv', encodeURIComponent('a b 한글.txt')]) assert.ok(w.text.includes(shown), shown);
  for (const hidden of ['.env', 'naver.env', 'api-key', '.git', 'cache.db', 'cert.pem', 'chrome-data', 'w/prof/', 'w/ff/']) assert.ok(!w.text.includes(hidden), hidden);
  for (const p of ['cache.db', 'cert.pem', 'chrome-data/', 'chrome-data/Default/notes.txt', 'prof/Network/x.txt', 'ff/readme.txt']) {
    assert.equal((await req(`/share/ai-agent/workspaces/w/${p}`)).status, 404, p);
  }
  assert.ok(w.text.includes('href="/share/ai-agent/workspaces/w/report.md?app=1">앱으로 열기'));
  assert.ok(w.text.includes('href="/share/ai-agent/workspaces/w/report.md">report.md'), 'a text name opens at its plain address (the reading view)');
  assert.ok(w.text.includes('href="/share/ai-agent/workspaces/w/report.md?raw=1">원문'));
  assert.ok(!w.text.includes('?view=1'));
  assert.ok(w.text.includes('href="/share/ai-agent/workspaces/w/clip.mp4">clip.mp4'), 'a video opens as itself');
  assert.ok(!w.text.includes('clip.mp4?app=1'), 'no app link for a video');
  assert.ok(w.text.includes('64 B'));
  assert.ok(w.text.includes('href="/share/ai-agent/workspaces/"'), 'up');
  const ws = await req('/share/ai-agent/workspaces/');
  assert.ok(!ws.text.includes('out-link'), 'a junction pointing out of the share is not listed');
  const redirect = await req('/share/ai-agent/workspaces');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/share/ai-agent/workspaces/');
  const sec = await req('/share/ai-agent/secretary/');
  const names = [...sec.text.matchAll(/<div class="name"><a href="[^"]*">(?:📁 )?([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['.gitignore', 'AGENTS.md', '⬆ 위로'].sort(), 'only what git tracks or does not ignore; scripts/ holds only an ignored file');
});

test('folders: name and modified-time sort buttons kept in the browser, each entry carrying its name, mtime and kind; no query string', async () => {
  const w = await req('/share/ai-agent/workspaces/w/');
  assert.ok(w.text.includes('data-by="name"') && w.text.includes('>이름<') && w.text.includes('data-by="mtime"') && w.text.includes('>날짜<'));
  assert.ok(w.text.includes("localStorage.getItem(KEY)") && w.text.includes("var KEY = 'share-sort'"), 'the choice lives in the browser for every folder');
  assert.ok(!/\?sort=|[?&]by=|location\.search|history\./.test(w.text), 'the address stays the folder\'s');
  const ai = path.join(base, 'ai-agent');
  const st = fs.statSync(path.join(ai, 'workspaces', 'w', 'report.md'));
  assert.ok(w.text.includes(`<li data-name="report.md" data-mtime="${Math.round(st.mtimeMs)}" data-dir="0">`));
  assert.ok(w.text.includes('<li data-name="a b 한글.txt" data-mtime='), 'Korean names as they are');
  const ws = await req('/share/ai-agent/workspaces/');
  const wst = fs.statSync(path.join(ai, 'workspaces', 'w'));
  assert.ok(ws.text.includes(`<li data-name="w" data-mtime="${Math.round(wst.mtimeMs)}" data-dir="1">`), 'a folder by its own mtime');
  // The time shown beside each entry is its modified time in KST.
  const kst = new Date(st.mtimeMs + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  assert.ok(w.text.includes(kst), kst);
});

test('files: text as text/plain UTF-8 with ?raw=1, "open in app" as a text/markdown download, Korean names, images and pages as they are', async () => {
  const md = await req('/share/ai-agent/workspaces/w/report.md?raw=1');
  assert.equal(md.status, 200);
  assert.equal(md.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(md.text, '# 보고서\n본문 한글\n');
  assert.equal(md.headers['accept-ranges'], 'bytes');
  const app = await req('/share/ai-agent/workspaces/w/report.md?app=1');
  assert.equal(app.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(app.headers['content-disposition'], `attachment; filename="report.md"; filename*=UTF-8''report.md`);
  assert.equal((await req('/share/ai-agent/workspaces/w/data.csv?app=1')).headers['content-type'], 'text/csv; charset=utf-8');
  const ko = await req(`/share/ai-agent/workspaces/w/${encodeURIComponent('a b 한글.txt')}?raw=1`);
  assert.equal(ko.status, 200);
  assert.equal(ko.text, '공백과 한글\n');
  const koApp = await req(`/share/ai-agent/workspaces/w/${encodeURIComponent('a b 한글.txt')}?app=1`);
  assert.match(koApp.headers['content-disposition']!, /filename\*=UTF-8''a%20b%20%ED%95%9C%EA%B8%80\.txt/);
  assert.equal((await req('/share/ai-agent/workspaces/w/pic.png')).headers['content-type'], 'image/png');
  const page = await req('/share/ai-agent/workspaces/w/page.html');
  assert.match(page.headers['content-type']!, /text\/html/);
  assert.equal(page.headers['content-security-policy'], 'sandbox allow-scripts', 'its script never runs as the dashboard');
  assert.equal((await req('/share/inbox/note.md?raw=1')).text, 'inbox');
  assert.equal((await req('/share/ai-agent/workspaces/w/report.md/')).status, 404, 'a file is not a folder');
});

test('reading view: a text file by default, the same text escaped in a phone-sized page with links back; long files cut at 2MB; not for other kinds', async () => {
  write(path.join(base, 'ai-agent', 'workspaces', 'w', 'tag.md'), '﻿# 제목 <script>x</script>\n긴 줄\n');
  const v = await req('/share/ai-agent/workspaces/w/tag.md');
  // The old address (?view=1) still gives the same page.
  assert.equal((await req('/share/ai-agent/workspaces/w/tag.md?view=1')).text, v.text);
  assert.equal((await req('/share/ai-agent/workspaces/w/tag.md', { method: 'HEAD' })).headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(v.status, 200);
  assert.equal(v.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(String(v.headers['content-security-policy']), /default-src 'none'/);
  assert.match(v.text, /name="viewport"/);
  assert.ok(v.text.includes('<h1>제목 &lt;script&gt;x&lt;/script&gt;</h1>'), 'Markdown rendered, raw HTML shown as text, BOM dropped');
  assert.ok(!v.text.includes('<script>'));
  write(path.join(base, 'ai-agent', 'workspaces', 'w', 'table.md'), '| a | b |\n|---|---|\n| 1 | 2 |\n\n[x](javascript:alert(1)) `c`\n');
  const t = await req('/share/ai-agent/workspaces/w/table.md?view=1');
  assert.ok(t.text.includes('<div class="tbl"><table>') && t.text.includes('<td>1</td>'), 'tables, scrollable');
  assert.ok(!t.text.includes('href="javascript:'), 'a script link is not made');
  assert.ok(t.text.includes('<code>c</code>'));
  write(path.join(base, 'ai-agent', 'workspaces', 'w', 'plain.txt'), '# not a title <b>\n');
  assert.ok((await req('/share/ai-agent/workspaces/w/plain.txt?view=1')).text.includes('<pre># not a title &lt;b&gt;\n</pre>'), 'other text unconverted');
  assert.ok(v.text.includes('href="/share/ai-agent/workspaces/w/tag.md?raw=1">원문'));
  assert.ok(v.text.includes('href="/share/ai-agent/workspaces/w/tag.md?app=1">앱으로 열기'));
  assert.ok(v.text.includes('href="/share/ai-agent/workspaces/w/">⬆ 폴더'));
  const big = await req('/share/ai-agent/workspaces/w/big.txt?view=1');
  assert.ok(big.text.includes('앞 2MB만'));
  assert.ok(!big.text.includes('끝') && !big.text.includes('�'), 'cut at 2MB without a broken character');
  assert.equal((await req('/share/ai-agent/workspaces/w/clip.mp4?view=1')).headers['content-type'], 'video/mp4', 'view is only for text');
  assert.equal((await req('/share/ai-agent/workspaces/w/cache.db?view=1')).status, 404);
});

test('video: Range gives 206 with the right bytes, HEAD only headers, an impossible range 416', async () => {
  const p = '/share/ai-agent/workspaces/w/clip.mp4';
  const whole = await req(p);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.equal(whole.headers['content-length'], '64');
  assert.deepEqual(whole.body, VIDEO);
  const part = await req(p, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 10-19/64');
  assert.equal(part.headers['content-length'], '10');
  assert.deepEqual(part.body, VIDEO.subarray(10, 20));
  const tail = await req(p, { headers: { Range: 'bytes=-4' } });
  assert.deepEqual(tail.body, VIDEO.subarray(60));
  const head = await req(p, { method: 'HEAD', headers: { Range: 'bytes=0-' } });
  assert.equal(head.status, 206);
  assert.equal(head.body.length, 0);
  const no = await req(p, { headers: { Range: 'bytes=64-' } });
  assert.equal(no.status, 416);
  assert.equal(no.headers['content-range'], 'bytes */64');
});

test('hidden by direct address too (404): ignored in the secretary folder, backups, .git, .env, key names, the keys folder', async () => {
  for (const p of [
    '/share/ai-agent/secretary/secretary.db',
    '/share/ai-agent/secretary/scripts/pc.local.json',
    '/share/ai-agent/secretary/local/x.txt',
    '/share/ai-agent/secretary/local/',
    '/share/ai-agent/secretary/backups/error/bad.db',
    '/share/ai-agent/secretary/.git/config',
    '/share/ai-agent/workspaces/w/.env',
    '/share/ai-agent/workspaces/w/naver.env',
    '/share/ai-agent/workspaces/w/NAVER.ENV',
    '/share/ai-agent/workspaces/w/naver-apihub-api-key-me-tool.txt',
    '/share/ai-agent/workspaces/w/.git/config',
    '/share/ai-agent/keys/k.txt',
    '/share/ai-agent/keys/',
  ]) {
    assert.equal((await req(p)).status, 404, p);
  }
  assert.equal((await req('/share/ai-agent/secretary/AGENTS.md')).status, 200, 'a tracked file is shown');
});

test('never outside the share: dot segments and their encodings, backslashes and drive letters 400, a junction out 404', async () => {
  for (const p of [
    '/share/ai-agent/../outside/secret.txt',
    '/share/ai-agent/workspaces/../../outside/secret.txt',
    '/share/ai-agent/%2e%2e/outside/secret.txt',
    '/share/ai-agent/%2E%2E%2Foutside%2Fsecret.txt',
    '/share/ai-agent/..%5coutside%5csecret.txt',
    '/share/ai-agent/..\\outside\\secret.txt',
    '/share/ai-agent/C:/Windows/win.ini',
    '/share/ai-agent/C%3A/Windows/win.ini',
    '/share/ai-agent/workspaces/w/.env.',
    '/share/ai-agent/workspaces/w/report.md::$DATA',
    '/share/..%2f..%2fWindows/',
  ]) {
    assert.equal((await req(p)).status, 400, p);
  }
  assert.equal((await req('/share/ai-agent/workspaces/out-link/secret.txt')).status, 404);
  assert.equal((await req('/share/ai-agent/workspaces/out-link/')).status, 404);
});

test('when git cannot say what is ignored, nothing of the secretary folder is shown', async () => {
  const ai = path.join(base, 'ai-agent');
  const share = new Share({ roots: { s: ai }, secretaryRoot: path.join(ai, 'secretary'), keysDir: path.join(base, 'no-keys'), ignored: async () => null });
  const l = await listen({ refreshSec: 30, share, status: async () => ({}) }, ['127.0.0.1'], 0, { onTaken: () => {}, onError: () => {} });
  try {
    const get = (p: string) =>
      new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port: l.ports['127.0.0.1'], path: p }, (res) => (res.resume(), resolve(res.statusCode!))));
    assert.equal(await get('/share/s/secretary/AGENTS.md'), 404);
    assert.equal(await get('/share/s/workspaces/w/report.md'), 200);
  } finally {
    await l.close();
  }
});

test('gitIgnored: what git ignores in a repository, folders with a slash; null outside one', async () => {
  const repo = tempDir();
  write(path.join(repo, '.gitignore'), 'a.db\nlocal/\n');
  write(path.join(repo, 'a.db'), '');
  write(path.join(repo, 'local', 'x'), '');
  write(path.join(repo, 'kept.md'), '');
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const set = await gitIgnored(repo);
  assert.deepEqual([...set!].sort(), ['a.db', 'local/']);
  assert.equal(await gitIgnored(path.join(repo, 'none')), null);
});

test('bin/dashboard.mjs: urls prints the addresses, a bad command the usage', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', entryPath('dashboard.mjs'), 'urls'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^http:\/\/127\.0\.0\.1:\d+\/$/m);
  const u = spawnSync(process.execPath, ['--no-warnings', entryPath('dashboard.mjs'), 'nope'], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /사용:/);
});

// ---- usage: which providers, their cards, the settings page (the reader: usage-poll.test.ts) -------------------------

const PROVIDERS: ProviderInfo[] = [
  { name: 'subscription', type: 'claude-subscription', label: '계정 a', usage: 'claude-usage' },
  { name: 'subscription-b', type: 'claude-subscription', label: '계정 b', usage: 'claude-usage' },
  { name: 'cli', type: 'some-cli', label: '다른 CLI', usage: 'agy' },
  { name: 'key', type: 'claude-api-key', label: 'key', usage: 'none' },
];

test('usage cards: the checked providers in list order, 5-hour and weekly or each agy group, not readable, not read yet', () => {
  const dir = tempDir();
  const now = Date.parse('2026-11-07T10:10:00Z');
  write(path.join(dir, 'subscription.json'), '﻿' + JSON.stringify({ five_hour_pct: 12, resets_at: '2026-11-07T13:50:00Z', week_pct: 45, week_resets_at: '2026-11-11T20:00:00Z', updated_at: '2026-11-07T10:07:45Z', source: 'usage-command' }));
  write(path.join(dir, 'cli.json'), JSON.stringify({ groups: [{ name: 'Gemini Models', window: 'weekly', used_pct: 2.9, resets_at: '2026-11-14T05:03:45Z' }, { name: 'Other', window: 'daily', used_pct: 4.1, resets_at: '2026-11-07T09:00:00Z' }], updated_at: '2026-11-07T09:00:00Z', source: 'agy-usage' }));
  const cards = limitsFor(PROVIDERS, ['key', 'cli', 'subscription', 'subscription-b', 'unknown'], dir, now);
  assert.deepEqual(cards.map((c) => c.provider), ['subscription', 'subscription-b', 'cli', 'key']);
  const a = cards[0] as Extract<Limit, { meters: Meter[] }>;
  assert.equal(a.name, '계정 a');
  assert.deepEqual(a.meters.map((m) => [m.label, m.pct, m.resetsAt, m.passed]), [['5시간', 12, '11/07 22:50', false], ['주간', 45, '11/12 05:00', false]]);
  assert.equal(a.stale, false);
  assert.deepEqual(cards[1], { name: '계정 b', provider: 'subscription-b', error: '아직 조회 기록 없음' });
  const cli = cards[2] as Extract<Limit, { meters: Meter[] }>;
  assert.equal(cli.name, '다른 CLI');
  assert.deepEqual(cli.meters.map((m) => [m.label, m.pct, m.passed]), [['Gemini Models 주간', 2.9, false], ['Other daily', 4.1, true]]);
  assert.equal(cli.stale, true, 'over 30 minutes old');
  assert.deepEqual(cards[3], { name: 'key', provider: 'key', none: true });
  assert.deepEqual(limitsFor(PROVIDERS, [], dir, now), []);
  // The "상태" text says the same.
  const text = statusText({ generatedAt: 'x', limits: { data: cards }, workers: { error: 'e' }, runJobsActive: { error: 'e' }, runJobsRecent: { error: 'e' }, kanban: { error: 'e' }, schedules: { error: 'e' } } as unknown as Collected);
  assert.match(text, /계정 a: 5시간 12% \(초기화 11\/07 22:50, 3시간 40분 뒤\) \/ 주간 45%/);
  assert.match(text, /계정 b: 아직 조회 기록 없음/);
  assert.match(text, /key: 조회 안 됨/);
  assert.match(text, /다른 CLI: Gemini Models 주간 2\.9% .* ※오래된 값/);
});

test('account names in the work lists come from the same names as the usage cards', () => {
  const dir = tempDir();
  write(path.join(dir, 'run-job-calls.jsonl'), [JSON.stringify({ at: '2026-11-07T10:00:00Z', provider: 'cli', model: 'm' }), JSON.stringify({ at: '2026-11-07T10:01:00Z', provider: 'subscription-b', model: 'm' })].join('\n') + '\n');
  assert.deepEqual(recentRunJobs(10, dir, labeler(PROVIDERS)).map((x) => x.account), ['계정 b', '다른 CLI']);
  assert.deepEqual(recentRunJobs(10, dir).map((x) => x.account), ['계정 b', 'cli'], 'without the list: the fallback names');
});

// Without it: another secretary's work sessions and run-jobs on this PC show up in this secretary's dashboard, or a new
// secretary's dashboard says "읽지 못함" before its first work session or run-job.
test('work sessions and run-jobs are read from this secretary\'s own records folder (its id), the shared folder without one; none yet is empty', () => {
  const home = tempDir();
  const usage = tempDir();
  const withId = tempDir();
  fs.writeFileSync(path.join(withId, '.secretary-id'), 'a3f9\n');
  const mine = secretaryStateDir(withId, home, usage);
  assert.equal(mine, path.join(home, 'state', 'A3F9'));
  assert.equal(secretaryStateDir(tempDir(), home, usage), usage, 'a copy without an id: the shared folder, as before');
  write(path.join(mine, 'run-job-calls.jsonl'), JSON.stringify({ at: '2026-11-07T10:00:00Z', provider: 'subscription', model: 'mine' }) + '\n');
  write(path.join(usage, 'run-job-calls.jsonl'), JSON.stringify({ at: '2026-11-07T10:00:00Z', provider: 'subscription', model: 'shared' }) + '\n');
  assert.deepEqual(recentRunJobs(10, mine).map((x) => x.model), ['mine']);
  const empty = tempDir();
  assert.deepEqual(recentRunJobs(10, empty), []);
  assert.deepEqual(workers([], empty), { running: [], orphan: [] });
  assert.deepEqual(runJobsActive(empty), { running: [] });
});

// Without it: a run-job killed before its finally (window closed, PC off) stays "running" for ever, also when Windows gave
// its pid to another process; or a run-job that just started is deleted because the process list was taken before it.
test('running run-jobs: a file left by a run that ended is hidden, and deleted only when that is certain', () => {
  const dir = tempDir();
  const active = path.join(dir, 'run-job-active');
  const job = (pid: number, started: string | null) =>
    write(path.join(active, `${pid}.json`), JSON.stringify({ pid, ...(started ? { started_at: started } : {}), provider: 'subscription', model: 'm', folder: 'C:/a/b', label: `job ${pid}` }));
  job(201, '2026-11-07T10:00:00Z'); // its PowerShell started just before: running
  job(202, '2026-11-07T10:00:00Z'); // the pid now belongs to a process started later: ended
  job(203, '2026-11-07T10:00:00Z'); // no process with the pid: ended
  job(204, '2026-11-07T11:00:30Z'); // started after the list was taken: may not be on it yet
  job(206, null); // no start time: not certain
  const procs: Procs = {
    at: '2026-11-07T11:00:00Z',
    list: [
      { pid: 201, started: '2026-11-07T09:59:58Z' },
      { pid: 202, started: '2026-11-07T10:30:00Z' },
    ],
  };
  const r = runJobsActive(dir, undefined, procs);
  assert.deepEqual(r.running.map((x) => x.pid).sort(), [201, 204]);
  assert.deepEqual(fs.readdirSync(active).sort(), ['201.json', '204.json', '206.json'], 'only the certainly ended ones are deleted');
  assert.equal(runJobState({ pid: 206 }, { at: procs.at, list: [{ pid: 206, started: '2026-11-07T10:00:00Z' }] }), 'running', 'no start time but the pid lives');
  // Without the process list (sys.ps1 failed): only whether the pid exists, nothing deleted.
  job(999_994, '2026-11-07T10:00:00Z');
  job(process.pid, '2026-11-07T10:00:00Z');
  assert.deepEqual(runJobsActive(dir, undefined, null).running.map((x) => x.pid), [process.pid]);
  assert.ok(fs.existsSync(path.join(active, '999994.json')));
});

// Without it: a run-job-active file cut off mid-write (run killed while writing) is skipped as "being written" for ever,
// or a file run-job.ps1 is writing right now is deleted.
test('running run-jobs: a broken file is deleted once it is old, kept while it may still be written', () => {
  const dir = tempDir();
  const active = path.join(dir, 'run-job-active');
  write(path.join(active, '301.json'), '{"pid":301,"star');
  write(path.join(active, '302.json'), '{"pid":302,"star');
  const old = new Date(Date.now() - 11 * 60000);
  fs.utimesSync(path.join(active, '301.json'), old, old);
  const r = runJobsActive(dir, undefined, { at: new Date().toISOString(), list: [] });
  assert.deepEqual(r.running, []);
  assert.deepEqual(fs.readdirSync(active), ['302.json'], 'the old broken one deleted, the fresh one kept');
});

// Without it: the dashboard's process list changes shape and every run-job file counts as ended (and is deleted) or as running.
test('sys.ps1 lists the PowerShell processes with their start times and when it took the list', { skip: process.platform !== 'win32' }, () => {
  const before = Date.now();
  const j = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT_ROOT, 'src', 'dashboard', 'sys.ps1')], { encoding: 'utf8' }));
  const after = Date.now();
  const at = Date.parse(j.procs.at);
  assert.ok(at >= before && at <= after, 'at: when sys.ps1 took the list');
  const list = [j.procs.list].flat() as { pid: number; started: string }[];
  // sys.ps1's own PowerShell started before it took the list. Another one (a test running beside this one) may start
  // between `at` and the listing and so start after `at` (the run-job check reads that as running), so only `after` bounds them all.
  assert.ok(list.some((p) => Date.parse(p.started) <= at), 'sys.ps1 runs in PowerShell itself');
  assert.ok(list.every((p) => typeof p.pid === 'number' && Date.parse(p.started) <= after));
});

test('settings page: GET shows the list, POST JSON from the page saves it; other sites, forms and bad bodies refused', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'usage.local.json');
  const deps = { keysDir: path.join(dir, 'keys'), home: path.join(dir, 'home'), localAppData: path.join(dir, 'local') };
  const share = new Share({ roots: {}, secretaryRoot: dir, keysDir: path.join(dir, 'keys') });
  const usage = { view: () => usageSettingsView(PROVIDERS, readUsageChoice(PROVIDERS, file, deps), deps), save: (i: unknown) => saveUsageChoice(i, PROVIDERS, file) };
  const l = await listen({ refreshSec: 30, share, usage, status: async () => ({}) }, ['127.0.0.1'], 0, { onTaken: () => assert.fail('taken'), onError: (h, e) => assert.fail(`${h} ${e.code}`) });
  const p = l.ports['127.0.0.1'];
  const call = (u: string, method = 'GET', headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; text: string; allow?: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p, path: u, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'), allow: res.headers.allow }));
      });
      r.on('error', reject);
      r.end(body);
    });
  try {
    const page = await call('/settings');
    assert.equal(page.status, 200);
    assert.match(page.text, /대시보드 설정/);
    assert.deepEqual(JSON.parse((await call('/api/usage-settings')).text).providers.map((x: { checked: boolean }) => x.checked), [false, false, false, false]);
    const json = { 'Content-Type': 'application/json' };
    const ok = await call('/api/usage-settings', 'POST', { ...json, Origin: `http://127.0.0.1:${p}`, 'Sec-Fetch-Site': 'same-origin' }, JSON.stringify({ providers: ['cli', 'nope'] }));
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(JSON.parse(ok.text).providers.filter((x: { checked: boolean }) => x.checked).map((x: { name: string }) => x.name), ['cli']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { providers: ['cli'] });
    // Refused, nothing changed: a form post, another site's page, a body that is not JSON or not a list, too big.
    assert.equal((await call('/api/usage-settings', 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'providers=key')).status, 403);
    assert.equal((await call('/api/usage-settings', 'POST', { ...json, Origin: 'https://evil.example' }, '{"providers":["key"]}')).status, 403);
    assert.equal((await call('/api/usage-settings', 'POST', { ...json, 'Sec-Fetch-Site': 'cross-site' }, '{"providers":["key"]}')).status, 403);
    assert.equal((await call('/api/usage-settings', 'POST', json, '{nope')).status, 400);
    assert.equal((await call('/api/usage-settings', 'POST', json, '{"providers":"key"}')).status, 400);
    assert.equal((await call('/api/usage-settings', 'POST', json, JSON.stringify({ providers: ['x'.repeat(9000)] }))).status, 413);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { providers: ['cli'] });
    // Every other write is still refused.
    const put = await call('/api/usage-settings', 'PUT', json, '{}');
    assert.equal(put.status, 405);
    assert.equal(put.allow, 'GET, HEAD, POST');
    assert.equal((await call('/api/status', 'POST', json, '{}')).status, 405);
  } finally {
    await l.close();
  }
  // Without the usage settings (as the share tests run it) there is no settings page.
  assert.equal((await req('/settings')).status, 404);
  assert.equal((await req('/api/usage-settings', { method: 'POST' })).status, 405);
});
