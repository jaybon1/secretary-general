import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { unseenReports, type ConsolidateReport } from '../src/memory/consolidate-notice.ts';
import { consolidatePrompt, runConsolidate, runIdleJobs } from '../src/idle/idle-jobs.ts';
import { lastActivityMs } from '../src/log/catch-up.ts';
import type { Store } from '../src/store/store.ts';
import { talk, tempDir, tempStore } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { SECRETARY_SKILLS_DIR, skillFile } from '../src/core/paths.ts';

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
  const ok = await runConsolidate(s, async (file) => {
    prompt = fs.readFileSync(file, 'utf8');
    s.markConsolidated(last);
    return '처리 범위 #1~#3, 새 기억 1개\n(새 세션) 세션: abc';
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '처리 범위 #1~#3, 새 기억 1개', 'run-job session line removed');
  assert.match(prompt, /^이 일은 개인 비서의 쉬는 시간 기억 정리다\. 사람이 보고 있지 않으니 묻지 말고/);
  assert.match(prompt, /seen_id/);
  assert.match(prompt, /allow_similar/);
  assert.match(prompt, /# 기억 정리/, 'the consolidate skill body follows');
  assert.doesNotMatch(prompt, /^context: fork/m, 'skill frontmatter stripped');
  assert.match(consolidatePrompt(), /get_unconsolidated_log/);

  talk(s, 1, Date.now());
  const stuck = await runConsolidate(s, async () => '도구를 못 찾았어요');
  assert.equal(stuck.ok, false);
  assert.match(stuck.text, /정리 위치가 그대로다\(#\d+\)[^\n]*도구를 못 찾았어요/);
  const crashed = await runConsolidate(s, async () => {
    throw new Error('Not logged in');
  });
  assert.equal(crashed.text, 'Not logged in');
  assert.deepEqual(unseenReports(s).map((r) => r.ok), [true, false, false], 'reports wait until confirmed');
  assert.equal(JSON.parse(s.getMeta('consolidate_job')!).ok, false);
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

test('the consolidate skill is read from the secretary skills folder itself (a real folder, not a junction)', () => {
  const file = skillFile('consolidate');
  assert.equal(file, path.join(PROJECT_ROOT, SECRETARY_SKILLS_DIR, 'consolidate', 'SKILL.md'));
  // A real folder there (a fresh clone has no junctions), and its steps are what the unattended prompt carries.
  assert.ok(!fs.lstatSync(path.dirname(file)).isSymbolicLink(), 'a real folder');
  const body = fs.readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  assert.ok(consolidatePrompt().endsWith(body));
});
