/**
 * Period pages (Today, Week, Month).
 *
 * All three share the same "shape" of data, so the webview renders them with
 * exactly the same components. A period page always contains: headline cards,
 * a trend chart, hour and weekday distributions, language and project slices,
 * the session list, insights and a comparison with the previous period.
 */

import type {
  ComparisonView,
  DailyTotalView,
  HourlyBucketView,
  LanguageSliceView,
  MetricCard,
  PeriodPayload,
  ProjectSliceView,
  SessionView,
  TrendPoint,
  TrendView,
  WeekdayBucketView,
} from '../types/analytics';
import type { CodingSession } from '../types/statistics';
import { formatDateShort, formatDuration, formatPercent, formatTime, languageLabel, weekdayOrder, formatWeekdayShort } from '../utils/format';
import { MS_PER_HOUR, clockTime } from '../utils/time';
import type { RangeTotals, StatsSource } from './Aggregator';
import { liveSession, rangeTotals, sessionsInRange, topLanguages, topProjects } from './Aggregator';
import { compareTotals, comparisonSummary } from './Comparison';
import { buildInsights } from './Insights';
import { describeRange, type RangeDescriptor } from './Ranges';
import type { StreakResult } from './Streaks';

/** How many slices of each kind a period page shows. */
export const PERIOD_LANGUAGE_LIMIT = 6;
export const PERIOD_PROJECT_LIMIT = 6;
export const PERIOD_SESSION_LIMIT = 200;

export interface PeriodBuildOptions {
  page: 'today' | 'week' | 'month';
  current: RangeDescriptor;
  previous?: RangeDescriptor;
  streaks: StreakResult;
}

/** Builds the payload of a period page. */
export function buildPeriodPayload(source: StatsSource, options: PeriodBuildOptions): PeriodPayload {
  const { current } = options;
  const totals = rangeTotals(source, current);
  const previousTotals = options.previous ? rangeTotals(source, options.previous) : undefined;

  const sessions = buildSessionViews(source, current, PERIOD_SESSION_LIMIT);
  const languages = buildLanguageSlices(totals, PERIOD_LANGUAGE_LIMIT, sessions);
  const projects = buildProjectSlices(source, totals, PERIOD_PROJECT_LIMIT);
  const comparison = buildComparison(source, current, options.previous, totals, previousTotals);

  const payload: PeriodPayload = {
    id: options.page,
    title: periodTitle(options.page),
    subtitle: describeRange(current, source.locale),
    rangeLabel: current.label,
    totalMs: totals.ms,
    cards: buildCards(source, options.page, totals, comparison),
    trend: buildTrend(source, options.page, current, totals),
    hourly: buildHourlyBuckets(source, totals),
    weekdays: buildWeekdayBuckets(source, totals),
    languages,
    projects,
    languageCount: Object.values(totals.languages).filter((ms) => ms > 0).length,
    projectCount: Object.values(totals.projects).filter((ms) => ms > 0).length,
    sessions,
    insights: buildInsights(source, current, totals, options.streaks, previousTotals),
    comparison,
    daily: buildDailyTotals(source, current, totals),
  };
  return payload;
}

