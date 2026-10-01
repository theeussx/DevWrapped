/**
 * Calendar: the yearly heat map and the monthly grids.
 *
 * Heat map intensity is relative to the busiest day of the displayed range
 * (level 1-4), which makes a quiet month visible and a busy one readable
 * without hard coded thresholds. Empty days are level 0 and are rendered as
 * an idle cell, never as a gap in the grid.
 */

import type {
  CalendarDayView,
  CalendarMonthView,
  CalendarPayload,
  CalendarWeekView,
  HeatmapView,
  MonthlyTotalView,
} from '../types/analytics';
import type { DateKey } from '../types/statistics';
import { formatDateShort, formatMonthShort, formatMonthYear } from '../utils/format';
import { addDays, dateKey, enumerateDateKeys, monthKey, startOfMonth, startOfWeek } from '../utils/time';
import type { StatsSource } from './Aggregator';
import { dayTotals } from './Aggregator';
import { monthlyTotals } from './MonthlyStats';
import { availableYears, yearRange } from './Ranges';

/** Builds the heat map of a set of days. */
export function buildHeatmap(
  source: StatsSource,
  days: DateKey[],
  weekStartsOn: number,
  options: { padToFullWeeks?: boolean } = {}
): HeatmapView {
  const todayKey = dateKey(source.now);
  const first = days[0] ?? todayKey;
  const last = days[days.length - 1] ?? todayKey;
  const firstTs = parseDay(first);
  const lastTs = parseDay(last);

  // Extend to full weeks so the grid always has 7 rows and no ragged edges.
  const gridStart = startOfWeek(firstTs, weekStartsOn);
  const gridEnd = options.padToFullWeeks === false ? lastTs : addDays(startOfWeek(lastTs, weekStartsOn), 7);
  const keys = enumerateDateKeys(gridStart, addDays(gridEnd, -1));
  const inRangeKeys = new Set(days);

  const dayViews = keys.map((key) => buildDayView(source, key, inRangeKeys.has(key), todayKey));
  const maxMs = dayViews.reduce((max, day) => Math.max(max, day.inRange ? day.ms : 0), 0);
  const levelled = dayViews.map((day) => ({ ...day, level: levelFor(day.ms, maxMs) }));

  const weeks: CalendarWeekView[] = [];
  for (let index = 0; index < levelled.length; index += 7) {
    const weekDays = levelled.slice(index, index + 7);
    weeks.push({
      key: weekDays[0]?.date ?? `${index}`,
      days: weekDays,
      ms: weekDays.reduce((sum, day) => sum + (day.inRange ? day.ms : 0), 0),
    });
  }

  const months: Array<{ index: number; label: string }> = [];
  let lastMonth = '';
  weeks.forEach((week, index) => {
    const firstDay = week.days.find((day) => day.inRange) ?? week.days[0];
    if (!firstDay) {
      return;
    }
    const key = firstDay.date.slice(0, 7);
    if (key !== lastMonth) {
      lastMonth = key;
      months.push({ index, label: formatMonthShort(new Date(parseDay(firstDay.date)).getMonth(), source.locale) });
    }
  });

  const activeDays = levelled.filter((day) => day.inRange && day.ms > 0).length;
  return {
    weeks,
    months,
    maxMs,
    totalMs: levelled.filter((day) => day.inRange).reduce((sum, day) => sum + day.ms, 0),
    activeDays,
    start: first,
    end: last,
  };
}

/** Heat map of one year, from January 1st to the end of the year (or today). */
export function buildYearHeatmap(source: StatsSource, year: number): HeatmapView {
  const range = yearRange(
    { now: source.now, locale: source.locale, weekStartsOn: source.weekStartsOn },
    year
  );
  return buildHeatmap(source, range.days, source.weekStartsOn);
}

/** One month as a grid of weeks. */
export function buildMonthCalendar(source: StatsSource, year: number, monthIndex: number): CalendarMonthView {
  const start = startOfMonth(new Date(year, monthIndex, 1).getTime());
  const end = startOfMonth(new Date(year, monthIndex + 1, 1).getTime());
  const keys = enumerateDateKeys(start, addDays(end, -1));
  const heatmap = buildHeatmap(source, keys, source.weekStartsOn, { padToFullWeeks: true });
  return {
    key: monthKey(start),
    label: formatMonthYear(start, source.locale),
    year,
    monthIndex,
    weeks: heatmap.weeks,
    ms: heatmap.totalMs,
    activeDays: heatmap.activeDays,
  };
}

/** Everything the Calendar page needs. */
export function buildCalendarPayload(source: StatsSource, year: number): CalendarPayload {
  const heatmap = buildYearHeatmap(source, year);
  const months: CalendarMonthView[] = [];
  for (let month = 0; month < 12; month += 1) {
    months.push(buildMonthCalendar(source, year, month));
  }
  const days = heatmap.weeks.flatMap((week) => week.days).filter((day) => day.inRange);
  const bestDay = days.reduce<CalendarDayView | undefined>(
    (best, day) => (day.ms > 0 && (!best || day.ms > best.ms) ? day : best),
    undefined
  );
  const bestWeekMs = heatmap.weeks.reduce((max, week) => Math.max(max, week.ms), 0);
  const monthly: MonthlyTotalView[] = monthlyTotals(source, year);

  return {
    year,
    heatmap,
    months,
    totalMs: heatmap.totalMs,
    activeDays: heatmap.activeDays,
    bestWeekMs,
    monthly,
    years: availableYears(source.data, source.now),
    ...(bestDay ? { bestDay } : {}),
  };
}

/* ------------------------------- day helpers ------------------------------- */

/** A day of the calendar with its intensity level. */
export function buildDayView(
  source: StatsSource,
  key: DateKey,
  inRange: boolean,
  todayKey: string,
  maxMs = 0
): CalendarDayView {
  const totals = dayTotals(source, key);
  const ms = inRange ? totals.ms : 0;
  return {
    date: key,
    ms,
    level: levelFor(ms, maxMs),
    sessions: inRange ? totals.sessions : 0,
    label: formatDateShort(parseDay(key), source.locale),
    inRange,
    isToday: key === todayKey,
    countsForStreak: inRange && totals.qualifies,
  };
}

/** Intensity level 0-4 relative to the busiest day of the range. */
export function levelFor(ms: number, maxMs: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(ms) || ms <= 0 || maxMs <= 0) {
    return 0;
  }
  const ratio = ms / maxMs;
  if (ratio <= 0.2) {
    return 1;
  }
  if (ratio <= 0.4) {
    return 2;
  }
  if (ratio <= 0.7) {
    return 3;
  }
  return 4;
}

/** Local noon of a day key (avoids DST edge cases in date formatting). */
function parseDay(key: DateKey): number {
  return new Date(`${key}T12:00:00`).getTime();
}
