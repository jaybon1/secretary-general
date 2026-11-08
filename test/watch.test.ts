import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';
import { claudeOwner, type ProcTable, unwatchedTasks, WATCH_TIMEOUT_MS, watcherAlive, watcherOurs } from '../src/workspace/watch-check.ts';

test('the watcher stops at 55 minutes, before the time limit the secretary gives its background command', () => {
  // 55 minutes: the secretary wakes while its 1-hour prompt cache is still warm.
  const script = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'worker', 'watch-worker.ps1'), 'utf8');
  // The default is the shared cache-wake minutes (lib/common.ps1), also wait-job.ps1's and the session reuse limit.
  assert.match(script, /if \(-not \$MaxMinutes\) \{ \$MaxMinutes = \$CacheWakeMinutes \}/);
  const env = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1'), 'utf8');
  const max = Number(/^\$CacheWakeMinutes = (\d+)/m.exec(env)?.[1]);
  assert.equal(max, 55);
  assert.ok(max * 60_000 < WATCH_TIMEOUT_MS, 'the watcher ends first');
  assert.equal(WATCH_TIMEOUT_MS, 3_600_000);
  // The time-up line says the task still runs and the watch is to be relaunched without a notification.
  assert.match(script, /시간 끝\(\$span\): .*아직 일하는 중.*알림 없이 감시를 다시 띄우세요/);
  // The delegate skill tells the secretary the same limit.
  const skill = fs.readFileSync(path.join(PROJECT_ROOT, '.agents', 'skills', 'delegate', 'SKILL.md'), 'utf8');
  assert.match(skill, new RegExp(`watch-worker\\.ps1 -Id <id>\`를 백그라운드 명령\\(run_in_background, timeout ${WATCH_TIMEOUT_MS}\\)`));
  assert.doesNotMatch(skill, /7200000/);
});

test('unwatchedTasks lists only bg tasks without a live watcher', () => {
  const tasks = [
    { id: 1, title: 'a', sessionRef: 'bg:aaaa1111' },
    { id: 2, title: 'b', sessionRef: 'bg:bbbb2222' },
    { id: 3, title: 'c', sessionRef: 'app:xyz' },
    { id: 4, title: 'd', sessionRef: null },
  ];
  const off = unwatchedTasks(tasks, (id) => id === 'aaaa1111');
  assert.deepEqual(off, [{ id: 2, title: 'b', bg: 'bbbb2222' }]);
});

test('watcherAlive reads the pid file and checks the process', () => {
  const dir = tempDir('watch-');
  fs.writeFileSync(path.join(dir, 'abcd1234.pid'), `${process.pid}\r\n`);
  assert.equal(watcherAlive('abcd1234', dir), true);
  assert.equal(watcherAlive('abcd1234', dir, () => false), false);
  assert.equal(watcherAlive('missing0', dir), false);
  fs.writeFileSync(path.join(dir, 'bad00000.pid'), 'x');
  assert.equal(watcherAlive('bad00000', dir), false);
});

test('a watcher counts as ours only when it hangs under the same claude.exe as the hook', () => {
  // 1 remote-control server > 10 session A > 11 bash > 12 watcher; 10 > 13 hook; 20 session B > 21 watcher
  const table: ProcTable = new Map([
    [1, { ppid: 0, name: 'claude.exe' }],
    [10, { ppid: 1, name: 'claude.exe' }],
    [11, { ppid: 10, name: 'bash.exe' }],
    [12, { ppid: 11, name: 'powershell.exe' }],
    [13, { ppid: 10, name: 'node.exe' }],
    [20, { ppid: 1, name: 'claude.exe' }],
    [21, { ppid: 20, name: 'powershell.exe' }],
  ]);
  assert.equal(claudeOwner(12, table), 10);
  assert.equal(claudeOwner(13, table), 10);
  assert.equal(claudeOwner(99, table), undefined);
  const dir = tempDir('watch-own-');
  fs.writeFileSync(path.join(dir, 'aaaa.pid'), '12');
  fs.writeFileSync(path.join(dir, 'bbbb.pid'), '21');
  fs.writeFileSync(path.join(dir, 'cccc.pid'), '77');
  assert.equal(watcherOurs('aaaa', table, 13, dir), true);
  assert.equal(watcherOurs('bbbb', table, 13, dir), false); // another session's watcher wakes that session
  assert.equal(watcherOurs('cccc', table, 13, dir), false); // dead pid
  assert.equal(watcherOurs('dddd', table, 13, dir), false); // no pid file
  assert.equal(watcherOurs('aaaa', null, 13, dir), false); // table unreadable: relaunch rather than miss
});