/** Headline cards of a period page. */
export function buildCards(
  source: StatsSource,
  page: 'today' | 'week' | 'month',
  totals: RangeTotals,
  comparison: ComparisonView
): MetricCard[] {
  const cards: MetricCard[] = [];

  cards.push({
    id: 'active-time',
    label: 'Active coding time',
    value: formatDuration(totals.ms),
    sub: totals.activeDays > 0 ? `${formatDuration(totals.averagePerActiveDayMs)} per active day` : 'No activity recorded yet',
    hint: 'Only time with editor activity is counted; idle time is excluded.',
  });

  cards.push({
    id: 'sessions',
    label: 'Sessions',
    value: `${totals.sessions}`,
    sub:
      totals.sessions > 0
        ? `${formatDuration(Math.round(totals.ms / totals.sessions))} average · ${formatDuration(totals.longestSessionMs)} longest`
        : 'A session ends after the inactivity timeout',
    hint: 'A session is a stretch of activity separated by the configured inactivity timeout.',
  });

  const language = Object.entries(totals.languages)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1])[0];
  cards.push({
    id: 'top-language',
    label: 'Most active language',
    value: language ? languageLabel(language[0]) : '—',
    sub: language ? formatDuration(language[1]) : 'Tracked in the active editor',
  });

  const project = Object.entries(totals.projects)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1])[0];
  const projectName = project ? source.data.projects[project[0]]?.name ?? source.live?.projectNames?.[project[0]] : undefined;
  cards.push({
    id: 'top-project',
    label: 'Most active project',
    value: projectName ?? (project ? 'Unnamed project' : '—'),
    sub: project ? formatDuration(project[1]) : 'Open a folder to track projects',
    hint: 'Project names come from workspace folder names; their location is never stored.',
  });

  cards.push({
    id: 'files',
    label: 'Documents edited',
    value: `${totals.filesModified}`,
    sub: `${totals.filesSaved} saved · ${totals.filesOpened} opened`,
    hint: 'Dev Wrapped counts documents, never file names or contents.',
  });

  if (page === 'today') {
    cards.push({
      id: 'first-activity',
      label: 'First activity',
      value: totals.firstActivity ? clockTime(totals.firstActivity) : '—',
      sub: totals.lastActivity ? `Last activity ${clockTime(totals.lastActivity)}` : undefined,
      tone: 'muted',
    });
  } else {
    cards.push({
      id: 'consistency',
      label: 'Active days',
      value: `${totals.activeDays} / ${totals.range.days.length}`,
      sub: `${formatPercent(totals.range.days.length > 0 ? totals.activeDays / totals.range.days.length : 0, 0, source.locale)} of the period`,
      tone: 'muted',
    });
  }

  if (comparison.available) {
    cards.push({
      id: 'comparison',
      label: 'Compared with the previous period',
      value: formatDuration(totals.ms),
      sub: comparisonSummary(comparison),
      tone: 'muted',
      hint: 'Comparisons are reported as numbers, without judging the change.',
    });
  }

  return cards;
}

/** Trend chart: hours for today, days for week and month. */
export function buildTrend(
  source: StatsSource,
  page: 'today' | 'week' | 'month',
  range: RangeDescriptor,
  totals: RangeTotals
): TrendView {
  if (page === 'today') {
    const points: TrendPoint[] = totals.hourly.map((ms, hour) => ({
      key: String(hour),
      label: hour === 0 ? '12 AM' : `${hour}`,
      value: ms,
    }));
    // Only show the hours that already happened (plus one), keeping the chart readable.
    const currentHour = new Date(source.now).getHours();
    const visible = points.slice(0, Math.min(24, currentHour + 2));
    return { points: visible, granularity: 'hour', max: Math.max(0, ...visible.map((point) => point.value)) };
  }

  const points: TrendPoint[] = totals.days.map((day) => {
    const ts = new Date(`${day.date}T12:00:00`).getTime();
    return { key: day.date, label: formatDateShort(ts, source.locale), value: day.ms };
  });
  void range;
  return { points, granularity: 'day', max: Math.max(0, ...points.map((point) => point.value)) };
}

/** 24 hourly buckets with their share of the range. */
export function buildHourlyBuckets(source: StatsSource, totals: RangeTotals): HourlyBucketView[] {
  const total = totals.ms;
  return totals.hourly.map((ms, hour) => ({
    hour,
    label: formatHourLabel(hour, source.locale),
    ms,
    share: total > 0 ? ms / total : 0,
  }));
}

/** Seven weekday buckets, ordered by the configured week start. */
export function buildWeekdayBuckets(source: StatsSource, totals: RangeTotals): WeekdayBucketView[] {
  const order = weekdayOrder(source.weekStartsOn);
  const max = Math.max(0, ...totals.weekdays);
  return order.map((weekday) => ({
    weekday,
    label: formatWeekdayShort(weekday, source.locale),
    ms: totals.weekdays[weekday] ?? 0,
    share: max > 0 ? (totals.weekdays[weekday] ?? 0) / max : 0,
  }));
}

/**
 * Language slices of a range.
 *
 * The session count comes from the sessions themselves (using the language
 * that dominated each session), so the languages page can show "12 sessions"
 * without storing any extra information.
 */
export function buildLanguageSlices(
  totals: RangeTotals,
  limit: number,
  sessions: SessionView[] = []
): LanguageSliceView[] {
  const sessionCounts: Record<string, number> = {};
  for (const session of sessions) {
    if (session.language) {
      sessionCounts[session.language] = (sessionCounts[session.language] ?? 0) + 1;
    }
  }
  return topLanguages(totals, limit).map((slice) => ({
    id: slice.id,
    label: slice.label,
    ms: slice.ms,
    sessions: sessionCounts[slice.id] ?? 0,
    share: slice.share,
  }));
}

