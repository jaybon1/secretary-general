/**
 * The dashboard's data: usage limits, running work sessions and run-jobs, the task board, scheduled tasks. Read only:
 * the database is opened read-only with query_only (no lock or change on the secretary's WAL database), the usage
 * folder (~/.claude/usage, core/paths.ts USAGE_DIR: usage per account), this secretary's records folder
 * (~/.secretary/state/<id>, core/paths.ts secretaryStateDir: its work sessions and run-jobs) and the task scheduler are
 * only read (sys.ps1). The one change: a run-job-active file left by a run-job that certainly ended, or one left broken,
 * is deleted (runJobsActive).
 * Moved here from the dashboard workspace (2026-11-07); the server and the "상태" text both use it.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DB_PATH, PROJECT_ROOT } from '../core/config.ts';
import { secretaryStateDir, USAGE_DIR } from '../core/paths.ts';
import type { AccountDeps } from '../core/provider-accounts.ts';
import { failureWaitMs, readFailure, usageFile } from '../usage/files.ts';
import { labeler, providerLabel, readProviders, type ProviderInfo } from '../usage/providers.ts';
import { readUsageChoice, usageSettingsFile } from '../usage/usage-settings.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// review: waits for the user's own look at the result (the user's turn), so it stands next to running.
const STATUSES = ['ready', 'running', 'review', 'failed', 'done', 'cancelled'] as const;
const STATUS_KO: Record<string, string> = { ready: '대기', running: '진행 중', review: '검수 대기(사용자 차례)', failed: '실패', done: '끝남', cancelled: '취소' };
const STALE_MIN = 30;
/** A run-job-active file that cannot be read as JSON this many minutes after its last write is deleted (runJobsActive). */
const BROKEN_RUNJOB_MIN = 10;

export interface CollectOptions {
  /** The secretary folder (providers.json, scripts/usage.local.json); default this copy. */
  root?: string;
  dbPath?: string;
  /** Usage per account (~/.claude/usage). */
  usageDir?: string;
  /** This secretary's work-session and run-job records (core/paths.ts secretaryStateDir of root). */
  stateDir?: string;
  recentDone: number;
  refreshSec: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Korean time (UTC+9), 24-hour, without the time zone data: +9 hours. */
export function kst(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 9 * 3600e3);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function ago(iso: string, now = Date.now()): string | null {
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (Number.isNaN(m)) return null;
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 ${m % 60}분 전`;
  return `${Math.floor(m / 1440)}일 전`;
}
export function untilText(iso: string, now = Date.now()): string | null {
  const m = Math.round((Date.parse(iso) - now) / 60000);
  if (Number.isNaN(m) || m <= 0) return null;
  if (m < 60) return `${m}분 뒤`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 ${m % 60}분 뒤`;
  return `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간 뒤`;
}
/** The task scheduler's last result number in plain words. */
export function resultText(code: number): string {
  if (code === 0) return '성공';
  if (code === 267009) return '지금 실행 중';
  if (code === 267011) return '아직 실행 전';
  if (code === 267008 || code === 267010) return '대기 중';
  return `실패 또는 중단(코드 ${code})`;
}
/** A provider's display name without reading providers.json (collect passes the one that reads it: usage/providers.ts). */
export const accountName = (p?: string | null): string => providerLabel(p);
type Namer = (p?: string | null) => string;
const tail2 = (p?: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : '');
const firstLine = (s: string | null | undefined, n = 80) => (s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, n) ?? '';
const readJsonIn = (dir: string, f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''));
/** A record file not written yet (a new secretary, or its records folder before its first work session or run-job) reads as `none`. */
const orNone = <T,>(read: () => T, none: T): T => {
  try {
    return read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return none;
    throw e;
  }
};
// Only whether the pid exists (a pid left in a killed run's file can be taken by another process): runJobState compares
// start times when it has the process list and uses this only without it.
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface Meter {
  label: string;
  pct: number;
  resetsAt: string | null;
  left: string | null;
  passed: boolean;
}
export type Limit =
  | { name: string; provider: string; updatedAt: string | null; updatedAgo: string | null; stale: boolean; source: string; meters: Meter[] }
  | { name: string; provider: string; error: string }
  | { name: string; provider: string; none: true };

/**
 * One provider's usage file (~/.claude/usage/subscription-<account>.json, usage/files.ts usageFile) as meters: a
 * subscription's 5-hour and weekly windows (usage-query.ps1 source usage-command), or each model group of agy's weekly one
 * (source agy-usage).
 */
