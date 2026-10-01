/**
 * Today page.
 *
 * Uses the shared period builder with the local day as range, so "Today" has
 * exactly the same structure as the week and month pages and no layout code
 * has to be duplicated in the webview.
 */

import type { PeriodPayload } from '../types/analytics';
import { addDays, startOfDay } from '../utils/time';
import type { StatsSource } from './Aggregator';
import { buildPeriodPayload } from './Periods';
import { dayRange, type RangeContext, type RangeDescriptor } from './Ranges';
import type { StreakResult } from './Streaks';

export interface DailyStatsOptions {
  range?: RangeDescriptor;
  previous?: RangeDescriptor;
  streaks: StreakResult;
}

/** Builds the Today page. */
export function buildDailyStats(source: StatsSource, options: DailyStatsOptions): PeriodPayload {
  const context: RangeContext = {
    now: source.now,
    locale: source.locale,
    weekStartsOn: source.weekStartsOn,
  };
  const current = options.range ?? dayRange(context);
  const previous =
    options.previous ??
    ({
      kind: 'day' as const,
      key: current.days[0] ?? current.key,
      start: addDays(startOfDay(current.start), -1),
      end: current.start,
      days: [dateKeyOf(addDays(startOfDay(current.start), -1))],
      label: 'Yesterday',
      current: false,
      year: new Date(current.start).getFullYear(),
    } satisfies RangeDescriptor);
  return buildPeriodPayload(source, { page: 'today', current, previous, streaks: options.streaks });
}

/** Local date key of a timestamp. */
function dateKeyOf(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
