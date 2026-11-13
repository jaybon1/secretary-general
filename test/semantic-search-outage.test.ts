import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SemanticSearch } from '../src/semantic-search/client.ts';

// The server's files sit next to SECRETARY_DB, read once when core/config.ts loads: point it at a temp folder
// before anything imports core/config.ts (helpers.ts does too), so these tests never touch the real server's files.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-test-')), 'test.db');
process.env.SECRETARY_DB = dbPath;
// The model folder too: the fingerprint test writes a fake model file there.
const modelDir = path.join(path.dirname(dbPath), 'models');
process.env.SECRETARY_SEMANTIC_SEARCH_MODEL_DIR = modelDir;
// Plenty of free memory unless a test says otherwise, so a "memory suspected" guess never depends on this PC.
process.env.SECRETARY_TEST_FREE_MB = '8000';
const { keepTidy, tempStore } = await import('./helpers.ts');
keepTidy(path.dirname(dbPath));
const {
  EMBED_MODEL,
  FAILURE_LOG,
  FAILURE_LOG_LINES,
  SERVER_NEED_MB,
  NOTICE,
  STOPPED_NOTICE,
  outageNotice,
  noticeTag,
  ASK_GUIDE,
  RESTART_GUIDE,
  ensureServer,
  failureCause,
  serverNeedMb,
  lowMemoryNotice,
  noteFailure,
  noteRecovery,
  readDown,
  retryServer,
} = await import('../src/semantic-search/client.ts');
const { promptContext } = await import('../src/hooks/prompt-memory.ts');
const STATE = `${dbPath}.semantic-search-server.json`;
const DOWN = `${dbPath}.semantic-search-server-down.json`;
const MEMORY = `${dbPath}.semantic-search-server-memory.json`;
assert.equal((await import('../src/core/config.ts')).DB_PATH, dbPath);

/** A pid that surely belongs to no live process: one that just exited. */
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid!;

/** helpers.ts turns semantic search off for every test; these tests need it on, without a real server. */
function fresh(): void {
  delete process.env.SECRETARY_SEMANTIC_SEARCH;
  process.env.SECRETARY_TEST_FREE_MB = '8000';
  for (const f of [STATE, DOWN, FAILURE_LOG, MEMORY, `${dbPath}.semantic-search-misses.json`]) fs.rmSync(f, { force: true });
}

/** A fake start: "spawns" a server that is this (live) process, and counts, noting which starts download the model first. */
function counter() {
  const c = { starts: 0, refetches: [] as boolean[], start: (refetch: boolean) => (c.starts++, c.refetches.push(refetch), process.pid) };
  return c;
}

/** What the server does with --refetch before downloading: marks the outage. */
const markRefetched = () => fs.writeFileSync(DOWN, JSON.stringify({ ...readDown(), refetched: true }));

const logLines = () => fs.readFileSync(FAILURE_LOG, 'utf8').trimEnd().split('\n');

test('a gone server is started at once, and only once while it is starting', () => {
  fresh();
  const c = counter();
  assert.equal(ensureServer(Date.now(), c.start).status, 'started');
  // The state file is the lock: a second prompt sees a server starting, not a missing one.
  assert.equal(ensureServer(Date.now(), c.start).status, 'loading');
  assert.equal(c.starts, 1);
  // Starting it is not a failure: no notice, no log.
  assert.equal(readDown(), null);
  assert.equal(fs.existsSync(FAILURE_LOG), false);
});

test('an idled-out server (no state file left) is restarted silently', () => {
  fresh();
  const c = counter();
  ensureServer(Date.now(), c.start);
  assert.equal(outageNotice('A'), '');
});

test('after any other failure every check starts it again, with no wait and no download', () => {
  fresh();
  const c = counter();
  for (let i = 1; i <= 3; i++) {
    noteFailure(new Error('onnxruntime_binding.node: The specified module could not be found'));
    assert.equal(ensureServer(Date.now(), c.start).status, 'started');
    fs.rmSync(STATE); // the started helper fails too
  }
  assert.deepEqual(c.refetches, [false, false, false]);
  assert.equal(readDown()!.failures, 3);
});