export function limitOf(name: string, provider: string, usageDir = USAGE_DIR, now = Date.now(), d: AccountDeps = {}): Limit {
  const j = readJsonIn(usageDir, path.basename(usageFile(provider, usageDir, d)));
  const meter = (label: string, pct: unknown, resetsAt: unknown): Meter[] =>
    typeof pct === 'number'
      ? [{ label, pct, resetsAt: typeof resetsAt === 'string' ? kst(resetsAt) : null, left: typeof resetsAt === 'string' ? untilText(resetsAt, now) : null, passed: typeof resetsAt === 'string' && Date.parse(resetsAt) <= now }]
      : [];
  const meters = Array.isArray(j.groups)
    ? (j.groups as { name?: string; window?: string; used_pct?: number; resets_at?: string }[]).flatMap((g) =>
        meter(`${g.name ?? '?'} ${g.window === 'weekly' ? '주간' : (g.window ?? '')}`.trim(), g.used_pct, g.resets_at),
      )
    : [...meter('5시간', j.five_hour_pct, j.resets_at), ...meter('주간', j.week_pct, j.week_resets_at)];
  return {
    name,
    provider,
    updatedAt: kst(j.updated_at),
    updatedAgo: ago(j.updated_at, now),
    stale: (now - Date.parse(j.updated_at)) / 60000 > STALE_MIN,
    source: j.source,
    meters,
  };
}

/** The usage cards: the checked providers in providers.json order; one whose usage cannot be read says so. */
export function limitsFor(providers: ProviderInfo[], checked: string[], usageDir = USAGE_DIR, now = Date.now(), d: AccountDeps = {}): Limit[] {
  const want = new Set(checked);
  return providers
    .filter((p) => want.has(p.name))
    .map((p) => {
      if (p.usage === 'none') return { name: p.label, provider: p.name, none: true as const };
      try {
        return limitOf(p.label, p.name, usageDir, now, d);
      } catch (e) {
        const x = e as NodeJS.ErrnoException;
        if (x.code !== 'ENOENT') return { name: p.label, provider: p.name, error: `읽지 못함: ${x.code ?? x.message}`.slice(0, 120) };
        // Never read: say why when the readings keep failing (an API key login's /usage gives no usage) and when the next try is.
        const f = readFailure(p.name, usageDir, d);
        const next = f ? Date.parse(f.at) + failureWaitMs(f.count) : NaN;
        const when = Number.isFinite(next) && next > now ? `, 다음 시도 ${kst(new Date(next).toISOString())}` : '';
        return { name: p.label, provider: p.name, error: f ? `조회 실패 ${f.count}번(${(f.reason ?? '').slice(0, 60)}${when})` : '아직 조회 기록 없음' };
      }
    });
}

export function kanban(dbPath = DB_PATH, recentDone = 8) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=1; PRAGMA busy_timeout=2000');
    return STATUSES.map((status) => {
      const recent = status === 'done' || status === 'cancelled' || status === 'failed';
      const rows = db
        .prepare(
          `SELECT t.id, t.title, t.session_ref, t.result, t.updated_at, w.title AS ws
           FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
           WHERE t.status = ? AND w.archived_at IS NULL ORDER BY t.updated_at DESC` + (recent ? ` LIMIT ${recentDone | 0}` : ''),
        )
        .all(status) as { id: number; title: string; session_ref: string | null; result: string | null; updated_at: string; ws: string }[];
      const total = (db.prepare('SELECT COUNT(*) n FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.status = ? AND w.archived_at IS NULL').get(status) as { n: number }).n;
      const items = rows.map((r) => ({
        id: r.id,
        title: r.title,
        ws: r.ws,
        session: r.session_ref,
        note: firstLine(r.result, 70),
        updatedAt: kst(r.updated_at),
        updatedAgo: ago(r.updated_at),
      }));
      return { status, label: STATUS_KO[status], total, items };
    });
  } finally {
    db.close();
  }
}

