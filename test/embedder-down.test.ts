import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// The helper's files sit next to SECRETARY_DB, read once when config.ts loads: point it at a temp folder
// before anything imports config.ts (helpers.ts does too), so these tests never touch the real helper's files.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-test-')), 'test.db');
process.env.SECRETARY_DB = dbPath;
// The model folder too: the fingerprint test writes a fake model file there.
const modelDir = path.join(path.dirname(dbPath), 'models');
process.env.SECRETARY_EMBED_MODEL_DIR = modelDir;
// Plenty of free memory unless a test says otherwise, so a "memory suspected" guess never depends on this PC.
process.env.SECRETARY_FREE_MB = '8000';
const { tempStore } = await import('./helpers.ts');
const {
  EMBED_MODEL,
  FAILURE_LOG,
  FAILURE_LOG_LINES,
  HELPER_NEED_MB,
  NOTICE,
  STOPPED_NOTICE,
  embedderNotice,
  noticeTag,
  ASK_GUIDE,
  RESTART_GUIDE,
  ensureHelper,
  failureCause,
  helperNeedMb,
  lowMemoryNotice,
  noteFailure,
  noteRecovery,
  readDown,
  retryEmbedder,
} = await import('../src/semantic.ts');
const { promptContext } = await import('../src/context.ts');
const STATE = `${dbPath}.embedder.json`;
const DOWN = `${dbPath}.embedder-down.json`;
const MEMORY = `${dbPath}.embedder-memory.json`;
assert.equal((await import('../src/config.ts')).DB_PATH, dbPath);

/** A pid that surely belongs to no live process: one that just exited. */
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid!;

/** helpers.ts turns semantic search off for every test; these tests need it on, without a real helper. */
function fresh(): void {
  delete process.env.SECRETARY_EMBED;
  process.env.SECRETARY_FREE_MB = '8000';
  for (const f of [STATE, DOWN, FAILURE_LOG, MEMORY]) fs.rmSync(f, { force: true });
}

/** A fake start: "spawns" a helper that is this (live) process, and counts, noting which starts download the model first. */
function counter() {
  const c = { starts: 0, refetches: [] as boolean[], start: (refetch: boolean) => (c.starts++, c.refetches.push(refetch), process.pid) };
  return c;
}

/** What the helper does with --refetch before downloading: marks the outage. */
const markRefetched = () => fs.writeFileSync(DOWN, JSON.stringify({ ...readDown(), refetched: true }));

const logLines = () => fs.readFileSync(FAILURE_LOG, 'utf8').trimEnd().split('\n');

test('a gone helper is started at once, and only once while it is starting', () => {
  fresh();
  const c = counter();
  assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
  // The state file is the lock: a second prompt sees a helper starting, not a missing one.
  assert.equal(ensureHelper(Date.now(), c.start).status, 'loading');
  assert.equal(c.starts, 1);
  // Starting it is not a failure: no notice, no log.
  assert.equal(readDown(), null);
  assert.equal(fs.existsSync(FAILURE_LOG), false);
});

test('an idled-out helper (no state file left) is restarted silently', () => {
  fresh();
  const c = counter();
  ensureHelper(Date.now(), c.start);
  assert.equal(embedderNotice('A'), '');
});

test('after any other failure every check starts it again, with no wait and no download', () => {
  fresh();
  const c = counter();
  for (let i = 1; i <= 3; i++) {
    noteFailure(new Error('onnxruntime_binding.node: The specified module could not be found'));
    assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
    fs.rmSync(STATE); // the started helper fails too
  }
  assert.deepEqual(c.refetches, [false, false, false]);
  assert.equal(readDown()!.failures, 3);
});

test('a missing or broken model is downloaded again once; failing after that stops the restarts', () => {
  fresh();
  const c = counter();
  noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
  embedderNotice('A');
  assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
  // The download runs in the helper, which holds the start lock: prompts meanwhile see it loading.
  assert.equal(ensureHelper(Date.now(), c.start).status, 'loading');
  markRefetched();
  fs.rmSync(STATE);
  noteFailure(new Error('Load model from x failed: Protobuf parsing failed.'));
  assert.match(logLines().at(-1)!, /모델 파일 깨짐 · .* · 다시 받았는데도 실패, 사용자 확인 필요$/);
  for (let i = 0; i < 3; i++) assert.equal(ensureHelper(Date.now(), c.start).status, 'stopped');
  assert.deepEqual(c.refetches, [true]);
  // A session told about the outage is told again, with the stop.
  assert.equal(embedderNotice('A'), noticeTag(STOPPED_NOTICE, ASK_GUIDE));
  assert.match(STOPPED_NOTICE, /다시 받았는데도 실패, 사용자 확인 필요/);
  assert.equal(embedderNotice('A'), '');
});

