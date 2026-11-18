import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { type ConsolidateReport } from '../src/memory/consolidate-notice.ts';
import { runIdleJobs } from '../src/idle/idle-jobs.ts';
import type { Store } from '../src/store/store.ts';
import { talk, tempStore } from './helpers.ts';

const MIN = 60_000;
const okReport = (s: Store): Promise<ConsolidateReport> => Promise.resolve({ at: new Date().toISOString(), ok: true, text: '보고', fromLogId: 0, throughLogId: s.logAfter(0).at(-1)!.id });

test('idle jobs: the board after 10 quiet minutes, consolidation after 30 with 60 waiting, nothing while talk goes on', async () => {
  const s = tempStore();
  const now = Date.now();
  talk(s, 61, now - 5 * MIN);
  const calls: string[] = [];
  const deps = { now, dirs: [], updateBoard: async () => void calls.push('board'), consolidate: async (st: Store) => (calls.push('consolidate'), okReport(st)) };
  assert.match((await runIdleJobs(s, deps)).join(), /할 일 없음 \(대화 멈춘 지 5분, 정리 대기 61건\)/);
  assert.deepEqual(calls, []);

  assert.deepEqual(await runIdleJobs(s, { ...deps, now: now + 6 * MIN }), ['board'], '11 minutes quiet: board only');
  assert.deepEqual(await runIdleJobs(s, { ...deps, now: now + 26 * MIN }), ['board', 'consolidate'], 'the fake board rewrite never catches up, so it runs again');

  // A consolidation still running (another tick) is not started twice.
  s.setMeta('consolidate_job', JSON.stringify({ startedAt: new Date(now + 20 * MIN).toISOString() }));
  calls.length = 0;
  await runIdleJobs(s, { ...deps, now: now + 26 * MIN });
  assert.deepEqual(calls, ['board']);
  // A failed one waits an hour before the next try.
  s.setMeta('consolidate_job', JSON.stringify({ startedAt: new Date(now + 20 * MIN).toISOString(), done: true, ok: false }));
  calls.length = 0;
  await runIdleJobs(s, { ...deps, now: now + 50 * MIN });
  assert.deepEqual(calls, ['board']);
  calls.length = 0;
  await runIdleJobs(s, { ...deps, now: now + 90 * MIN });
  assert.deepEqual(calls, ['board', 'consolidate']);
});