/** PowerShell processes (the hosts run-job.ps1 runs in) with their start times, listed at `at` (sys.ps1). */
export interface Procs {
  at: string;
  list: { pid: number; started: string | null }[];
}
interface SysInfo {
  sessions: { pid: number; cmd: string }[];
  procs: Procs | null;
  tasks: { name: string; state: string; next: string | null; last: string | null; result: number }[];
}
let sysCache: { at: number; p: Promise<SysInfo> | null } = { at: 0, p: null };
function sysInfo(): Promise<SysInfo> {
  if (Date.now() - sysCache.at < 10000 && sysCache.p) return sysCache.p;
  sysCache.at = Date.now();
  sysCache.p = new Promise((res, rej) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'sys.ps1')],
      { timeout: 20000, windowsHide: true, maxBuffer: 1 << 20 },
      (e, out) => {
        if (e) {
          sysCache.at = 0;
          return rej(e);
        }
        try {
          const j = JSON.parse(out);
          const procs = j.procs && typeof j.procs.at === 'string' ? { at: j.procs.at, list: [j.procs.list ?? []].flat() } : null;
          res({ sessions: [j.sessions ?? []].flat(), procs, tasks: [j.tasks ?? []].flat() });
        } catch (x) {
          sysCache.at = 0;
          rej(x);
        }
      },
    ),
  );
  return sysCache.p;
}

/**
 * A work session's short id (8 hex) from a claude.exe command line: a fresh one has --session-id <uuid>, one the
 * secretary resumed --resume <path>\<uuid>.jsonl, the background session host a pipe name ...-pty-<id>.
 */
export function sessionIdOf(cmd: string): string | null {
  const m =
    /--session-id\s+([0-9a-f]{8})/.exec(cmd) ?? /--resume\s+\S*?([0-9a-f]{8})[0-9a-f-]*\.jsonl/.exec(cmd) ?? /--bg-pty-host\s+\S*-pty-([0-9a-f]{8})\b/.exec(cmd);
  return m ? m[1] : null;
}

/**
 * Work sessions (worker-sessions.json in this secretary's records folder): recorded (no done_at) and a live process with
 * the same short id is "running"; the record alone is an orphan.
 */
export function workers(live: { cmd: string }[], stateDir = secretaryStateDir(), accountName: Namer = providerLabel) {
  const rec = orNone(() => readJsonIn(stateDir, 'worker-sessions.json'), {}) as Record<string, Record<string, string>>;
  const liveIds = new Set(live.map((s) => sessionIdOf(s.cmd)).filter(Boolean));
  type Item = { id: string; name: string; account: string; model: string; effort: string; folder: string; startedAt: string | null; startedAgo: string | null };
  const running: Item[] = [];
  const orphan: Item[] = [];
  for (const w of Object.values(rec)) {
    if (w.done_at) continue;
    const item = { id: w.id, name: w.name, account: accountName(w.provider), model: w.model, effort: w.effort, folder: tail2(w.folder), startedAt: kst(w.started_at), startedAgo: ago(w.started_at) };
    (liveIds.has(w.id) ? running : orphan).push(item);
  }
  return { running, orphan };
}

type RunJobItem = { pid: number; account: string; model: string; folder: string; label: string; startedAt: string | null; startedAgo: string | null };
/**
 * Whether the run-job that wrote a run-job-active file still runs: 'running', 'gone' (certainly ended: the file is
 * deleted) or 'hidden' (looks ended but not certain: hidden, kept). run-job.ps1 deletes its file only in `finally`, so a
 * killed run (window closed, PC shut down) leaves it, and Windows soon gives its pid to another process.
 * With the process list (`procs`, sys.ps1): running while a PowerShell process with that pid started no later than the
 * file's started_at (run-job.ps1 writes the file after its own start; a process that took the pid after the run ended
 * started later). A file started after the list was taken may not be on it yet: running until the next list.
 * Without the list (sys.ps1 failed): only whether the pid exists, and nothing is deleted.
 */
export function runJobState(j: { pid?: unknown; started_at?: unknown }, procs: Procs | null): 'running' | 'gone' | 'hidden' {
  const pid = Number(j.pid);
  const started = typeof j.started_at === 'string' ? Date.parse(j.started_at) : NaN;
  if (!procs) return pidAlive(pid) ? 'running' : 'hidden';
  const p = procs.list.find((x) => x.pid === pid);
  if (p) {
    const procStart = p.started ? Date.parse(p.started) : NaN;
    if (Number.isNaN(procStart) || Number.isNaN(started) || procStart <= started) return 'running';
  }
  if (Number.isNaN(started)) return 'hidden';
  return started < Date.parse(procs.at) ? 'gone' : 'running';
}

/**
 * run-job.ps1 keeps run-job-active/<PID>.json in this secretary's records folder while it runs. A file of a run that
 * ended without deleting it is not listed, and deleted when that is certain (runJobState).
 */