test('a failed download stops the restarts too', () => {
  fresh();
  const c = counter();
  noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
  ensureHelper(Date.now(), c.start);
  markRefetched();
  fs.rmSync(STATE);
  noteFailure(new Error('모델 다시 받기 실패: no-such/repo 파일 목록 HTTP 401'));
  assert.match(logLines().at(-1)!, /모델 다시 받기 실패 · .* · 다시 받았는데도 실패, 사용자 확인 필요$/);
  assert.equal(ensureHelper(Date.now(), c.start).status, 'stopped');
  assert.deepEqual(c.refetches, [true]);
});

test('after a stop, the user asking or new model files allow another try', () => {
  fresh();
  const c = counter();
  const stop = () => {
    noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
    markRefetched();
    noteFailure(new Error('Could not locate file: "onnx/model_quantized.onnx".'));
    assert.equal(ensureHelper(Date.now(), c.start).status, 'stopped');
  };
  stop();
  retryEmbedder();
  assert.match(logLines().at(-1)!, /사용자 요청으로 다시 시도$/);
  // The user's retry gets a download of its own.
  assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
  assert.deepEqual(c.refetches, [true]);
  fs.rmSync(STATE);
  stop();
  // Someone put model files in place: start it as is, without another download.
  const modelPath = path.join(modelDir, ...EMBED_MODEL.split('/'));
  fs.mkdirSync(modelPath, { recursive: true });
  fs.writeFileSync(path.join(modelPath, 'config.json'), '{}');
  assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
  assert.deepEqual(c.refetches, [true, false]);
  assert.match(logLines().at(-1)!, /모델 파일이 바뀌어 다시 시도$/);
  fs.rmSync(modelDir, { recursive: true });
});

test('a lack of memory stops the restarts and asks, with what the helper needs and what is free now', () => {
  fresh();
  const c = counter();
  // Session A was told of an earlier failure in the same outage.
  noteFailure('boom');
  assert.equal(embedderNotice('A'), noticeTag(NOTICE, RESTART_GUIDE));
  noteFailure(new Error('std::bad_alloc'), Date.now(), 300);
  for (let i = 0; i < 3; i++) assert.equal(ensureHelper(Date.now(), c.start).status, 'low-memory');
  assert.equal(c.starts, 0);
  assert.deepEqual(readDown()!.lowMemory, { freeMb: 300, needMb: HELPER_NEED_MB });
  // Free memory is read when the notice goes out, not when it failed.
  process.env.SECRETARY_FREE_MB = '700';
  const ask = embedderNotice('B');
  assert.equal(ask, noticeTag(lowMemoryNotice(HELPER_NEED_MB, 700), ASK_GUIDE));
  assert.equal(lowMemoryNotice(1500, 700), '메모리가 부족해 의미 검색 도우미가 꺼졌어요(도우미에 약 1.5GB 필요, 지금 남은 메모리 약 0.7GB). 그동안 단어 검색만 씁니다. 다시 켤까요?');
  // A session told before the stop is asked too, once.
  assert.equal(embedderNotice('A'), ask);
  assert.equal(embedderNotice('A'), '');

  // The user says start it: one start, without a download.
  retryEmbedder();
  assert.match(logLines().at(-1)!, /사용자 요청으로 다시 시도$/);
  assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
  assert.deepEqual(c.refetches, [false]);
  // Out of memory again: stopped again, and asked again.
  fs.rmSync(STATE);
  noteFailure(new Error('Failed to allocate memory for requested buffer'), Date.now(), 400);
  assert.match(logLines().at(-1)!, /메모리 부족 · 남은 메모리 400MB · .* · 메모리 부족으로 멈춤, 사용자 확인 필요$/);
  assert.equal(ensureHelper(Date.now(), c.start).status, 'low-memory');
  assert.equal(c.starts, 1);
  assert.match(embedderNotice('A'), /다시 켤까요\?/);
  // This time it comes up: the outage is over.
  retryEmbedder();
  assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: 4321 }));
  noteRecovery();
  assert.equal(readDown(), null);
  assert.deepEqual(ensureHelper(Date.now(), c.start), { status: 'ready', port: 4321 });
});

