// Running background worker tasks whose watcher (scripts/worker/watch-worker.ps1) is not alive.
// The watcher is the only thing that wakes the secretary when a worker on another config dir
// stops, and it ends every time the worker ends a turn, so forgetting to relaunch it means a
// finished task goes unnoticed. The watcher writes its PID to watch/<id>.pid in this secretary's records folder
// (~/.secretary/<id>/state, core/paths.ts secretaryStateDir).
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_USAGE_DIR, legacySecretaryStateDir, SCRIPTS, secretaryStateDir } from '../core/paths.ts';
import type { Store } from '../store/store.ts';
import { listProcessesSync, pidAlive } from '../core/windows-process.ts';
import { TAG } from '../core/names.ts';

export const WATCH_DIR = path.join(secretaryStateDir(), 'watch');
/**
 * Where watchers started before the records folder moved wrote their pid (~/.secretary/state/<id>/watch until 2026-11-09;
 * ~/.claude/usage/watch in a copy without an id): read when WATCH_DIR has none.
 */
export const OLD_WATCH_DIR = path.join(legacySecretaryStateDir() ?? LEGACY_USAGE_DIR, 'watch'); // legacy-name: state-dir

/** The pid file's text: in `dir`, else (a watcher started before the move) in `old`. Throws when neither has it. */
function readPidFile(id: string, dir: string, old: string): string {
  try {
    return fs.readFileSync(path.join(dir, `${id}.pid`), 'utf8');
  } catch (e) {
    if (old === dir) throw e;
    return fs.readFileSync(path.join(old, `${id}.pid`), 'utf8');
  }
}

/**
 * The time limit the secretary gives the watcher's background command. The watcher itself stops at
 * 55 minutes (-MaxMinutes in watch-worker.ps1) so it wakes the secretary while its 1-hour prompt cache
 * is still warm; this limit is a little longer so the watcher always ends first.
 */
export const WATCH_TIMEOUT_MS = 3_600_000;

/** The old folder to fall back on: only for the real one (a test's own folder has none). */
const oldFor = (dir: string) => (dir === WATCH_DIR ? OLD_WATCH_DIR : dir);

export function watcherAlive(id: string, dir = WATCH_DIR, isAlive = pidAlive, old = oldFor(dir)): boolean {
  try {
    const pid = Number(readPidFile(id, dir, old).trim());
    return Number.isInteger(pid) && pid > 0 && isAlive(pid);
  } catch {
    return false;
  }
}

export type ProcTable = Map<number, { ppid: number; name: string }>;

/** pid → parent and image name for every process; null when it cannot be read (then nothing counts as ours). */
export function processTable(): ProcTable | null {
  const procs = listProcessesSync(undefined, { brief: true });
  if (!procs?.length) return null;
  return new Map(procs.map((p) => [p.pid, { ppid: p.ppid, name: p.name.toLowerCase() }]));
}

/** The nearest claude.exe above pid: the Claude session process that owns a hook or a background command. */
export function claudeOwner(pid: number, table: ProcTable): number | undefined {
  const seen = new Set<number>();
  for (let p = table.get(pid)?.ppid; p && !seen.has(p); p = table.get(p)?.ppid) {
    seen.add(p);
    const row = table.get(p);
    if (!row) return undefined;
    if (row.name === 'claude.exe' || row.name === 'claude') return p;
  }
  return undefined;
}

/**
 * Is the watcher for id alive AND launched by the same Claude process as this hook? Only then does its
 * end notice reach this conversation (after /clear it does; checked 2026-11-06). A watcher under another
 * Claude process (handoff, an older session) wakes that session instead, so it does not count.
 */
export function watcherOurs(id: string, table: ProcTable | null, selfPid = process.pid, dir = WATCH_DIR, old = oldFor(dir)): boolean {
  if (!table) return false;
  let pid: number;
  try {
    pid = Number(readPidFile(id, dir, old).trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !table.has(pid)) return false;
  const mine = claudeOwner(selfPid, table);
  return mine !== undefined && claudeOwner(pid, table) === mine;
}

export function unwatchedTasks(
  tasks: { id: number; title: string; sessionRef?: string | null }[],
  check: (id: string) => boolean = (id) => watcherAlive(id),
): { id: number; title: string; bg: string }[] {
  const out: { id: number; title: string; bg: string }[] = [];
  for (const t of tasks) {
    const m = /^bg:([0-9a-f]+)/i.exec(t.sessionRef ?? '');
    if (m && !check(m[1])) out.push({ id: t.id, title: t.title, bg: m[1] });
  }
  return out;
}

export function watchNotice(store: Store): string {
  let rows: { id: number; title: string; sessionRef?: string | null }[];
  try {
    rows = store.listTasks({ status: 'running' }).map((t) => ({ id: t.id, title: t.title, sessionRef: t.session_ref }));
  } catch {
    return '';
  }
  const off = unwatchedTasks(rows);
  if (!off.length) return '';
  const lines = off.map((t) => `업무${t.id}(${t.title.slice(0, 20)}): ${SCRIPTS.watchWorker} -Id ${t.bg}`);
  return `<${TAG.watch}>돌고 있는 업무의 모니터링이 꺼져 있다. 업무 세션이 이미 쉬고 있을 수 있으니 worker-logs로 확인하고, 계속 도는 업무면 이 답의 도구 호출에서 모니터링을 백그라운드 명령(시간제한 ${WATCH_TIMEOUT_MS}ms)으로 다시 띄운다. 끝난 업무면 delegate 스킬대로 마무리한다.\n${lines.join('\n')}</${TAG.watch}>`;
}

/** How many running tasks a new session is told about (there are rarely more than a few). */
const RUNNING_TASKS_MAX = 20;

/**
 * Tasks still marked running: a new session does not know the old session's watchers, so it is
 * told which background sessions to watch again. After /clear the old watcher can still be alive in
 * the same Claude process (and still wakes this conversation), so a task whose watcher belongs to this
 * process is marked and not relaunched; relaunching it gave two watchers on one task. A watcher under
 * another Claude process wakes that session, so it is relaunched here. [] when none run.
 */
export function runningTaskLines(store: Store, isWatched?: (bg: string) => boolean): string[] {
  const tasks = store.listTasks({ status: 'running', limit: RUNNING_TASKS_MAX });
  if (tasks.length === 0) return [];
  if (!isWatched) {
    let table: ProcTable | null | undefined;
    isWatched = (bg) => {
      if (!watcherAlive(bg)) return false; // cheap check first; the process table only when one is alive
      table ??= processTable();
      return watcherOurs(bg, table);
    };
  }
  let unwatched = 0;
  const rows = tasks.map((t) => {
    const bg = /^bg:([0-9a-f]+)/i.exec(t.session_ref ?? '')?.[1];
    const alive = bg !== undefined && isWatched(bg);
    if (!alive) unwatched++;
    return `- 업무 ${t.id} "${t.title}" · ${t.session_ref ?? 'session_ref 없음'}${alive ? ' · 모니터링 살아 있음' : ''}`;
  });
  return [
    '돌고 있는 업무(기억 DB status running, 이 세션은 그 모니터링을 모른다. <id>는 bg: 뒤 글자):',
    ...rows,
    unwatched === 0
      ? '모두 모니터링이 살아 있으니 다시 띄우지 않는다(겹친다).'
      : `"모니터링 살아 있음"이 없는 업무만 첫 답에서 ${SCRIPTS.watchWorker} -Id <id>를 백그라운드 명령(시간제한 ${WATCH_TIMEOUT_MS}ms)으로 다시 띄운다.`,
  ];
}