export function runJobsActive(stateDir = secretaryStateDir(), accountName: Namer = providerLabel, procs: Procs | null = null): { running: RunJobItem[] } {
  const dir = path.join(stateDir, 'run-job-active');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { running: [] };
  }
  const running: RunJobItem[] = [];
  for (const f of files) {
    let j;
    try {
      j = readJsonIn(dir, f);
    } catch {
      // A file being written: next refresh. run-job.ps1 writes it once at its start (a few bytes, milliseconds), so one
      // still unreadable BROKEN_RUNJOB_MIN after its last write was cut off (killed mid-write, disk full): deleted.
      try {
        const p = path.join(dir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > BROKEN_RUNJOB_MIN * 60000) fs.rmSync(p, { force: true });
      } catch {
        // gone already, or in use: tried again next refresh
      }
      continue;
    }
    const state = runJobState(j, procs);
    if (state === 'gone') {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
      } catch {
        // in use: hidden all the same, tried again next refresh
      }
    }
    if (state !== 'running') continue;
    running.push({ pid: j.pid, account: accountName(j.provider), model: j.model, folder: tail2(j.folder), label: j.label, startedAt: kst(j.started_at), startedAgo: ago(j.started_at) });
  }
  return { running };
}

/**
 * The last `n` run-job calls (run-job-calls.jsonl in this secretary's records folder), newest first.
 * The whole file is read for its last lines; read only the end if it ever grows to megabytes.
 */
export function recentRunJobs(n = 10, stateDir = secretaryStateDir(), accountName: Namer = providerLabel) {
  const lines = orNone(() => fs.readFileSync(path.join(stateDir, 'run-job-calls.jsonl'), 'utf8'), '').split(/\r?\n/).filter(Boolean).reverse();
  const last = [];
  for (const l of lines) {
    if (last.length >= n) break;
    try {
      last.push(JSON.parse(l));
    } catch {
      // a line cut while being written
    }
  }
  return last.map((j) => ({
    at: kst(j.at),
    ago: ago(j.at),
    account: accountName(j.provider),
    model: j.model,
    folder: tail2(j.folder),
    sec: Number(j.total_sec) || 0,
    context: j.context,
    out: j.output_tokens,
    cost: Number(j.cost_usd) || 0,
    error: !!j.is_error,
    resumed: !!j.resumed,
  }));
}

export function schedules(tasks: SysInfo['tasks']) {
  return tasks.map((t) => ({
    name: t.name,
    state: t.state,
    next: t.next ? kst(t.next) : null,
    nextLeft: t.next ? untilText(t.next) : null,
    last: t.last ? kst(t.last) : null,
    lastAgo: t.last ? ago(t.last) : null,
    result: resultText(t.result),
    ok: [0, 267009, 267008, 267010, 267011].includes(t.result),
  }));
}

type Part<T> = { data: T; error?: undefined } | { error: string; data?: undefined };
const part = async <T>(fn: () => T | Promise<T>): Promise<Part<T>> => {
  try {
    return { data: await fn() };
  } catch (e) {
    const x = e as NodeJS.ErrnoException;
    return { error: `읽지 못함: ${x.code ?? x.message}`.slice(0, 120) };
  }
};

export async function collect(o: CollectOptions) {
  const usageDir = o.usageDir ?? USAGE_DIR;
  const sys = await part(sysInfo);
  const live = sys.data?.sessions ?? [];
  const root = o.root ?? PROJECT_ROOT;
  const stateDir = o.stateDir ?? secretaryStateDir(root);
  const providers = readProviders(root);
  const name = labeler(providers);
  return {
    generatedAt: kst(new Date().toISOString()),
    refreshSec: o.refreshSec,
    limits: await part(() => limitsFor(providers, readUsageChoice(providers, usageSettingsFile(root)).checked, usageDir, Date.now(), { root })),
    workers: sys.error !== undefined ? { error: sys.error } : await part(() => workers(live, stateDir, name)),
    runJobsActive: await part(() => runJobsActive(stateDir, name, sys.data?.procs ?? null)),
    runJobsRecent: await part(() => recentRunJobs(10, stateDir, name)),
    kanban: await part(() => kanban(o.dbPath ?? DB_PATH, o.recentDone)),
    schedules: sys.error !== undefined ? { error: sys.error } : { data: schedules(sys.data.tasks) },
  };
}

export type Collected = Awaited<ReturnType<typeof collect>>;