test('a missing or broken model is downloaded again once; failing after that stops the restarts', () => {
  fresh();
  const c = counter();
  noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
  outageNotice('A');
  assert.equal(ensureServer(Date.now(), c.start).status, 'started');
  // The download runs in the server, which holds the start lock: prompts meanwhile see it loading.
  assert.equal(ensureServer(Date.now(), c.start).status, 'loading');
  markRefetched();
  fs.rmSync(STATE);
  noteFailure(new Error('Load model from x failed: Protobuf parsing failed.'));
  assert.match(logLines().at(-1)!, /모델 파일 깨짐 · .* · 다시 받았는데도 실패, 사용자 확인 필요$/);
  for (let i = 0; i < 3; i++) assert.equal(ensureServer(Date.now(), c.start).status, 'stopped');
  assert.deepEqual(c.refetches, [true]);
  // A session told about the outage is told again, with the stop.
  assert.equal(outageNotice('A'), noticeTag(STOPPED_NOTICE, ASK_GUIDE));
  assert.match(STOPPED_NOTICE, /다시 받았는데도 실패, 사용자 확인 필요/);
  assert.equal(outageNotice('A'), '');
});

test('a failed download stops the restarts too', () => {
  fresh();
  const c = counter();
  noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
  ensureServer(Date.now(), c.start);
  markRefetched();
  fs.rmSync(STATE);
  noteFailure(new Error('모델 다시 받기 실패: no-such/repo 파일 목록 HTTP 401'));
  assert.match(logLines().at(-1)!, /모델 다시 받기 실패 · .* · 다시 받았는데도 실패, 사용자 확인 필요$/);
  assert.equal(ensureServer(Date.now(), c.start).status, 'stopped');
  assert.deepEqual(c.refetches, [true]);
});

test('after a stop, the user asking or new model files allow another try', () => {
  fresh();
  const c = counter();
  const stop = () => {
    noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
    markRefetched();
    noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
    assert.equal(ensureServer(Date.now(), c.start).status, 'stopped');
  };
  stop();
  retryServer();
  assert.match(logLines().at(-1)!, /사용자 요청으로 다시 시도$/);
  // The user's retry gets a download of its own.
  assert.equal(ensureServer(Date.now(), c.start).status, 'started');
  assert.deepEqual(c.refetches, [true]);
  fs.rmSync(STATE);
  stop();
  // Someone put model files in place: start it as is, without another download.
  const modelPath = path.join(modelDir, ...EMBED_MODEL.split('/'));
  fs.mkdirSync(modelPath, { recursive: true });
  fs.writeFileSync(path.join(modelPath, 'config.json'), '{}');
  assert.equal(ensureServer(Date.now(), c.start).status, 'started');
  assert.deepEqual(c.refetches, [true, false]);
  assert.match(logLines().at(-1)!, /모델 파일이 바뀌어 다시 시도$/);
  fs.rmSync(modelDir, { recursive: true });
});

test('a lack of memory stops the restarts and asks, with what the server needs and what is free now', () => {
  fresh();
  const c = counter();
  // Session A was told of an earlier failure in the same outage.
  noteFailure('boom');
  assert.equal(outageNotice('A'), noticeTag(NOTICE, RESTART_GUIDE));
  noteFailure(new Error('std::bad_alloc'), Date.now(), 300);
  for (let i = 0; i < 3; i++) assert.equal(ensureServer(Date.now(), c.start).status, 'low-memory');
  assert.equal(c.starts, 0);
  assert.deepEqual(readDown()!.lowMemory, { freeMb: 300, needMb: SERVER_NEED_MB });
  // Free memory is read when the notice goes out, not when it failed.
  process.env.SECRETARY_TEST_FREE_MB = '700';
  const ask = outageNotice('B');
  assert.equal(ask, noticeTag(lowMemoryNotice(SERVER_NEED_MB, 700), ASK_GUIDE));
  assert.equal(lowMemoryNotice(1500, 700), '메모리가 부족해 의미 검색 서버가 꺼졌어요(의미 검색 서버에 약 1.5GB 필요, 지금 남은 메모리 약 0.7GB). 그동안 단어 검색만 씁니다. 다시 켤까요?');
  // A session told before the stop is asked too, once.
  assert.equal(outageNotice('A'), ask);
  assert.equal(outageNotice('A'), '');

  // The user says start it: one start, without a download.
  retryServer();
  assert.match(logLines().at(-1)!, /사용자 요청으로 다시 시도$/);
  assert.equal(ensureServer(Date.now(), c.start).status, 'started');
  assert.deepEqual(c.refetches, [false]);
  // Out of memory again: stopped again, and asked again.
  fs.rmSync(STATE);
  noteFailure(new Error('Failed to allocate memory for requested buffer'), Date.now(), 400);
  assert.match(logLines().at(-1)!, /메모리 부족 · 남은 메모리 400MB · .* · 메모리 부족으로 멈춤, 사용자 확인 필요$/);
  assert.equal(ensureServer(Date.now(), c.start).status, 'low-memory');
  assert.equal(c.starts, 1);
  assert.match(outageNotice('A'), /다시 켤까요\?/);
  // This time it comes up: the outage is over.
  retryServer();
  assert.equal(ensureServer(Date.now(), c.start).status, 'started');
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: 4321 }));
  noteRecovery();
  assert.equal(readDown(), null);
  assert.deepEqual(ensureServer(Date.now(), c.start), { status: 'ready', port: 4321 });
});