/** Project slices of a range. */
export function buildProjectSlices(source: StatsSource, totals: RangeTotals, limit: number): ProjectSliceView[] {
  return topProjects(source, totals, limit).map((slice) => ({
    id: slice.id,
    name: slice.name,
    ms: slice.ms,
    sessions: slice.sessions,
    share: slice.share,
    lastActive: slice.lastActive,
  }));
}

/** Sessions of a range, newest first, with the live session on top. */
export function buildSessionViews(
  source: StatsSource,
  range: RangeDescriptor,
  limit = PERIOD_SESSION_LIMIT
): SessionView[] {
  const stored = sessionsInRange(source, range).map((session) => toSessionView(session, range));
  const live = liveSession(source);
  if (live && live.startTime >= range.start && live.startTime < range.end) {
    stored.push(toSessionView(live, range, true));
  }
  return stored.sort((a, b) => b.start - a.start).slice(0, limit);
}

/** Daily rows of a range, oldest first (used by lists and summaries). */
export function buildDailyTotals(source: StatsSource, range: RangeDescriptor, totals: RangeTotals): DailyTotalView[] {
  void range;
  return totals.days.map((day) => {
    const ts = new Date(`${day.date}T12:00:00`).getTime();
    return {
      date: day.date,
      label: formatDateShort(ts, source.locale),
      ms: day.ms,
      sessions: day.sessions,
      languages: Object.entries(day.languages)
        .filter(([, ms]) => ms > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => languageLabel(id)),
      active: day.active,
    };
  });
}

/** Comparison between a period and the previous one. */
export function buildComparison(
  source: StatsSource,
  current: RangeDescriptor,
  previous: RangeDescriptor | undefined,
  currentTotals: RangeTotals,
  previousTotals: RangeTotals | undefined
): ComparisonView {
  void source;
  return compareTotals(currentTotals, previousTotals, {
    id: `compare-${current.kind}`,
    title: `Compared with ${previous ? describeRange(previous, source.locale) : 'the previous period'}`,
    currentLabel: describeRange(current, source.locale),
    previousLabel: previous ? describeRange(previous, source.locale) : 'the previous period',
  });
}

/** Converts a stored session into its view model. */
export function toSessionView(session: CodingSession, range: RangeDescriptor, live = false): SessionView {
  const view: SessionView = {
    id: session.id,
    start: session.startTime,
    end: session.endTime,
    durationMs: session.duration,
    dayKey: sessionDayKey(session, range),
  };
  if (session.language) {
    view.language = session.language;
    view.languageLabel = languageLabel(session.language);
  }
  if (session.project) {
    view.project = session.project;
  }
  if (session.projectName) {
    view.projectName = session.projectName;
  }
  if (live) {
    view.live = true;
  }
  return view;
}

/** Local day key of a session (the day it started). */
function sessionDayKey(session: CodingSession, range: RangeDescriptor): string {
  void range;
  return dateKeyOf(session.startTime);
}

/** Hour label used by the charts (`20:00`, localized where available). */
export function formatHourLabel(hour: number, locale: string): string {
  void locale;
  return `${hour < 10 ? '0' : ''}${hour}:00`;
}

/** `HH:MM` for a timestamp (re-export used by activity pages). */
export { clockTime };

/** Page title of a period page. */
export function periodTitle(page: 'today' | 'week' | 'month'): string {
  switch (page) {
    case 'today':
      return 'Today';
    case 'week':
      return 'This week';
    case 'month':
    default:
      return 'This month';
  }
}

/** Average active time per hour of the day (used by the year page). */
export function averagePerHour(totals: RangeTotals): number {
  const activeHours = totals.hourly.filter((ms) => ms > 0).length;
  return activeHours > 0 ? Math.round(totals.ms / activeHours) : 0;
}

/** Active hours of a period (a "coding hour" is a full hour bucket). */
export function activeHourCount(totals: RangeTotals): number {
  return Math.round(totals.ms / MS_PER_HOUR);
}

/** Local date key of a timestamp. */
function dateKeyOf(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Formats a session range as `09:15 – 11:40`. */
export function sessionTimeRange(session: { startTime: number; endTime: number }): string {
  return `${formatTime(session.startTime)} – ${formatTime(session.endTime)}`;
}
