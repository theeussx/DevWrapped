/**
 * Local-time calendar helpers.
 *
 * Dev Wrapped deliberately never uses UTC for bucketing: a day is the day the
 * user experienced, including daylight saving changes and timezone moves.
 * Weeks start on Monday by default and are configurable.
 */

import type { DateKey, MonthKey } from '../types/statistics';

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export const DEFAULT_WEEK_START = 1; // Monday

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local `YYYY-MM-DD` for a timestamp. */
export function dateKey(ts: number): DateKey {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local `YYYY-MM` for a timestamp. */
export function monthKey(ts: number): MonthKey {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** Local midnight at the start of the given day. */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight at the start of the next day (exclusive end of the day). */
export function endOfDay(ts: number): number {
  return addDays(startOfDay(ts), 1);
}

/** Local midnight at the start of the week containing `ts`. */
export function startOfWeek(ts: number, weekStartsOn: number = DEFAULT_WEEK_START): number {
  const start = startOfDay(ts);
  const current = new Date(start).getDay();
  const offset = (current - weekStartsOn + 7) % 7;
  return addDays(start, -offset);
}

/** Local midnight at the start of the month containing `ts`. */
export function startOfMonth(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0).getTime();
}

/** Local midnight at the start of the year containing `ts`. */
export function startOfYear(ts: number): number {
  return new Date(new Date(ts).getFullYear(), 0, 1, 0, 0, 0, 0).getTime();
}

/** Adds whole days, keeping the local wall-clock time (DST safe). */
export function addDays(ts: number, amount: number): number {
  const date = new Date(ts);
  date.setDate(date.getDate() + amount);
  return date.getTime();
}

/** Adds whole months, keeping the local wall-clock time. */
export function addMonths(ts: number, amount: number): number {
  const date = new Date(ts);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  const daysInTarget = daysInMonth(date.getFullYear(), date.getMonth());
  date.setDate(Math.min(day, daysInTarget));
  return date.getTime();
}

/** Number of days in a month (`monthIndex` is 0 based). */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Weekday index (0 = Sunday) for a timestamp. */
export function dayOfWeek(ts: number): number {
  return new Date(ts).getDay();
}

/** Zero based month index for a timestamp. */
export function monthOfYear(ts: number): number {
  return new Date(ts).getMonth();
}

/** Hour of day (0-23) for a timestamp. */
export function hourOfDay(ts: number): number {
  return new Date(ts).getHours();
}

/** `true` when the value is a valid `YYYY-MM-DD` calendar date. */
export function isValidDateKey(value: unknown): value is DateKey {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** `true` when the value is a valid `YYYY-MM` month key. */
export function isValidMonthKey(value: unknown): value is MonthKey {
  return typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
}

/** Local midnight of a date key, or `undefined` when the key is invalid. */
export function parseDateKey(key: string): number | undefined {
  if (!isValidDateKey(key)) {
    return undefined;
  }
  const [year, month, day] = key.split('-').map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

/** Start (inclusive) and end (exclusive) timestamps of a date key. */
export function dateKeyRange(key: DateKey): { start: number; end: number } {
  const start = parseDateKey(key) ?? startOfDay(Date.now());
  return { start, end: addDays(start, 1) };
}

/** Whole days between two date keys (negative when `a` is after `b`). */
export function daysBetweenDateKeys(a: DateKey, b: DateKey): number {
  const startA = parseDateKey(a);
  const startB = parseDateKey(b);
  if (startA === undefined || startB === undefined) {
    return 0;
  }
  const diff = startB - startA;
  // Rounding keeps DST transitions (23h / 25h days) from skewing the count.
  return Math.round(diff / MS_PER_DAY);
}

/** Every date key from `start` to `end`, both inclusive. */
export function enumerateDateKeys(start: string | number, end: string | number): DateKey[] {
  const startTs = typeof start === 'string' ? parseDateKey(start) : start;
  const endTs = typeof end === 'string' ? parseDateKey(end) : end;
  if (startTs === undefined || endTs === undefined || endTs < startTs) {
    return [];
  }
  const keys: DateKey[] = [];
  let cursor = startOfDay(startTs);
  const limit = startOfDay(endTs);
  // Guard against pathological ranges (more than ~30 years).
  for (let index = 0; index < 11_000 && cursor <= limit; index += 1) {
    keys.push(dateKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return keys;
}

/** Date key of the first day of the week containing `ts`. */
export function weekStartKey(ts: number, weekStartsOn: number = DEFAULT_WEEK_START): DateKey {
  return dateKey(startOfWeek(ts, weekStartsOn));
}

/** Shift a date key by a number of days. */
export function shiftDateKey(key: DateKey, days: number): DateKey {
  const start = parseDateKey(key);
  return start === undefined ? key : dateKey(addDays(start, days));
}

/** Format a timestamp as `HH:MM` in local time (numeric, locale independent). */
export function clockTime(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Milliseconds since the start of the local day. */
export function msSinceStartOfDay(ts: number): number {
  return ts - startOfDay(ts);
}

/** Clamps a timestamp into the given inclusive range. */
export function clamp(ts: number, min: number, max: number): number {
  return Math.min(Math.max(ts, min), max);
}