test('a crash or unknown failure with less free memory than the server needs counts as a lack of memory', () => {
  fresh();
  process.env.SECRETARY_TEST_FREE_MB = '900';
  fs.writeFileSync(STATE, JSON.stringify({ pid: DEAD_PID, port: 5000 }));
  const c = counter();
  assert.equal(ensureServer(Date.now(), c.start).status, 'low-memory');
  assert.equal(c.starts, 0);
  assert.match(logLines()[0], /비정상 종료\(메모리 부족 의심\) · 남은 메모리 900MB/);
  fresh();
  noteFailure('boom', Date.now(), 900);
  assert.equal(ensureServer(Date.now(), c.start).status, 'low-memory');
});

test('the memory the server needs is its own recorded peak once it has one', () => {
  fresh();
  assert.equal(serverNeedMb(), SERVER_NEED_MB);
  fs.writeFileSync(MEMORY, JSON.stringify({ needMb: 1234, at: '2026-10-27T00:00:00Z' }));
  assert.equal(serverNeedMb(), 1234);
  assert.equal(failureCause('boom', 1300), '원인 미상');
  assert.equal(failureCause('boom', 1200), '원인 미상(메모리 부족 의심)');
  noteFailure('boom', Date.now(), 1000);
  assert.match(outageNotice('A'), /약 1\.3GB 필요/);
});

test('a state file left behind by a dead server counts as a crash, and it is restarted', () => {
  fresh();
  fs.writeFileSync(STATE, JSON.stringify({ pid: DEAD_PID, port: 5000 }));
  const c = counter();
  assert.equal(ensureServer(Date.now(), c.start).status, 'started');
  assert.equal(c.starts, 1);
  assert.match(readDown()!.error, new RegExp(`^비정상 종료\\(pid ${DEAD_PID}\\)`));
  assert.match(logLines()[0], /실패 · 연속 1번째 · 비정상 종료/);
});

test('a live server is used as is and nothing is started', () => {
  fresh();
  const never = () => assert.fail('started');
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: 4321 }));
  assert.deepEqual(ensureServer(Date.now(), never), { status: 'ready', port: 4321 });
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: null }));
  assert.equal(ensureServer(Date.now(), never).status, 'loading');
});

test('each failure is logged with time, cause, count and free memory; the recovery too', () => {
  fresh();
  const t = Date.parse('2026-10-27T00:00:05Z');
  noteFailure(new Error('Could not locate file: "x/model_quantized.onnx".\n    at stack'), t, 8000);
  noteFailure(new Error('std::bad_alloc'), t + 1000, 300);
  noteRecovery(t + 2000);
  assert.deepEqual(logLines(), [
    '2026-10-27 09:00:05 실패 · 연속 1번째 · 모델 파일 없음 · 남은 메모리 8000MB · Could not locate file: "x/model_quantized.onnx"',
    '2026-10-27 09:00:06 실패 · 연속 2번째 · 메모리 부족 · 남은 메모리 300MB · std::bad_alloc · 메모리 부족으로 멈춤, 사용자 확인 필요',
    '2026-10-27 09:00:07 회복 · 연속 실패 2번 뒤',
  ]);
  assert.equal(readDown(), null);
  // A recovery with no outage logs nothing.
  noteRecovery(t + 3000);
  assert.equal(logLines().length, 3);
});

