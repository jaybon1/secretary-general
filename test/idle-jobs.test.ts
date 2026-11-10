import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { unseenReports, type ConsolidateReport } from '../src/memory/consolidate-notice.ts';
import { runIdleJobs } from '../src/idle/idle-jobs.ts';
import { claimConsolidate, consolidatePrompt, consolidateRunning, runConsolidate } from '../src/memory/consolidate-run.ts';
import { readStaff, staffFolder } from '../src/staff/staff.ts';
import { lastActivityMs } from '../src/log/catch-up.ts';
import type { Store } from '../src/store/store.ts';
import { talk, tempDir, tempStore } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { SECRETARY_SKILLS_DIR, skillFile } from '../src/core/paths.ts';
import { frontMatter } from '../src/setup/skill-spec.ts';

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

test('idle jobs: a transcript still being written counts as talk (a long turn is logged only when it ends)', () => {
  const s = tempStore();
  const now = Date.now();
  talk(s, 1, now - 60 * MIN);
  const dir = tempDir();
  const file = path.join(dir, 'live.jsonl');
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, new Date(now - 2 * MIN), new Date(now - 2 * MIN));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript');
  assert.ok(Math.abs(lastActivityMs(s, [dir]) - (now - 2 * MIN)) < 1000);
  assert.ok(Math.abs(lastActivityMs(s, []) - (now - 60 * MIN)) < 1000);
});

