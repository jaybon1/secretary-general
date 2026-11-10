import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write as writeFile } from './helpers.ts';
import { NO_MODEL_ENV } from '../src/core/no-model-calls.ts';
import { clickUrl, firstLine, notifyAfterStop, ntfyRequest, planNotice, postNotice, readNotifySettings, readToken, remoteSessionUrl, sessionName, type Notice, type NotifySettings } from '../src/phone-push/ntfy.ts';

const SETTINGS: NotifySettings = { url: 'http://127.0.0.1:2586', topic: 'secretary-test', title: '{session}', priority: 4, click: null, tokenFile: null, timeoutMs: 2500 };
/** An environment without the tests' no-model mark (only for planNotice, which never sends). */
const LIVE_ENV: NodeJS.ProcessEnv = { ...process.env, [NO_MODEL_ENV]: '' };
/** A copy where the feature is on (no features.json: every feature on), so this runs the same in the release, where it ships off. */
const ON = { env: LIVE_ENV, root: tempDir('notify-on-') };
/** Writes a file and gives its path. */
const write = (file: string, text = ''): string => (writeFile(file, text), file);

// ---- the first line ---------------------------------------------------------------------------------------------------

test('first line: the conclusion line, markdown marks off', () => {
  assert.equal(firstLine('끝났어요. 시험 모두 통과.\n\n자세히는 아래.'), '끝났어요. 시험 모두 통과.');
  assert.equal(firstLine('## **결론**: `npm test` 통과\n본문'), '결론: npm test 통과');
  assert.equal(firstLine('- 첫 항목 [문서](https://x.y/z) 확인\n- 둘째'), '첫 항목 문서 확인');
  assert.equal(firstLine('1. 하나\n2. 둘'), '하나');
  assert.equal(firstLine('\n\n---\n```\n실제 결론 *강조* 줄\n'), '실제 결론 강조 줄');
});

test('first line: quoted head lines (이어서 and the like) are passed over; quotes only give the first', () => {
  assert.equal(firstLine('> 이어서: 어제 하던 알림 일.\n\n알림 코드 다 됐어요.\n다음 행동 및 순서: 없음'), '알림 코드 다 됐어요.');
  assert.equal(firstLine('> 🎤 받은 말: "상태 알려줘"\n> 이어서: x\n서버 둘 다 켜져 있어요.'), '서버 둘 다 켜져 있어요.');
  assert.equal(firstLine('> 인용만 있는 답'), '인용만 있는 답');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('```\n```'), '');
});

test('first line: cut to about 200 characters', () => {
  const long = '가'.repeat(500);
  const out = firstLine(long);
  assert.equal([...out].length, 200);
  assert.ok(out.endsWith('…'));
  assert.equal(firstLine('a'.repeat(200)), 'a'.repeat(200));
});

// ---- settings ---------------------------------------------------------------------------------------------------------

/** The phone-push section of this-secretary.local.json (core/this-secretary.ts). */
const pp = (v: unknown) => JSON.stringify({ 'phone-push': v });

test('settings: no file is nothing (no problem); enabled false is nothing; a bad file is nothing with the reason', () => {
  const root = tempDir('notify-');
  const file = path.join(root, 'this-secretary.local.json');
  assert.deepEqual(readNotifySettings(root), { settings: null, problem: null });
  write(file, pp({ url: 'http://127.0.0.1:2586', topic: 't', enabled: false }));
  assert.deepEqual(readNotifySettings(root), { settings: null, problem: null });
  write(file, pp({ url: 'ftp://x', topic: 'bad topic!' }));
  const bad = readNotifySettings(root);
  assert.equal(bad.settings, null);
  assert.match(bad.problem!, /url/);
  assert.match(bad.problem!, /topic/);
  write(file, '{ not json');
  assert.match(readNotifySettings(root).problem!, /못 읽음/);
});

test('settings: defaults, trailing slash off, token file from the root', () => {
  const root = tempDir('notify-');
  const file = path.join(root, 'this-secretary.local.json');
  write(file, pp({ url: 'http://127.0.0.1:2586/', topic: 'secretary-a', tokenFile: 'keys/ntfy.env', priority: 9 }));
  const { settings, problem } = readNotifySettings(root);
  assert.deepEqual(settings, { url: 'http://127.0.0.1:2586', topic: 'secretary-a', title: '{session}', priority: 4, click: 'session', tokenFile: path.join(root, 'keys', 'ntfy.env'), timeoutMs: 2500 });
  assert.match(problem!, /priority=9 무시/);
  // click: this session's conversation (the default), a fixed https address, or nothing; anything else is told and left at the default.
  const clickOf = (click: unknown) => (write(file, pp({ url: 'http://127.0.0.1:2586', topic: 't', click })), readNotifySettings(root));
  assert.equal(clickOf('https://claude.ai/code').settings?.click, 'https://claude.ai/code');
  assert.equal(clickOf(false).settings?.click, null);
  assert.equal(clickOf('session').settings?.click, 'session');
  const bad = clickOf('javascript:alert(1)');
  assert.equal(bad.settings?.click, 'session');
  assert.match(bad.problem!, /click=.* 무시/);
  // A file PowerShell wrote with a BOM reads the same.
  write(file, `﻿${pp({ url: 'http://127.0.0.1:2586', topic: 't', priority: 5 })}`);
  assert.equal(readNotifySettings(root).settings?.priority, 5);
});

