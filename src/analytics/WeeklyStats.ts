/**
 * Week page.
 *
 * Adds week specific information on top of the shared period payload: the
 * weekday distribution (useful at this scale) and the week boundaries, which
 * follow the locale's first day of the week.
 */

import type { PeriodPayload } from '../types/analytics';
import { addDays, startOfWeek } from '../utils/time';
import { formatWeekRange } from '../utils/format';
import type { StatsSource } from './Aggregator';
import { buildPeriodPayload } from './Periods';
import { previousRange, weekRange, type RangeContext, type RangeDescriptor } from './Ranges';
import type { StreakResult } from './Streaks';

export interface WeeklyStatsOptions {
  range?: RangeDescriptor;
  previous?: RangeDescriptor;
  streaks: StreakResult;
}

/** Builds the Week page. */
export function buildWeeklyStats(source: StatsSource, options: WeeklyStatsOptions): PeriodPayload {
  const context: RangeContext = {
    now: source.now,
    locale: source.locale,
    weekStartsOn: source.weekStartsOn,
  };
  const current = options.range ?? weekRange(context);
  const previous = options.previous ?? previousRange(context, current, source.data);
  const payload = buildPeriodPayload(source, {
    ...(previous ? { page: 'week' as const, current, previous, streaks: options.streaks } : { page: 'week' as const, current, streaks: options.streaks }),
  });
  payload.subtitle = formatWeekRange(current.start, addDays(current.end, -1), source.locale);
  payload.rangeLabel = current.label;
  return payload;
}

/** Start of the week containing a timestamp (helper for tests and commands). */
export function weekStartOf(ts: number, weekStartsOn: number): number {
  return startOfWeek(ts, weekStartsOn);
}
