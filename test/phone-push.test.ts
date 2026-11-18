import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write as writeFile } from './helpers.ts';
import { NO_MODEL_ENV } from '../src/core/no-model-calls.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { alertServer, clearServerAlert, main as serverAlertMain, RESTART_LOOP_MINUTES } from '../scripts/phone-push/server-alert.ts';
import { planNotice, sessionName, type Notice, type NotifySettings, notifyAfterStop } from '../src/phone-push/ntfy.ts';

const SETTINGS: NotifySettings = { url: 'http://127.0.0.1:2586', topic: 'secretary-test', title: '{session}', priority: 4, click: null, tokenFile: null, timeoutMs: 2500 };
/** An environment without the tests' no-model mark (only for planNotice, which never sends). */
const LIVE_ENV: NodeJS.ProcessEnv = { ...process.env, [NO_MODEL_ENV]: '' };
/** A copy where the feature is on (no features.json: every feature on), so this runs the same in the release, where it ships off. */
const ON = { env: LIVE_ENV, root: tempDir('notify-on-') };
/** Writes a file and gives its path. */
const write = (file: string, text = ''): string => (writeFile(file, text), file);

// ---- the first line ---------------------------------------------------------------------------------------------------

// ---- settings ---------------------------------------------------------------------------------------------------------

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

// ---- the POST ---------------------------------------------------------------------------------------------------------

// ---- the server's stuck states (scripts/phone-push/server-alert.ts, called by scripts/remote-server/remote-server.ps1) -------

// [늘 남김] 없으면 놓치는 실수: 시험을 돌릴 때 실제 폰 알림이 보내진다.
test('in tests nothing is ever handed to the sender, settings or not', () => {
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

// 없으면 놓치는 실수: 비서 서버가 로그인이 풀리거나 연결되지 못한 채 계속 다시 켜져도 폰에 알리지 않아 사용자는 오프라인인 까닭을 모르거나,
// 같은 상태가 이어지는 동안 5분마다 되풀이해 보내거나, 보내지 못한 알림을 보낸 것으로 쳐서 다시 시도하지 않는다.
test('server alert: a stuck state is sent once until it clears, a failed send is tried again, nothing without settings or in a test run', async () => {
  const state = path.join(tempDir('server-alert-'), 'server-a', 'phone-alert.json');
  const sent: Notice[] = [];
  let ok = true;
  const d = { env: LIVE_ENV, root: ON.root, settings: { ...SETTINGS, click: 'https://claude.ai/code' }, send: async (_s: NotifySettings, n: Notice) => (sent.push(n), ok) };
  assert.match(await alertServer(state, '비서', 'login', undefined, d), /^보냄\(login\)/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '비서');
  assert.match(sent[0].message, /로그인이 풀렸어요.*claude auth login/);
  assert.equal(sent[0].click, 'https://claude.ai/code');
  assert.match(await alertServer(state, '비서', 'login', undefined, d), /^이미 알림/);
  assert.equal(sent.length, 1, 'the same state is not sent again');
  // Another problem is new; clearing one that is not the kept one leaves it.
  assert.match(await alertServer(state, '비서', 'restart-loop', '69', d), /^보냄\(restart-loop\)/);
  assert.match(sent[1].message, new RegExp(`${RESTART_LOOP_MINUTES}분 넘게.*종료 코드 69`));
  assert.equal(clearServerAlert(state, 'login'), '');
  assert.ok(fs.existsSync(state));
  assert.match(clearServerAlert(state, 'restart-loop'), /풀림\(restart-loop\)/);
  assert.ok(!fs.existsSync(state));
  assert.equal(clearServerAlert(state, 'all'), '', 'nothing to clear');
  // The server did not take it: not kept, so the next call tries again.
  ok = false;
  assert.match(await alertServer(state, '비서-b', 'login', undefined, d), /^못 보냄/);
  assert.ok(!fs.existsSync(state));
  ok = true;
  assert.match(await alertServer(state, '비서-b', 'login', undefined, d), /^보냄/);
  assert.equal(sent.length, 4);
  assert.match(clearServerAlert(state, 'all'), /풀림/);
  assert.match(await alertServer(state, '비서', 'login', undefined, { ...d, settings: null }), /설정 없음/);
  assert.match(await alertServer(state, '비서', 'login', undefined, { ...d, env: process.env }), /시험 실행/);
  assert.equal(sent.length, 4);
  // The command line: a usage problem is told, not thrown.
  assert.equal((await serverAlertMain(['--state', state, '--problem', 'nope', '--server', 'x'], d)).ok, false);
  assert.equal((await serverAlertMain(['--state', state, '--clear', 'all'], d)).ok, true);
  // The server window calls it for both states, with the same restart-loop minutes.
  const ps = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'remote-server', 'remote-server.ps1'), 'utf8');
  for (const k of ['server-alert.ts', "'--problem', 'login'", "'--problem', 'restart-loop'", "Clear-ServerAlert 'login'", "Clear-ServerAlert 'restart-loop'", `$restartLoopMinutes = ${RESTART_LOOP_MINUTES}`]) assert.ok(ps.includes(k), k);
});