test('click: this session’s Remote Control conversation from Claude Code’s session files, else the app’s code page', () => {
  const dir = tempDir('notify-sessions-');
  write(path.join(dir, '111.json'), JSON.stringify({ pid: 111, sessionId: 'other', bridgeSessionId: 'session_01Other' }));
  write(path.join(dir, '222.json'), JSON.stringify({ pid: 222, sessionId: 's-remote', bridgeSessionId: 'session_01XVbCmomk4GahT8X8tuGrt8' }));
  write(path.join(dir, '333.json'), JSON.stringify({ pid: 333, sessionId: 's-local' }));
  write(path.join(dir, '444.json'), JSON.stringify({ pid: 444, sessionId: 's-odd', bridgeSessionId: 'session_x/../evil' }));
  write(path.join(dir, 'broken.json'), '{');
  assert.equal(remoteSessionUrl('s-remote', dir), 'https://claude.ai/code/session_01XVbCmomk4GahT8X8tuGrt8');
  assert.equal(remoteSessionUrl('s-local', dir), null);
  assert.equal(remoteSessionUrl('s-odd', dir), null);
  assert.equal(remoteSessionUrl(undefined, dir), null);
  assert.equal(remoteSessionUrl('s-remote', path.join(dir, 'none')), null);
  const session = { ...SETTINGS, click: 'session' };
  assert.equal(clickUrl(session, 's-remote', dir), 'https://claude.ai/code/session_01XVbCmomk4GahT8X8tuGrt8');
  assert.equal(clickUrl(session, 's-local', dir), 'https://claude.ai/code');
  assert.equal(clickUrl({ ...SETTINGS, click: 'https://x.example/y' }, 's-remote', dir), 'https://x.example/y');
  assert.equal(clickUrl(SETTINGS, 's-remote', dir), undefined);
  // The plan carries it to the sender.
  const plan = planNotice({ session_id: 's-remote', hook_event_name: 'Stop' }, { answer: '끝.' }, { ...ON, settings: session, sessionsDir: dir });
  assert.ok('notice' in plan);
  assert.deepEqual(plan.notice, { title: '비서', message: '끝.', click: 'https://claude.ai/code/session_01XVbCmomk4GahT8X8tuGrt8' });
});

test('token: the file alone or its NTFY_TOKEN line; none otherwise', () => {
  const root = tempDir('notify-');
  const a = write(path.join(root, 'a.env'), 'tk_abc123\n');
  const b = write(path.join(root, 'b.env'), '# ntfy\nNTFY_TOKEN="tk_xyz"\n');
  const c = write(path.join(root, 'c.env'), 'OTHER=1\n');
  assert.equal(readToken(a), 'tk_abc123');
  assert.equal(readToken(b), 'tk_xyz');
  assert.equal(readToken(c), null);
  assert.equal(readToken(path.join(root, 'none.env')), null);
  assert.equal(readToken(null), null);
});

// ---- when it is sent --------------------------------------------------------------------------------------------------