test('the failure log keeps only its last lines', () => {
  fresh();
  fs.writeFileSync(FAILURE_LOG, Array.from({ length: FAILURE_LOG_LINES + 20 }, (_, i) => `old ${i}`).join('\n') + '\n');
  noteFailure('boom');
  const lines = logLines();
  assert.equal(lines.length, FAILURE_LOG_LINES);
  assert.equal(lines[0], 'old 21');
  assert.match(lines.at(-1)!, /boom$/);
});

test('causes are guessed from the error text and free memory', () => {
  assert.equal(failureCause('Could not locate file: "a.onnx"', 8000), '모델 파일 없음');
  assert.equal(failureCause('Load model from x failed: Protobuf parsing failed', 8000), '모델 파일 깨짐');
  assert.equal(failureCause('std::bad_alloc', 8000), '메모리 부족');
  assert.match(failureCause('onnxruntime_binding.node: The specified module could not be found', 8000), /^실행 라이브러리/);
  assert.equal(failureCause('비정상 종료(pid 1)', 900), '비정상 종료(메모리 부족 의심)');
  assert.equal(failureCause('something else', 8000), '원인 미상');
});

test('each session is told once per real outage, and again in the next one', () => {
  fresh();
  noteFailure('boom');
  const first = outageNotice('A');
  assert.equal(first, noticeTag(NOTICE, RESTART_GUIDE));
  assert.equal(outageNotice('A'), '');
  noteFailure('boom again'); // still the same outage
  assert.equal(outageNotice('A'), '');
  assert.notEqual(outageNotice('B'), '');
  // The server is up: the outage is over, recorded as a recovery.
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: 4321 }));
  assert.equal(outageNotice('A'), '');
  assert.equal(readDown(), null);
  assert.match(logLines().at(-1)!, /회복 · 연속 실패 2번 뒤/);
  fs.rmSync(STATE);
  noteFailure('boom');
  assert.notEqual(outageNotice('A'), '');
});

// [늘 남김] 없으면 놓치는 실수: 의미 검색 서버의 고장 기록 파일이 깨졌을 때 질문 훅이 죽어 기억 주입이 통째로 빠진다(기억 주입).
test('a broken down file never breaks the prompt hook', () => {
  fresh();
  fs.writeFileSync(DOWN, JSON.stringify({ since: 1, told: null }));
  assert.equal(outageNotice('A'), '');
  fs.writeFileSync(DOWN, '{half');
  assert.equal(outageNotice('A'), '');
});

test('the prompt hook puts the notice ahead of the memories, once', async () => {
  fresh();
  // A server "loading" (this live process), so the hook starts no real one.
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: null }));
  noteFailure('boom');
  const s = tempStore();
  s.remember({ kind: 'fact', content: '사용자는 치과 예약을 했다.' });
  // The searches themselves are not under test here (waiting: below): they give nothing and report no miss.
  const quiet = () => [async () => null, async () => null] as [SemanticSearch, SemanticSearch];
  const first = await promptContext(s, '치과 예약', 'S1', undefined, quiet);
  assert.match(first, /^<secretary-semantic-search-server>.*<\/secretary-semantic-search-server>\n<secretary-memory>/);
  const second = await promptContext(s, '치과 예약 언제였지', 'S1', undefined, quiet);
  assert.doesNotMatch(second, /secretary-semantic-search-server/);
  // With nothing to recall, the notice still goes out on its own.
  assert.match(await promptContext(s, '아무 상관 없는 말', 'S2', undefined, quiet), /^<secretary-semantic-search-server>.*<\/secretary-semantic-search-server>$/);
});

