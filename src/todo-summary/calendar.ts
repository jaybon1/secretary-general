/**
 * The calendar part of the to-do summary (feature todo-summary): the calendar's secret iCal address is read from a key
 * file, its events fetched and expanded into occurrences (node-ical: RRULE, EXDATE, and occurrences moved by a
 * RECURRENCE-ID), and the window from yesterday to 30 days ahead replaced in calendar_events in one transaction.
 *
 * When: the idle jobs every CALENDAR_EVERY_MS (idle/idle-jobs.ts, which run every 5 minutes whether talk paused or not), and
 * once right after a turn of the secretary that used a calendar tool (the Stop hook starts `cli calendar-fetch` apart, so
 * the hook does not wait). With no key nothing happens and nothing is said.
 *
 * The key: this secretary's settings (this-secretary.local.json, the todo-summary section, core/this-secretary.ts) name the
 * key file in the PC's keys folder (calendarKeyFile) and, optionally, its variable (calendarVariable, default
 * DEFAULT_VARIABLE). The address is a secret: never printed, logged or kept; an error that carries it has it taken out.
 * How the last fetch went is one meta row (CALENDAR_META): the summary says "일정은 N시 기준" when the last one failed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { VEvent } from 'node-ical';
import { formatLocal, nowIso } from '../core/kst-time.ts';
import { keysDir } from '../core/provider-accounts.ts';
import { scriptPath } from '../core/paths.ts';
import { readThisSecretary } from '../core/this-secretary.ts';
import { CLI, FEATURE } from '../core/names.ts';
import { localToUtc, type CalendarEvent, type Store } from '../store/store.ts';

export const DEFAULT_VARIABLE = 'GOOGLE_CALENDAR_ICAL_SECRET_ADDRESS';
export const CALENDAR_META = 'calendar_fetch';
/** How often the idle jobs fetch. */
export const CALENDAR_EVERY_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
/** Days ahead kept (today counted apart): yesterday … today + WINDOW_DAYS. */
const WINDOW_DAYS = 30;
/** Calendar tools whose use in a turn means the calendar changed (the Stop hook fetches once). */
const CALENDAR_WRITE_TOOLS = /^mcp__claude_ai_Google_Calendar__(create_event|update_event|delete_event)$/;

export interface CalendarSettings {
  keyFile?: string;
  variable?: string;
}

export interface FetchRecord {
  at: string;
  ok: boolean;
  count?: number;
  ms?: number;
  error?: string;
  /** When a fetch last succeeded (kept across failures). */
  lastOkAt?: string;
}

/** This secretary's calendar settings; {} with none (or the feature off). */
export function calendarSettings(root?: string): CalendarSettings {
  const r = readThisSecretary<{ calendarKeyFile?: unknown; calendarVariable?: unknown }>(FEATURE.todoSummary, root ? { root } : {});
  if (!r.ok || !r.value || typeof r.value !== 'object') return {};
  const keyFile = typeof r.value.calendarKeyFile === 'string' && r.value.calendarKeyFile.trim() ? path.basename(r.value.calendarKeyFile.trim()) : undefined;
  const variable = typeof r.value.calendarVariable === 'string' && r.value.calendarVariable.trim() ? r.value.calendarVariable.trim() : undefined;
  return { keyFile, variable };
}

/** The secret address from the key file (`NAME=value` lines, quotes taken off); undefined when there is none. */
export function calendarAddress(settings: CalendarSettings, dir = keysDir()): string | undefined {
  if (!settings.keyFile) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, settings.keyFile), 'utf8');
  } catch {
    return undefined;
  }
  const name = settings.variable ?? DEFAULT_VARIABLE;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}

/** [from, to) of the kept window, UTC ISO: 00:00 local yesterday to 00:00 local of the day after today + WINDOW_DAYS. */
export function calendarWindow(now = Date.now()): { from: string; to: string } {
  const today = formatLocal(now, true);
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  return { from: new Date(localToUtc(day(-1))).toISOString(), to: new Date(localToUtc(day(WINDOW_DAYS + 1))).toISOString() };
}

/** node-ical gives an all-day date as midnight of this process's own time zone: its date read back the same way. */
function processDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const stored = (d: Date, allDay: boolean): string => (allDay ? new Date(localToUtc(processDate(d))).toISOString() : d.toISOString());

const text = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && 'val' in v ? String((v as { val: unknown }).val) : '');

/**
 * The occurrences of an iCal text starting in [fromIso, toIso): a recurring event expanded (EXDATE left out, a moved
 * occurrence at its new time), cancelled ones left out, an all-day one from 00:00 local of its date. node-ical is loaded here,
 * when a fetch needs it, not with this file: every hook imports this file (run-hook.ts) and the package took about 77 ms to load.
 */