test('plan: the answer the checks read, titled with the session name (else 비서)', () => {
  const root = tempDir('notify-');
  const transcript = write(
    path.join(root, 't.jsonl'),
    [JSON.stringify({ type: 'agent-name', agentName: '비서', sessionId: 's' }), JSON.stringify({ type: 'custom-title', customTitle: '알림 작업', sessionId: 's' }), ''].join('\n'),
  );
  const plan = planNotice({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' }, { answer: '> 이어서: x\n다 됐어요.' }, { ...ON, settings: SETTINGS });
  assert.ok('notice' in plan);
  assert.deepEqual(plan.notice, { title: '알림 작업', message: '다 됐어요.' });
  const noName = planNotice({ session_id: 's' }, { answer: '끝.' }, { ...ON, settings: { ...SETTINGS, title: '{session} 끝남' } });
  assert.ok('notice' in noName);
  assert.equal(noName.notice.title, '비서 끝남');
  assert.equal(sessionName(path.join(root, 'none.jsonl')), null);
});

test('plan: nothing for a turn sent back, a subagent, no settings, an empty answer, a feature turned off', () => {
  const skip = (p: ReturnType<typeof planNotice>) => ('skip' in p ? p.skip : 'sent');
  const input = { session_id: 's', hook_event_name: 'Stop' };
  assert.equal(skip(planNotice(input, { block: '[답 검사] …', answer: '영어 답' }, { ...ON, settings: SETTINGS })), 'turn sent back');
  assert.equal(skip(planNotice({ ...input, agent_id: 'a1' }, { answer: 'x' }, { ...ON, settings: SETTINGS })), 'not the main session');
  assert.equal(skip(planNotice({ ...input, hook_event_name: 'SubagentStop' }, { answer: 'x' }, { ...ON, settings: SETTINGS })), 'not the main session');
  assert.equal(skip(planNotice(input, { answer: 'x' }, { ...ON, settings: null })), 'no settings');
  assert.equal(skip(planNotice(input, { answer: '' }, { ...ON, settings: SETTINGS })), 'empty answer');
  const off = tempDir('notify-off-');
  write(path.join(off, 'features.json'), JSON.stringify({ features: [{ id: 'phone-push', enabled: false }] }));
  assert.equal(skip(planNotice(input, { answer: 'x' }, { ...ON, settings: SETTINGS, root: off })), 'feature off');
  // A copy without the settings file (this test copy has none) sends nothing.
  assert.equal(skip(planNotice(input, { answer: 'x' }, { ...ON, root: tempDir('notify-none-') })), 'no settings');
});

test('in tests (and eval runs) nothing is ever handed to the sender, settings or not', () => {
  assert.ok(process.env[NO_MODEL_ENV], 'test/env.ts sets the mark');
  let launched = 0;
  notifyAfterStop({ session_id: 's', hook_event_name: 'Stop' }, { answer: '끝났어요.' }, { settings: SETTINGS, launch: () => launched++ });
  assert.equal(launched, 0);
  assert.equal(('skip' in planNotice({ session_id: 's' }, { answer: 'x' }, { settings: SETTINGS })) && true, true);
  // The same call outside a test hands it on (with a fake launcher: no process, no network).
  const got: Notice[] = [];
  notifyAfterStop({ session_id: 's', hook_event_name: 'Stop' }, { answer: '끝났어요.' }, { ...ON, settings: SETTINGS, launch: (n) => got.push(n) });
  assert.deepEqual(got, [{ title: '비서', message: '끝났어요.' }]);
  // A launcher that throws never reaches the hook: one line in the log (a temp one here, never this PC's notify.log).
  const log = path.join(tempDir('notify-log-'), 'notify.log');
  assert.doesNotThrow(() => notifyAfterStop({ session_id: 's' }, { answer: 'x' }, { ...ON, settings: SETTINGS, launch: () => { throw new Error('boom'); }, logFile: log }));
  assert.match(fs.readFileSync(log, 'utf8'), /알림 준비 실패: boom\r?\n$/);
});

// ---- the POST ---------------------------------------------------------------------------------------------------------

/** A fake ntfy server on 127.0.0.1; `hang` never answers. */
async function fakeServer(hang = false): Promise<{ url: string; got: { method?: string; url?: string; auth?: string; body: string }[]; close: () => Promise<void> }> {
  const got: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (!hang) res.end('{"id":"x"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    got,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test('post: JSON publish to the server root with topic, title, message, priority and the token', async () => {
  const srv = await fakeServer();
  const log = path.join(tempDir('notify-log-'), 'notify.log');
  try {
    const ok = await postNotice({ ...SETTINGS, url: srv.url, priority: 4 }, { title: '비서', message: '다 됐어요 ✅', click: 'https://claude.ai/code/session_01A' }, { token: 'tk_test', logFile: log });
    assert.equal(ok, true);
    assert.equal(srv.got.length, 1);
    assert.equal(srv.got[0].method, 'POST');
    assert.equal(srv.got[0].url, '/');
    assert.equal(srv.got[0].auth, 'Bearer tk_test');
    assert.deepEqual(JSON.parse(srv.got[0].body), { topic: 'secretary-test', title: '비서', message: '다 됐어요 ✅', priority: 4, click: 'https://claude.ai/code/session_01A' });
    assert.equal(fs.existsSync(log), false, 'nothing logged on success');
  } finally {
    await srv.close();
  }
  assert.equal(ntfyRequest(SETTINGS, { title: 't', message: 'm' }, null).init.headers && 'Authorization' in (ntfyRequest(SETTINGS, { title: 't', message: 'm' }, null).init.headers as object), false);
});

test('post: a server that is not there or does not answer in time is one log line, never thrown', async () => {
  const log = path.join(tempDir('notify-log-'), 'notify.log');
  const srv = await fakeServer();
  const gone = srv.url;
  await srv.close();
  assert.equal(await postNotice({ ...SETTINGS, url: gone }, { title: 't', message: 'm' }, { logFile: log }), false);
  const hang = await fakeServer(true);
  const started = Date.now();
  try {
    assert.equal(await postNotice({ ...SETTINGS, url: hang.url, timeoutMs: 300 }, { title: 't', message: 'm' }, { logFile: log }), false);
    assert.ok(Date.now() - started < 2000, 'gives up at the timeout');
  } finally {
    await hang.close();
  }
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ntfy 실패/);
  assert.match(lines[1], /300ms 시간 초과/);
});
