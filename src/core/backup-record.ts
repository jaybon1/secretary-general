/**
 * What the daily DB backup (scripts/scheduled/backup-db.ps1, feature db-backup) did, one line per run in this secretary's
 * records folder (~/.secretary/<id>/logs/db-backup.jsonl): whether the backup was made and, where the copy on an external
 * device is part of it, whether the copy went (ok), was left out and why (skipped: the device off, no setting), or failed.
 * The script hands its line over with `node src/cli.ts backup-record --file <json>`, since a run that ends early used to
 * leave no trace at all.
 *
 * At session start the secretary is told once per new line (backupNotice) when the last good backup, or the last good
 * copy to the device, is older than STALE_MS; the words of what to do are in .agents/hook-notices/backup-stale.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hookNoticeText, type NoticeMarks } from './hook-notice-text.ts';
import { appendJsonLine } from './json-file.ts';
import { formatLocal } from './kst-time.ts';
import { secretaryLogDir } from './paths.ts';

export const BACKUP_RECORD_NAME = 'db-backup.jsonl';
/** Overrides where the record is (tests write into their own folder). */
export const BACKUP_RECORD_ENV = 'SECRETARY_BACKUP_RECORD';
/** In the database's meta: the newest run line already told (store.markOnce). */
export const BACKUP_TOLD_KEY = 'db_backup_told';
/** A backup or a device copy older than this is told (the task runs daily: three missed days in a row). */
export const STALE_MS = 3 * 24 * 3600_000;
export const BACKUP_NOTICE = 'backup-stale';

export const backupRecordFile = (env: NodeJS.ProcessEnv = process.env): string => env[BACKUP_RECORD_ENV] || path.join(secretaryLogDir(), BACKUP_RECORD_NAME);

export type BackupResult = 'ok' | 'failed';
export type DeviceResult = 'ok' | 'skipped' | 'failed';

/** What the script hands over. */
export interface BackupRun {
  backup: BackupResult;
  /** Left out where this copy sends nothing to a device. */
  device?: DeviceResult;
  /** Why it failed or was skipped, short. */
  reason?: string;
  /** Backups kept here after the run. */
  kept?: number;
}

export interface BackupLine extends BackupRun {
  at: string;
  local: string;
}

const RESULTS = new Set(['ok', 'failed']);
const DEVICE_RESULTS = new Set(['ok', 'skipped', 'failed']);

/** One run's line; throws on a value the script should never send (so a typo shows in its output). */
export function recordBackup(run: BackupRun, now = Date.now()): BackupLine {
  if (!RESULTS.has(run.backup)) throw new Error(`backup must be ok|failed: ${run.backup}`);
  if (run.device !== undefined && !DEVICE_RESULTS.has(run.device)) throw new Error(`device must be ok|skipped|failed: ${run.device}`);
  const line: BackupLine = {
    at: new Date(now).toISOString(),
    local: formatLocal(now, false, true),
    backup: run.backup,
    ...(run.device ? { device: run.device } : {}),
    ...(run.reason ? { reason: String(run.reason).slice(0, 300) } : {}),
    ...(typeof run.kept === 'number' ? { kept: run.kept } : {}),
  };
  appendJsonLine(backupRecordFile(), line);
  return line;
}

function readLines(file: string): BackupLine[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: BackupLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as BackupLine;
      if (v && typeof v.at === 'string' && typeof v.backup === 'string') out.push(v);
    } catch {}
  }
  return out;
}

/** Since when `what` has not gone well: its last ok, or (never ok) the first line it shows in; null while it is fresh. */
function staleSince(lines: BackupLine[], ok: (l: BackupLine) => boolean, counts: (l: BackupLine) => boolean, now: number): string | null {
  const seen = lines.filter(counts);
  if (!seen.length) return null;
  const good = seen.filter(ok).at(-1);
  const since = good?.at ?? seen[0].at;
  return now - Date.parse(since) > STALE_MS ? since : null;
}

/**
 * For the session-start hook: one line when the last good backup, or the last good copy to the device (only where the
 * runs copy to one), is older than STALE_MS, or the runs stopped; told once per newest line; '' otherwise.
 */
export function backupNotice(store: NoticeMarks, now = Date.now()): string {
  const file = backupRecordFile();
  const lines = readLines(file);
  if (!lines.length) return '';
  const last = lines.at(-1)!;
  if (store.getMeta(BACKUP_TOLD_KEY) === last.at) return '';
  const backupSince = staleSince(lines, (l) => l.backup === 'ok', () => true, now);
  const deviceSince = staleSince(lines, (l) => l.device === 'ok', (l) => l.device !== undefined, now);
  if (!backupSince && !deviceSince) return '';
  if (!store.markOnce(BACKUP_TOLD_KEY, last.at)) return '';
  const what = [
    backupSince ? `DB 백업이 ${formatLocal(backupSince)} 뒤로 성공하지 않았어요` : '',
    deviceSince ? `외부 기기로의 백업 복사가 ${formatLocal(deviceSince)} 뒤로 성공하지 않았어요` : '',
  ].filter(Boolean);
  const lastRun = `마지막 실행 ${formatLocal(last.at)}: 백업 ${last.backup}${last.device ? ` · 기기 복사 ${last.device}` : ''}${last.reason ? ` (${last.reason})` : ''}`;
  const todo = hookNoticeText(BACKUP_NOTICE, 'stale').replaceAll('{log}', file);
  return `${what.join(' · ')} · ${lastRun}${todo ? ` — ${todo}` : ''}`;
}
