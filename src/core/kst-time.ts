/** Times: stored as UTC ISO strings, shown in TIMEZONE (Korea by default), always 24-hour. */
import { TIMEZONE } from './config.ts';

const LOCAL_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Stored UTC ISO (or epoch ms) → "2026-10-16 20:05" in TIMEZONE (24-hour). `dateOnly` gives
 * "2026-10-16", `seconds` "2026-10-16 20:05:09". Unparseable input is returned unchanged.
 */
export function formatLocal(when: string | number, dateOnly = false, seconds = false): string {
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(t)) return String(when);
  return LOCAL_FORMAT.format(t).slice(0, dateOnly ? 10 : seconds ? 19 : 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}
