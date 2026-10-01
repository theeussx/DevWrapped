/**
 * Time ranges.
 *
 * A range is always a half open interval `[start, end)` in local time plus the
 * list of day keys it covers. Ranges never include future time: the current
 * day, week, month and year stop at "now", which keeps comparisons honest.
 *
 * Everything here is pure so the ranges can be unit tested around daylight
 * saving transitions, month ends and leap years.
 */

import type { DateKey, DatabaseData } from '../types/statistics';
import {
  addDays,
  addMonths,
  dateKey,
  enumerateDateKeys,
  monthKey,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from '../utils/time';
import { formatDateLong, formatDateShort, formatMonthYear, formatWeekRange } from '../utils/format';

export type RangeKind = 'day' | 'week' | 'month' | 'year' | 'all';

export interface RangeDescriptor {
  kind: RangeKind;
  /** Stable key: `2026-10-01`, week start day key, `2026-10`, `2026` or `all`. */
  key: string;
  /** Inclusive start, exclusive end. */
  start: number;
  end: number;
  /** Local day keys covered by the range. */
  days: DateKey[];
  /** Human readable label, pre-formatted for the webview. */
  label: string;
  /** `true` when the range contains "now". */
  current: boolean;
  year: number;
}

export interface RangeContext {
  now: number;
  locale: string;
  weekStartsOn: number;
}

/* ---------------------------------- ranges -------------------------------- */

/** The local day containing `now`, ending at "now". */
export function dayRange(context: RangeContext, offsetDays = 0): RangeDescriptor {
  const anchor = addDays(context.now, offsetDays);
  const start = startOfDay(anchor);
  const end = offsetDays === 0 ? context.now : Math.min(startOfDay(context.now), addDays(start, 1));
  const key = dateKey(start);
  return {
    kind: 'day',
    key,
    start,
    end: Math.max(start, end),
    days: [key],
    label: offsetDays === 0 ? 'Today' : 'Yesterday',
    current: offsetDays === 0,
    year: new Date(start).getFullYear(),
  };
}

/** The local week containing `now` (ending at "now" for the current week). */
export function weekRange(context: RangeContext, offsetWeeks = 0): RangeDescriptor {
  const anchor = addDays(context.now, offsetWeeks * 7);
  const start = startOfWeek(anchor, context.weekStartsOn);
  const naturalEnd = addDays(start, 7);
  const end = naturalEnd > context.now ? Math.min(naturalEnd, Math.max(context.now, start)) : naturalEnd;
  const key = dateKey(start);
  const isCurrent = start <= context.now && context.now < naturalEnd;
  return {
    kind: 'week',
    key,
    start,
    end,
    days: enumerateDateKeys(start, end),
    label: isCurrent ? 'This week' : offsetWeeks === -1 ? 'Last week' : formatWeekRange(start, addDays(end, -1), context.locale),
    current: isCurrent,
    year: new Date(start).getFullYear(),
  };
}

/** The local month containing `now` (ending at "now" for the current month). */
export function monthRange(context: RangeContext, offsetMonths = 0): RangeDescriptor {
  const anchor = addMonths(context.now, offsetMonths);
  const start = startOfMonth(anchor);
  const naturalEnd = startOfMonth(addMonths(start, 1));
  const end = naturalEnd > context.now ? Math.max(start, context.now) : naturalEnd;
  const isCurrent = start <= context.now && context.now < naturalEnd;
  return {
    kind: 'month',
    key: monthKey(start),
    start,
    end,
    days: enumerateDateKeys(start, end),
    label: isCurrent ? 'This month' : formatMonthYear(start, context.locale),
    current: isCurrent,
    year: new Date(start).getFullYear(),
  };
}

/** A whole local year (ending at "now" for the current year). */
export function yearRange(context: RangeContext, year: number): RangeDescriptor {
  const start = startOfYear(new Date(year, 0, 1).getTime());
  const naturalEnd = startOfYear(new Date(year + 1, 0, 1).getTime());
  const isCurrent = year === new Date(context.now).getFullYear();
  const end = isCurrent ? Math.max(start, context.now) : naturalEnd;
  return {
    kind: 'year',
    key: String(year),
    start,
    end,
    days: enumerateDateKeys(start, end),
    label: isCurrent ? 'This year' : String(year),
    current: isCurrent,
    year,
  };
}

/** The whole history: from the first recorded day until "now". */
export function allRange(context: RangeContext, data: DatabaseData): RangeDescriptor {
  const keys = Object.keys(data.days).sort();
  const firstKey = keys[0];
  const start = firstKey ? startOfDay(new Date(`${firstKey}T00:00:00`).getTime()) : startOfDay(context.now);
  return {
    kind: 'all',
    key: 'all',
    start,
    end: Math.max(start, context.now),
    days: enumerateDateKeys(start, context.now),
    label: 'All time',
    current: true,
    year: new Date(context.now).getFullYear(),
  };
}

/** The previous comparable range, or `undefined` when there is none. */
export function previousRange(
  context: RangeContext,
  range: RangeDescriptor,
  data: DatabaseData
): RangeDescriptor | undefined {
  switch (range.kind) {
    case 'day':
      return dayRange(context, -1);
    case 'week':
      return weekRange(context, -1);
    case 'month':
      return monthRange(context, -1);
    case 'year':
      return yearRange(context, range.year - 1);
    case 'all': {
      const keys = Object.keys(data.days).sort();
      const firstKey = keys[0];
      const firstDay = range.days[0];
      if (!firstKey || (firstDay !== undefined && firstKey >= firstDay)) {
        return undefined;
      }
      const previousEnd = startOfDay(new Date(`${firstKey}T00:00:00`).getTime());
      const previousStart = addDays(previousEnd, -range.days.length);
      return {
        kind: 'all',
        key: `all:${dateKey(previousStart)}`,
        start: previousStart,
        end: previousEnd,
        days: enumerateDateKeys(previousStart, previousEnd),
        label: 'Previous period',
        current: false,
        year: new Date(previousStart).getFullYear(),
      };
    }
    default:
      return undefined;
  }
}

/** `true` when a timestamp falls inside the range. */
export function inRange(range: RangeDescriptor, ts: number): boolean {
  return ts >= range.start && ts < range.end;
}

/** Human readable single-line description of a range. */
export function describeRange(range: RangeDescriptor, locale: string): string {
  switch (range.kind) {
    case 'day':
      return formatDateLong(range.start, locale, new Date().getFullYear());
    case 'week':
      return formatWeekRange(range.start, addDays(range.end, -1), locale);
    case 'month':
      return formatMonthYear(range.start, locale);
    case 'year':
      return String(range.year);
    case 'all':
    default:
      return range.days.length > 0
        ? `${formatDateShort(range.start, locale)} – ${formatDateShort(range.end, locale)}`
        : 'All time';
  }
}

/** The years that have any recorded data, newest first. */
export function availableYears(data: DatabaseData, now: number): number[] {
  const years = new Set<number>();
  years.add(new Date(now).getFullYear());
  for (const key of Object.keys(data.days)) {
    const year = Number(key.slice(0, 4));
    if (Number.isFinite(year)) {
      years.add(year);
    }
  }
  for (const session of data.sessions) {
    years.add(new Date(session.startTime).getFullYear());
  }
  return [...years].sort((a, b) => b - a).slice(0, 40);
}