test('consolidation: a run that moved the watermark is a report to confirm; one that did not is a failure', async () => {
  const s = tempStore();
  talk(s, 3, Date.now());
  const last = s.logAfter(0).at(-1)!.id;
  let prompt = '';
  const ok = (await runConsolidate(s, 'idle', async (file) => {
    prompt = fs.readFileSync(file, 'utf8');
    s.markConsolidated(last);
    return '처리 범위 #1~#3, 새 기억 1개\n(새 세션) 세션: abc';
  })).report!;
  assert.equal(ok.ok, true);
  assert.equal(ok.by, 'idle');
  assert.equal(ok.text, '처리 범위 #1~#3, 새 기억 1개', 'run-job session line removed');
  assert.match(prompt, /^# 기억 정리 절차\n\n이 일은 개인 비서의 기억 정리다[^\n]*사람이 보고 있지 않으니 묻지 말고/);
  assert.match(prompt, /seen_id/);
  assert.match(prompt, /allow_similar/);
  assert.match(consolidatePrompt(), /get_unconsolidated_log/);

  talk(s, 1, Date.now());
  const stuck = (await runConsolidate(s, 'manual', async () => '도구를 못 찾았어요')).report!;
  assert.equal(stuck.ok, false);
  assert.equal(stuck.by, 'manual');
  assert.match(stuck.text, /정리 위치가 그대로다\(#\d+\)[^\n]*도구를 못 찾았어요/);
  const crashed = (await runConsolidate(s, 'manual', async () => {
    throw new Error('Not logged in');
  })).report!;
  assert.equal(crashed.text, 'Not logged in');
  assert.deepEqual(unseenReports(s).map((r) => r.ok), [true, false, false], 'reports wait until confirmed');
  assert.equal(JSON.parse(s.getMeta('consolidate_job')!).ok, false);
  // Each run leaves a line in the worker folder's run records (runs-<secretary tag>.jsonl).
  const dir = staffFolder(readStaff('memory-consolidation'));
  const runs = fs.readdirSync(dir).filter((n) => /^runs-.+\.jsonl$/.test(n));
  assert.equal(runs.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, runs[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l).by), ['idle', 'manual', 'manual']);
});

// Without it: a /consolidate the user runs while the idle one runs starts a second run on the same backlog.
test('consolidation: never two at once, and a record whose process is gone does not hold the next one off', async () => {
  const s = tempStore();
  talk(s, 2, Date.now());
  const first = claimConsolidate(s, 'idle', 4242, () => true);
  assert.ok(first);
  assert.equal(claimConsolidate(s, 'manual', 4343, () => true), null, 'a live run holds it');
  let ran = false;
  const r = await runConsolidate(s, 'manual', async () => ((ran = true), 'x'));
  // The real check: is pid 4242 alive? Almost surely not, so the dead record does not hold it.
  assert.equal(r.report === null, !ran);
  s.setMeta('consolidate_job', JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, by: 'idle' }));
  const held = await runConsolidate(s, 'manual', async () => assert.fail('must not run'));
  assert.equal(held.report, null);
  assert.equal(held.running?.by, 'idle');
  assert.equal(consolidateRunning(s, Date.now(), () => false), false, 'process gone: not running');
  assert.equal(consolidateRunning(s, Date.now(), () => true), true);
  assert.equal(consolidateRunning(s, Date.now() + 47 * MIN, () => true), false, 'past the time limit: dead');
});
test('idle tick housekeeping: marks of sessions quiet a week and read positions of deleted transcripts go, the rest stay', async () => {
  const s = tempStore();
  const now = Date.now();
  s.appendLog([
    { session_id: 'old', message_uuid: 'h1', role: 'user', content: '옛 말', created_at: new Date(now - 8 * 24 * 60 * MIN).toISOString() },
    { session_id: 'new', message_uuid: 'h2', role: 'user', content: '새 말', created_at: new Date(now - 60 * MIN).toISOString() },
  ]);
  for (const k of ['context_nudged:', 'consolidate_nudged:', 'consolidate_noticed:']) {
    s.setMeta(`${k}old`, '1');
    s.setMeta(`${k}new`, '1');
  }
  const kept = path.join(tempDir(), 'kept.jsonl');
  fs.writeFileSync(kept, '');
  s.setMeta(`ingest_offset:${kept}`, '0');
  s.setMeta(`ingest_offset:${path.join(tempDir(), 'gone.jsonl')}`, '0');
  // Housekeeping only: the board is behind here, so a fake rewrite stands in (the real one starts run-job and claude).
  const ran: string[] = [];
  await runIdleJobs(s, { now, dirs: [], updateBoard: async () => void ran.push('board'), consolidate: async (st) => (ran.push('consolidate'), okReport(st)) });
  assert.deepEqual(ran, ['board']);
  assert.deepEqual(
    s.metaWithPrefix('').map((r) => r.key).filter((k) => /nudged|noticed|ingest_offset/.test(k)).sort(),
    ['consolidate_noticed:new', 'consolidate_nudged:new', 'context_nudged:new', `ingest_offset:${kept}`].sort(),
  );
  assert.equal(s.markOnce('x', 'a'), true);
  assert.equal(s.markOnce('x', 'a'), false, 'same mark: already told');
  assert.equal(s.markOnce('x', '3', (last) => Number(last) >= 3), true, '"a" does not cover 3');
  assert.equal(s.markOnce('x', '2', (last) => Number(last) >= 2), false);
});

// Without it: the skill keeps keys outside the agentskills.io format, or the steps drift from what the run reads.
test('the consolidate skill is format keys and a short launch note; the steps the run reads are its references/procedure.md', () => {
  const file = skillFile('consolidate');
  assert.equal(file, path.join(PROJECT_ROOT, SECRETARY_SKILLS_DIR, 'consolidate', 'SKILL.md'));
  assert.ok(!fs.lstatSync(path.dirname(file)).isSymbolicLink(), 'a real folder');
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual([...frontMatter(text)!.keys()].sort(), ['description', 'name']);
  assert.match(text, /cli.ts memory-consolidation --detach/);
  assert.match(text, /기억 정리 확인/);
  const w = readStaff('memory-consolidation');
  assert.equal(w.instructions, '.agents/skills/consolidate/references/procedure.md');
  assert.equal(consolidatePrompt(), fs.readFileSync(path.join(PROJECT_ROOT, ...w.instructions!.split('/')), 'utf8').replace(/\r\n/g, '\n').trim());
});