test('a crash or unknown failure with less free memory than the helper needs counts as a lack of memory', () => {
  fresh();
  process.env.SECRETARY_FREE_MB = '900';
  fs.writeFileSync(STATE, JSON.stringify({ pid: DEAD_PID, port: 5000 }));
  const c = counter();
  assert.equal(ensureHelper(Date.now(), c.start).status, 'low-memory');
  assert.equal(c.starts, 0);
  assert.match(logLines()[0], /비정상 종료\(메모리 부족 의심\) · 남은 메모리 900MB/);
  fresh();
  noteFailure('boom', Date.now(), 900);
  assert.equal(ensureHelper(Date.now(), c.start).status, 'low-memory');
});

test('the memory the helper needs is its own recorded peak once it has one', () => {
  fresh();
  assert.equal(helperNeedMb(), HELPER_NEED_MB);
  fs.writeFileSync(MEMORY, JSON.stringify({ needMb: 1234, at: '2026-10-27T00:00:00Z' }));
  assert.equal(helperNeedMb(), 1234);
  assert.equal(failureCause('boom', 1300), '원인 미상');
  assert.equal(failureCause('boom', 1200), '원인 미상(메모리 부족 의심)');
  noteFailure('boom', Date.now(), 1000);
  assert.match(embedderNotice('A'), /약 1\.3GB 필요/);
});

test('a state file left behind by a dead helper counts as a crash, and it is restarted', () => {
  fresh();
  fs.writeFileSync(STATE, JSON.stringify({ pid: DEAD_PID, port: 5000 }));
  const c = counter();
  assert.equal(ensureHelper(Date.now(), c.start).status, 'started');
  assert.equal(c.starts, 1);
  assert.match(readDown()!.error, new RegExp(`^비정상 종료\\(pid ${DEAD_PID}\\)`));
  assert.match(logLines()[0], /실패 · 연속 1번째 · 비정상 종료/);
});

test('a live helper is used as is and nothing is started', () => {
  fresh();
  const never = () => assert.fail('started');
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: 4321 }));
  assert.deepEqual(ensureHelper(Date.now(), never), { status: 'ready', port: 4321 });
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: null }));
  assert.equal(ensureHelper(Date.now(), never).status, 'loading');
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
  const first = embedderNotice('A');
  assert.equal(first, noticeTag(NOTICE, RESTART_GUIDE));
  assert.equal(NOTICE, '의미 검색 도우미가 꺼져 있어 다시 띄우는 중이에요. 살아날 때까지 기다려 주세요(그래도 진행하면 단어 검색만 씁니다)');
  assert.equal(embedderNotice('A'), '');
  noteFailure('boom again'); // still the same outage
  assert.equal(embedderNotice('A'), '');
  assert.notEqual(embedderNotice('B'), '');
  // The helper is up: the outage is over, recorded as a recovery.
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: 4321 }));
  assert.equal(embedderNotice('A'), '');
  assert.equal(readDown(), null);
  assert.match(logLines().at(-1)!, /회복 · 연속 실패 2번 뒤/);
  fs.rmSync(STATE);
  noteFailure('boom');
  assert.notEqual(embedderNotice('A'), '');
});

test('a broken down file never breaks the prompt hook', () => {
  fresh();
  fs.writeFileSync(DOWN, JSON.stringify({ since: 1, told: null }));
  assert.equal(embedderNotice('A'), '');
  fs.writeFileSync(DOWN, '{half');
  assert.equal(embedderNotice('A'), '');
});

test('the prompt hook puts the notice ahead of the memories, once', async () => {
  fresh();
  // A helper "loading" (this live process), so the hook starts no real one.
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: null }));
  noteFailure('boom');
  const s = tempStore();
  s.remember({ kind: 'fact', content: '사용자는 치과 예약을 했다.' });
  const first = await promptContext(s, '치과 예약', 'S1');
  assert.match(first, /^<secretary-embedder>.*<\/secretary-embedder>\n<secretary-memory>/);
  const second = await promptContext(s, '치과 예약 언제였지', 'S1');
  assert.doesNotMatch(second, /secretary-embedder/);
  // With nothing to recall, the notice still goes out on its own.
  assert.match(await promptContext(s, '아무 상관 없는 말', 'S2'), /^<secretary-embedder>.*<\/secretary-embedder>$/);
});
