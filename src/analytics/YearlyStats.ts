/**
 * Year page.
 *
 * The annual view combines the heat map, the monthly distribution, records,
 * the language and project breakdowns and a comparison with the previous year.
 * It is the page the retrospective ("Wrapped") is derived from.
 */

import type {
  ComparisonView,
  MetricCard,
  MonthlyTotalView,
  TrendPoint,
  TrendView,
  YearPayload,
} from '../types/analytics';
import { formatDuration, formatPercent, languageLabel } from '../utils/format';
import { MS_PER_HOUR } from '../utils/time';
import type { RangeTotals, StatsSource } from './Aggregator';
import { projectMeta, rangeTotals, topKey } from './Aggregator';
import { buildYearHeatmap } from './CalendarStats';
import { compareTotals } from './Comparison';
import { buildInsights } from './Insights';
import { monthlyTotals } from './MonthlyStats';
import { buildHourlyBuckets, buildLanguageSlices, buildProjectSlices, buildSessionViews, buildWeekdayBuckets } from './Periods';
import { buildRecords, longestSessionOf } from './Records';
import { previousRange, yearRange, type RangeContext } from './Ranges';
import type { StreakResult } from './Streaks';

export interface YearlyStatsOptions {
  streaks: StreakResult;
}

/** Builds the Year page for `year`. */
export function buildYearlyStats(source: StatsSource, year: number, options: YearlyStatsOptions): YearPayload {
  const context: RangeContext = { now: source.now, locale: source.locale, weekStartsOn: source.weekStartsOn };
  const current = yearRange(context, year);
  const previous = previousRange(context, current, source.data);
  const totals = rangeTotals(source, current);
  const previousTotals = previous ? rangeTotals(source, previous) : undefined;
  const months = monthlyTotals(source, year);
  const sessions = buildSessionViews(source, current);
  const languages = buildLanguageSlices(totals, 8, sessions);
  const projects = buildProjectSlices(source, totals, 8);

  const comparison: ComparisonView = compareTotals(totals, previousTotals, {
    id: `compare-year-${year}`,
    title: `Compared with ${year - 1}`,
    currentLabel: String(year),
    previousLabel: String(year - 1),
  });

  const longest = longestSessionOf(source, current);
  const cards: MetricCard[] = [
    {
      id: 'active-time',
      label: 'Active coding time',
      value: formatDuration(totals.ms),
      sub: `${Math.round(totals.ms / MS_PER_HOUR)} hours · ${totals.activeDays} active days`,
      hint: 'Idle time is never counted.',
    },
    {
      id: 'sessions',
      label: 'Sessions',
      value: `${totals.sessions}`,
      sub:
        totals.sessions > 0
          ? `${formatDuration(Math.round(totals.ms / totals.sessions))} average`
          : 'No sessions recorded in this year',
    },
    {
      id: 'busiest-month',
      label: 'Busiest month',
      value: busiestMonth(months)?.label ?? '—',
      sub: busiestMonth(months) ? formatDuration(busiestMonth(months)?.ms ?? 0) : undefined,
    },
    {
      id: 'top-language',
      label: 'Most active language',
      value: languageLabel(topKey(totals.languages) ?? '') || '—',
      sub: topKey(totals.languages) ? formatDuration(totals.languages[topKey(totals.languages) ?? ''] ?? 0) : undefined,
    },
    {
      id: 'top-project',
      label: 'Most active project',
      value: projectMeta(source, topKey(totals.projects) ?? '')?.name ?? '—',
      sub: topKey(totals.projects) ? formatDuration(totals.projects[topKey(totals.projects) ?? ''] ?? 0) : undefined,
      hint: 'Only the workspace folder name is stored.',
    },
    {
      id: 'documents',
      label: 'Documents edited',
      value: `${totals.filesModified}`,
      sub: `${totals.filesSaved} saved`,
    },
    {
      id: 'longest-session',
      label: 'Longest session',
      value: longest ? formatDuration(longest.duration) : '—',
      sub: longest
        ? `${formatPercent(totals.ms > 0 ? longest.duration / totals.ms : 0, 0, source.locale)} of the year`
        : undefined,
      tone: 'muted',
    },
    {
      id: 'consistency',
      label: 'Active days',
      value: `${totals.activeDays}`,
      sub: `${formatPercent(current.days.length > 0 ? totals.activeDays / current.days.length : 0, 0, source.locale)} of ${current.days.length} days`,
      tone: 'muted',
    },
  ];

  return {
    year,
    totalMs: totals.ms,
    cards,
    trend: buildYearTrend(months),
    months,
    heatmap: buildYearHeatmap(source, year),
    hourly: buildHourlyBuckets(source, totals),
    weekdays: buildWeekdayBuckets(source, totals),
    languages,
    projects,
    records: buildRecords(source, current, totals),
    sessions: sessions.slice(0, 120),
    comparison,
    insights: buildInsights(source, current, totals, options.streaks, previousTotals),
    wrappedAvailable: totals.ms > 0,
  };
}

/** The twelve months of a year as a trend series. */
export function buildYearTrend(months: MonthlyTotalView[]): TrendView {
  const points: TrendPoint[] = months.map((month) => ({
    key: month.key,
    label: month.label,
    value: month.ms,
  }));
  return { points, granularity: 'month', max: Math.max(0, ...points.map((point) => point.value)) };
}

/** Month with the most active time. */
export function busiestMonth(months: MonthlyTotalView[]): MonthlyTotalView | undefined {
  let best: MonthlyTotalView | undefined;
  for (const month of months) {
    if (!best || month.ms > best.ms) {
      best = month;
    }
  }
  return best && best.ms > 0 ? best : undefined;
}

/** Totals of a year, exposed for the retrospective. */
export function yearTotals(source: StatsSource, year: number): RangeTotals {
  return rangeTotals(source, yearRange({ now: source.now, locale: source.locale, weekStartsOn: source.weekStartsOn }, year));
}
