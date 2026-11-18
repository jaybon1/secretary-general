// The dashboard (feature 'dashboard', src/dashboard/): its data helpers (moved from the dashboard workspace), settings,
// and the web server over real HTTP on a free port, with /share on folders made here (never the real ones).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gitIn, tempDir, write } from './helpers.ts';
import { listen, type Listening } from '../src/dashboard/server.ts';
import { Share } from '../src/dashboard/share.ts';

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

// [늘 남김] 없으면 놓치는 실수: 키·DB·백업·.env가 주소를 직접 치면 폰에서 열린다(개인정보, 2026-11-12 늘 남김으로 올림. 같은 막기를 함수 단위로 보던 테스트는 지움).
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

// [늘 남김] 없으면 놓치는 실수: ../·인코딩·역슬래시·드라이브 글자·정션으로 공유 폴더 밖 파일이 폰에서 열린다(개인정보, 2026-11-12 늘 남김으로 올림. 같은 막기를 함수 단위로 보던 테스트는 지움).
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

// ---- usage: which providers, their cards, the settings page (the reader: usage-poll.test.ts) -------------------------
