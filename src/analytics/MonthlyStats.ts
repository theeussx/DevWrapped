/**
 * Month page.
 *
 * Adds a calendar grid for the month on top of the shared period payload, so
 * the user can see the daily shape of the month and switch between months
 * without leaving the page.
 */

import type { CalendarMonthView, MonthlyTotalView, PeriodPayload } from '../types/analytics';
import { formatMonthShort, formatMonthYear } from '../utils/format';
import { addDays, daysInMonth, startOfMonth } from '../utils/time';
import type { StatsSource } from './Aggregator';
import { rangeTotals } from './Aggregator';
import { buildMonthCalendar } from './CalendarStats';
import { buildPeriodPayload } from './Periods';
import { monthRange, previousRange, type RangeContext, type RangeDescriptor } from './Ranges';
import type { StreakResult } from './Streaks';

export interface MonthlyStatsOptions {
  range?: RangeDescriptor;
  previous?: RangeDescriptor;
  streaks: StreakResult;
}

/** The Month page as the webview receives it. */
export interface MonthPagePayload extends PeriodPayload {
  calendar: CalendarMonthView;
}

/** Builds the Month page. */
export function buildMonthlyStats(source: StatsSource, options: MonthlyStatsOptions): MonthPagePayload {
  const context: RangeContext = {
    now: source.now,
    locale: source.locale,
    weekStartsOn: source.weekStartsOn,
  };
  const current = options.range ?? monthRange(context);
  const previous = options.previous ?? previousRange(context, current, source.data);
  const payload = buildPeriodPayload(source, {
    page: 'month',
    current,
    streaks: options.streaks,
    ...(previous ? { previous } : {}),
  });
  return {
    ...payload,
    subtitle: formatMonthYear(current.start, source.locale),
    calendar: buildMonthCalendar(source, new Date(current.start).getFullYear(), new Date(current.start).getMonth()),
  };
}

/** One row per month of a year, used by the year page and the month switcher. */
export function monthlyTotals(source: StatsSource, year: number): MonthlyTotalView[] {
  const months: MonthlyTotalView[] = [];
  let total = 0;
  for (let month = 0; month < 12; month += 1) {
    const start = startOfMonth(new Date(year, month, 1).getTime());
    const range: RangeDescriptor = {
      kind: 'month',
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      start,
      end: startOfMonth(new Date(year, month + 1, 1).getTime()),
      days: [],
      label: formatMonthShort(month, source.locale),
      current: false,
      year,
    };
    range.days = enumerateMonthDays(year, month);
    const totals = rangeTotals(source, range);
    total += totals.ms;
    months.push({
      key: range.key,
      label: formatMonthShort(month, source.locale),
      ms: totals.ms,
      sessions: totals.sessions,
      share: 0,
      activeDays: totals.activeDays,
    });
  }
  for (const month of months) {
    month.share = total > 0 ? month.ms / total : 0;
  }
  return months;
}

/** Day keys of a month. */
function enumerateMonthDays(year: number, month: number): string[] {
  const days: string[] = [];
  const length = daysInMonth(year, month);
  let cursor = startOfMonth(new Date(year, month, 1).getTime());
  for (let index = 0; index < length; index += 1) {
    const date = new Date(cursor);
    days.push(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    );
    cursor = addDays(cursor, 1);
  }
  return days;
}
