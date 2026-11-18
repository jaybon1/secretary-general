import assert from 'node:assert/strict';
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

// [늘 남김] 없으면 놓치는 실수: 의미 검색 서버의 고장 기록 파일이 깨졌을 때 질문 훅이 죽어 기억 주입이 통째로 빠진다(기억 주입).
test('a broken down file never breaks the prompt hook', () => {
  fresh();
  fs.writeFileSync(DOWN, JSON.stringify({ since: 1, told: null }));
  assert.equal(outageNotice('A'), '');
  fs.writeFileSync(DOWN, '{half');
  assert.equal(outageNotice('A'), '');
});

// [늘 남김] 없으면 놓치는 실수: 의미 검색 서버가 멈췄다는 안내가 관련 기억 뒤에 묻히거나 질문마다 되풀이된다.
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
  // With nothing to recall, the notice still goes out, ahead of the empty memory block.
  assert.match(await promptContext(s, '아무 상관 없는 말', 'S2', undefined, quiet), /^<secretary-semantic-search-server>.*<\/secretary-semantic-search-server>\n<secretary-memory>새로 붙일 관련 기억 없음[^<]*<\/secretary-memory>$/);
});