export async function expandIcs(ics: string, fromIso: string, toIso: string): Promise<CalendarEvent[]> {
  const ical = (await import('node-ical')).default;
  const data = ical.sync.parseICS(ics);
  // The process's own time zone may differ from the display one by up to a day: expanded wide, then cut to the window.
  const from = new Date(Date.parse(fromIso) - 2 * 86_400_000);
  const to = new Date(Date.parse(toIso) + 2 * 86_400_000);
  const out: CalendarEvent[] = [];
  for (const c of Object.values(data)) {
    if (!c || c.type !== 'VEVENT') continue;
    const ev = c as VEvent;
    if (ev.status === 'CANCELLED' || !ev.start) continue;
    for (const i of ical.expandRecurringEvent(ev, { from, to })) {
      if (i.event.status === 'CANCELLED') continue;
      const allDay = i.isFullDay;
      const start = stored(i.start, allDay);
      if (start < fromIso || start >= toIso) continue;
      const original = i.isOverride && i.event.recurrenceid ? stored(i.event.recurrenceid, allDay) : start;
      out.push({
        uid: ev.uid,
        recurrence_at: original,
        start_at: start,
        end_at: i.end ? stored(i.end, allDay) : null,
        all_day: allDay,
        title: text(i.summary) || text(ev.summary) || '(제목 없음)',
        location: text(i.event.location ?? ev.location) || null,
      });
    }
  }
  return out.sort((a, b) => a.start_at.localeCompare(b.start_at));
}

export function lastFetch(store: Store): FetchRecord | undefined {
  return store.getJson<FetchRecord>(CALENDAR_META);
}

/** True when a key is set and the last try is older than CALENDAR_EVERY_MS (or there was none). */
export function calendarDue(store: Store, now = Date.now(), settings = calendarSettings()): boolean {
  if (!settings.keyFile) return false;
  const last = lastFetch(store);
  return !last || now - Date.parse(last.at) >= CALENDAR_EVERY_MS;
}

export interface FetchDeps {
  settings?: CalendarSettings;
  keysDir?: string;
  /** The iCal text for an address (tests put a fake in). */
  get?: (address: string) => Promise<string>;
  now?: number;
}

async function httpGet(address: string): Promise<string> {
  const res = await fetch(address, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetches and saves the window once. 'skipped' with no key (nothing recorded); otherwise the record saved in meta, the
 * error with the address taken out.
 */
export async function fetchCalendar(store: Store, deps: FetchDeps = {}): Promise<FetchRecord | 'skipped'> {
  const settings = deps.settings ?? calendarSettings();
  const address = calendarAddress(settings, deps.keysDir);
  if (!address) return 'skipped';
  const started = Date.now();
  const at = nowIso();
  const before = lastFetch(store);
  let record: FetchRecord;
  try {
    const body = await (deps.get ?? httpGet)(address);
    if (!/BEGIN:VCALENDAR/.test(body)) throw new Error('iCal 형식이 아닌 답');
    const { from, to } = calendarWindow(deps.now);
    const events = await expandIcs(body, from, to);
    const count = store.replaceCalendarRange(from, to, events, at);
    record = { at, ok: true, count, ms: Date.now() - started, lastOkAt: at };
  } catch (err) {
    const message = String((err as Error).message ?? err).split(address).join('<주소>').slice(0, 200);
    record = { at, ok: false, ms: Date.now() - started, error: message, ...(before?.lastOkAt ? { lastOkAt: before.lastOkAt } : {}) };
  }
  store.setJson(CALENDAR_META, record);
  return record;
}

/** Whether a turn's tools changed the calendar. */
export function usedCalendarTools(tools: string[]): boolean {
  return tools.some((t) => CALENDAR_WRITE_TOOLS.test(t));
}

/** Starts `cli calendar-fetch` apart (the Stop hook, after a calendar tool), when a key is set; says whether it did. */
export function spawnCalendarFetch(settings = calendarSettings()): boolean {
  if (!calendarAddress(settings)) return false;
  const child = spawn(process.execPath, ['--no-warnings', scriptPath('cli'), CLI.calendarFetch], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}

/** The summary's note when the last fetch failed: since when the events are known ('' when the last one went well). */
export function staleNote(store: Store): string {
  const last = lastFetch(store);
  if (!last || last.ok) return '';
  if (!last.lastOkAt) return '일정을 아직 못 받음';
  const t = formatLocal(last.lastOkAt);
  return `일정은 ${t.slice(5, 7)}/${t.slice(8, 10)} ${t.slice(11, 13)}시 기준(그 뒤 받기 실패)`;
}
