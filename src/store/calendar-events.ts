/**
 * 받아 둔 캘린더 일정(calendar_events, 옮기기 19): 회차 하나가 한 행. 받을 때마다 저장 범위(어제~앞으로 30일)를 한 트랜잭션에서
 * 지우고 다시 넣는다(todo-summary/calendar.ts). 시각은 UTC ISO, 종일 일정은 그 날 00시(표시 시간대)부터.
 * Store(store/store.ts)가 이 함수들을 묶어 메서드로 내놓는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './schema.ts';

export interface CalendarEvent {
  uid: string;
  /** The occurrence's original start (its RECURRENCE-ID, or its own start for a one-off), UTC ISO: with uid, its key. */
  recurrence_at: string;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  title: string;
  location: string | null;
}

/**
 * Replaces every occurrence starting in [fromIso, toIso) with `events` (those outside the range are left out); older
 * occurrences, before the range, go too (the summary never reads them).
 */
export function replaceCalendarRange(db: DatabaseSync, fromIso: string, toIso: string, events: CalendarEvent[], fetchedAt: string): number {
  return transaction(db, () => {
    db.prepare('DELETE FROM calendar_events WHERE start_at < ?').run(toIso);
    const put = db.prepare(
      `INSERT OR REPLACE INTO calendar_events (uid, recurrence_at, start_at, end_at, all_day, title, location, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const e of events) {
      if (e.start_at < fromIso || e.start_at >= toIso) continue;
      put.run(e.uid, e.recurrence_at, e.start_at, e.end_at, e.all_day ? 1 : 0, e.title, e.location, fetchedAt);
      n++;
    }
    return n;
  });
}

/** Occurrences starting in [fromIso, toIso), earliest first. */
export function calendarEventsBetween(db: DatabaseSync, fromIso: string, toIso: string): CalendarEvent[] {
  const rows = db
    .prepare('SELECT uid, recurrence_at, start_at, end_at, all_day, title, location FROM calendar_events WHERE start_at >= ? AND start_at < ? ORDER BY start_at, title')
    .all(fromIso, toIso) as Array<Omit<CalendarEvent, 'all_day'> & { all_day: number }>;
  return rows.map((r) => ({ ...r, all_day: r.all_day === 1 }));
}