// 없으면 놓치는 실수: 의미 검색 서버가 답하지 않을 때 기능마다 조용히 단어 검색으로 넘어가, 비서가 원인을 모른 채 뜻이 같은 기억을 놓친다
// (출처 재검토 C9를 넓힘, 2026-11-13 사용자 결정): 실패는 기능 이름·이유·시각과 함께 한 파일에 쌓이고, 2분 넘게 이어지면 세션마다 한 번 알린다.
test('every search the server does not answer is recorded with the feature and why, and a long streak is told once per session', async () => {
  fresh();
  const { missLogFile, missNotice, semanticClient } = await import('../src/semantic-search/client.ts');
  const log = missLogFile();
  assert.equal(log, process.env.SECRETARY_SEMANTIC_SEARCH_MISS_LOG, 'tests write into their own file');
  fs.rmSync(log, { force: true });
  const lines = () => fs.readFileSync(log, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { feature: string; reason: string; at: string });
  const reasons: string[] = [];
  // Loading (this live process holds the state file without a port): no results, one line, the caller told why.
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: null }));
  assert.equal(await semanticClient(500, 'recall 도구', (r) => reasons.push(r))('치과', { limit: 5 }), null);
  assert.deepEqual(reasons, ['서버가 모델을 불러오는 중']);
  assert.deepEqual(lines().map((l) => [l.feature, l.reason]), [['recall 도구', '서버가 모델을 불러오는 중']]);
  // A server that takes too long: a timeout, recorded the same way.
  const http = await import('node:http');
  const slow = http.createServer(() => {});
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
  const port = (slow.address() as { port: number }).port;
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port }));
  assert.equal(await semanticClient(100, '질문마다 기억 자동 주입(질문)')('치과', { limit: 5 }), null);
  slow.closeAllConnections();
  slow.close();
  assert.deepEqual(lines().at(-1)!.reason, '시간 초과(100ms)');
  // Short streaks tell nobody; past two minutes each session once, and not while the outage notice speaks.
  const streak = `${dbPath}.semantic-search-misses.json`;
  const since = Date.parse(JSON.parse(fs.readFileSync(streak, 'utf8')).since);
  assert.equal(missNotice('S1', false, since + 60_000), '');
  const told = missNotice('S1', false, since + 3 * 60_000);
  assert.match(told, /^<secretary-semantic-search-server>의미 검색이 [^<]*약 3분째 답하지 않아 단어 검색만 쓰고 있어요\(이유: [^)]*서버가 모델을 불러오는 중 1번[^)]*시간 초과\(100ms\) 1번 · 기능: [^)]*recall 도구 1번[^<]*비서 할 일:[^<]*semantic-search-misses\.jsonl/);
  assert.equal(missNotice('S1', false, since + 4 * 60_000), '', 'once per session');
  assert.equal(missNotice('S2', true, since + 4 * 60_000), '', 'the outage notice speaks instead');
  assert.match(missNotice('S2', false, since + 4 * 60_000), /secretary-semantic-search-server/);
  // Turned off by setting: no miss at all.
  process.env.SECRETARY_SEMANTIC_SEARCH = 'off';
  const before = lines().length;
  assert.equal(await semanticClient(100, 'recall 도구')('치과', { limit: 5 }), null);
  assert.equal(lines().length, before);
  // The server answers: the streak ends with a line saying so.
  delete process.env.SECRETARY_SEMANTIC_SEARCH;
  const ok = http.createServer((_q, res) => res.end(JSON.stringify({ median: 0.3, hits: [] })));
  await new Promise<void>((r) => ok.listen(0, '127.0.0.1', () => r()));
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: (ok.address() as { port: number }).port }));
  assert.deepEqual(await semanticClient(2000, 'recall 도구')('치과', { limit: 5 }), { median: 0.3, hits: [] });
  ok.close();
  assert.match(lines().at(-1)!.reason, /^회복: 응답함\(실패 2번/);
  assert.equal(fs.existsSync(streak), false);
  fs.rmSync(log, { force: true });
  fresh();
});

