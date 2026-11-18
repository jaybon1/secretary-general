// Stalled jobs told through job-stalls.jsonl (src/workspace/job-stalls.ts): the tool's record and in-a-row count, the
// watcher's read (job-stall watch) and the prompt hook's notice. Each test uses its own folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import {
  clearStreak,
  jobKey,
  recordStall,
  STALLS_FILE,
  STREAK_WINDOW_MS,
  type StallInput,
} from '../src/workspace/job-stalls.ts';

const job = (over: Partial<StallInput> = {}): StallInput => ({
  source: 'external-device-job',
  job: 'ffmpeg',
  toolArgs: '-i "{in}\\a.mp4" "{out}\\b.mp4"',
  inputs: ['a.mp4'],
  device: 'QX7K(pc-a)',
  cwd: 'C:\\w\\space-a',
  stage: '3단계(실행)',
  evidence: '10분 동안 변화 없음',
  ...over,
});

// 없으면 놓치는 실수: 같은 작업이 연달아 멈춰도 횟수가 늘지 않아 비서를 깨우지 못하거나, 사이에 멀쩡히 끝난 실행·다른 인자의 작업·하루 지난 멈춤까지
// 연달아로 세어 헛되이 깨운다. 결과를 이미 받은 뒤의 정리 멈춤도 세면 다시 돌릴 필요 없는 작업으로 깨운다.
test('the same job (kind, args, inputs) stalling again counts in a row; a finished run, another job, a day apart or a note do not', () => {
  const dir = tempDir();
  const t0 = Date.parse('2026-11-17T01:00:00Z');
  assert.equal(recordStall(job(), { dir, now: t0 }).streak, 1);
  assert.equal(recordStall(job(), { dir, now: t0 + 60_000 }).streak, 2);
  assert.equal(recordStall(job({ toolArgs: '-i other' }), { dir, now: t0 + 61_000 }).streak, 1, 'other args: another job');
  assert.notEqual(jobKey(job()), jobKey(job({ inputs: ['b.mp4'] })));
  assert.equal(recordStall(job({ countStreak: false, stage: '5단계(정리)' }), { dir, now: t0 + 62_000 }).streak, 0, 'a note is not counted');
  assert.equal(recordStall(job(), { dir, now: t0 + 63_000 }).streak, 3, 'and does not break the count either');
  clearStreak(job(), dir);
  assert.equal(recordStall(job(), { dir, now: t0 + 64_000 }).streak, 1, 'a run that did not stall starts it again');
  assert.equal(recordStall(job(), { dir, now: t0 + 64_000 + STREAK_WINDOW_MS + 1 }).streak, 1, 'a day apart starts again');
  const lines = fs.readFileSync(path.join(dir, STALLS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 7);
  assert.deepEqual(Object.keys(lines[0]).slice(0, 7), ['at', 'source', 'job', 'key', 'stage', 'evidence', 'streak']);
  assert.equal(lines[0].cwd, 'C:\\w\\space-a');
});