// 없으면 놓치는 실수: 의미 검색 서버가 늦거나 꺼져 있으면 기능마다 바로 단어 검색으로 넘어가 뜻이 같은 기억을 놓치고(2026-11-13 사용자 결정), run-job·업무 세션·정리 담당이 서버를 띄워 그 수명이 엉뚱한 프로세스에 묶인다.
test('waiting: a server coming up is waited for; only a process allowed to (the secretary\'s side) starts it; a stopped one ends the wait at once', async () => {
  fresh();
  const { allowServerStart, semanticClient, serverStartAllowed } = await import('../src/semantic-search/client.ts');
  const http = await import('node:http');
  assert.equal(serverStartAllowed(), false, 'off until the process says so');
  // Not allowed: a gone server is not started, and the wait ends with why.
  let started = 0;
  assert.equal(ensureServer(Date.now(), () => (started++, 1), false).status, 'absent');
  assert.equal(started, 0);
  assert.equal(fs.existsSync(STATE), false);
  const reasons: string[] = [];
  const t0 = Date.now();
  assert.equal(await semanticClient(1000, 'recall 도구', (r) => reasons.push(r), { waitMs: 300, pollMs: 50 })('치과', { limit: 5 }), null);
  assert.ok(Date.now() - t0 >= 280, 'it waited');
  assert.match(reasons[0], /^서버가 꺼져 있음\(여기서는 띄우지 않고/);
  // Loading, then up within the wait: the search is answered.
  const ok = http.createServer((_q, res) => res.end(JSON.stringify({ median: 0.2, hits: [{ id: 1, sim: 0.9 }] })));
  await new Promise<void>((r) => ok.listen(0, '127.0.0.1', () => r()));
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: null }));
  setTimeout(() => fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: (ok.address() as { port: number }).port })), 150);
  assert.deepEqual(await semanticClient(2000, 'recall 도구', undefined, { waitMs: 3000, pollMs: 50 })('치과', { limit: 5 }), { median: 0.2, hits: [{ id: 1, sim: 0.9 }] });
  ok.close();
  // Stopped for the user: no wait at all, even when allowed to start.
  fs.rmSync(STATE, { force: true });
  allowServerStart();
  fs.writeFileSync(DOWN, JSON.stringify({ since: new Date().toISOString(), error: 'x', told: [], lowMemory: { needMb: 1500, freeMb: 100 } }));
  const t1 = Date.now();
  const why: string[] = [];
  assert.equal(await semanticClient(1000, 'recall 도구', (r) => why.push(r), { waitMs: 5000, pollMs: 50 })('치과', { limit: 5 }), null);
  assert.ok(Date.now() - t1 < 2000);
  assert.match(why[0], /메모리 부족/);
  allowServerStart(false);
  fresh();
});

// 없으면 놓치는 실수: 기다려도 의미 검색이 안 되면 비서가 아무 말 없이 단어 검색 결과로 답하거나, 질문 훅이 질문을 막아 대화가 멈춘다. 사용자가 "단어 검색으로 답해"라고 하면 그 대화에서는 다시 묻지 않는다.
test('the prompt: a failed search asks first (not blocked); "단어 검색으로 답해" goes on with word search in that conversation only', async () => {
  fresh();
  const s = tempStore();
  s.remember({ kind: 'fact', content: '치과는 매달 첫째 주에 간다.' });
  let called = 0;
  const failing = (onMiss: (why: string) => void) => {
    const f = async () => (called++, onMiss('서버가 꺼져 있음, 90초 기다림'), null);
    return [f, f] as [typeof f, typeof f];
  };
  const asked = await promptContext(s, '치과 언제 가?', 'W1', undefined, failing);
  assert.match(asked, /^<secretary-semantic-search-server>의미 검색 서버가 기다려도 답하지 않아\(이유: 서버가 꺼져 있음, 90초 기다림\)[^<]*원래 질문에 답하기 전에[^<]*단어 검색으로 답해/);
  assert.match(asked, /치과는 매달 첫째 주/, 'the word-search memories still come');
  called = 0;
  const words = await promptContext(s, '단어 검색으로 답해', 'W1', undefined, failing);
  assert.equal(called, 0);
  assert.doesNotMatch(words, /secretary-semantic-search-server/);
  assert.doesNotMatch(await promptContext(s, '치과 또 언제?', 'W1', undefined, failing), /secretary-semantic-search-server/);
  assert.equal(called, 0, 'that conversation stays on word search');
  assert.match(await promptContext(s, '치과 언제?', 'W2', undefined, failing), /원래 질문에 답하기 전에/, 'another conversation still asks');
  await promptContext(s, '의미 검색 다시 켜', 'W1', undefined, failing);
  assert.ok(called > 0, 'asking for the server back ends it');
  fresh();
});
