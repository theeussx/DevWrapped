/**
 * Insights.
 *
 * Insights describe the shape of the recorded activity: when the user tends to
 * work, which language or project dominated, how regular the days were. They
 * are written as observations ("most activity happens between 20:00 and 22:00")
 * and never as advice, scores or judgements about productivity or quality.
 *
 * Each insight is only produced when the data actually supports it, so the
 * dashboard never shows a sentence built on an empty range.
 */

import type { InsightView, InsightsPayload } from '../types/analytics';
import { formatDateLong, formatDuration, formatHour, formatPercent, languageLabel } from '../utils/format';
import type { RangeTotals, StatsSource } from './Aggregator';
import { peakHour, projectMeta, topKey } from './Aggregator';
import { formatWeekday, longestSessionOf } from './Records';
import type { RangeDescriptor } from './Ranges';
import type { StreakResult } from './Streaks';

/** Insights for one range. `previous` enables the comparison insight. */
export function buildInsights(
  source: StatsSource,
  range: RangeDescriptor,
  totals: RangeTotals,
  streaks: StreakResult,
  previous?: RangeTotals
): InsightView[] {
  const insights: InsightView[] = [];
  if (totals.ms <= 0) {
    return insights;
  }

  /* ------------------------------- rhythm ------------------------------- */
  const hour = peakHour(totals);
  if (hour !== undefined) {
    const share = totals.ms > 0 ? (totals.hourly[hour] ?? 0) / totals.ms : 0;
    insights.push({
      id: 'rhythm',
      kind: 'rhythm',
      icon: 'clock',
      tone: 'neutral',
      title: `Most activity happens around ${formatHour(hour, source.locale)}`,
      body: `${formatPercent(share, 0, source.locale)} of the active time in ${rangeLabelOf(range)} falls in that hour. Your day currently starts around ${formatHour(
        firstHourWithActivity(totals) ?? hour,
        source.locale
      )}.`,
    });
  }

  /* ----------------------------- consistency ---------------------------- */
  if (range.days.length > 1) {
    const ratio = totals.activeDays / range.days.length;
    insights.push({
      id: 'consistency',
      kind: 'consistency',
      icon: 'calendar',
      tone: 'neutral',
      title: `Active on ${totals.activeDays} of ${range.days.length} days`,
      body: `${formatPercent(ratio, 0, source.locale)} of the days in ${rangeLabelOf(range)} have recorded activity. Days below ${streaks.minimumActiveTimeMinutes} minutes do not count towards a streak.`,
    });
  }

  /* ------------------------------- language ----------------------------- */
  const language = topKey(totals.languages);
  if (language) {
    const ms = totals.languages[language] ?? 0;
    const share = totals.ms > 0 ? ms / totals.ms : 0;
    insights.push({
      id: 'language',
      kind: 'language',
      icon: 'code',
      tone: 'neutral',
      title: `${languageLabel(language)} leads with ${formatPercent(share, 0, source.locale)} of the time`,
      body: `${formatDuration(ms)} of active time was spent in ${languageLabel(language)} — ${formatDuration(
        totals.ms - ms
      )} in other languages.`,
    });
  }

  /* ------------------------------- project ------------------------------ */
  const project = topKey(totals.projects);
  if (project) {
    const ms = totals.projects[project] ?? 0;
    const name = projectMeta(source, project)?.name ?? 'the most active project';
    insights.push({
      id: 'project',
      kind: 'project',
      icon: 'folder',
      tone: 'neutral',
      title: `${name} accounts for the most active time`,
      body: `${formatDuration(ms)} — ${formatPercent(totals.ms > 0 ? ms / totals.ms : 0, 0, source.locale)} of the range. Project names come from workspace folders; locations are never stored.`,
    });
  }

  /* ------------------------------- sessions ----------------------------- */
  if (totals.sessions > 0) {
    const average = Math.round(totals.ms / totals.sessions);
    insights.push({
      id: 'sessions',
      kind: 'sessions',
      icon: 'clock',
      tone: 'neutral',
      title: `${totals.sessions} session${totals.sessions === 1 ? '' : 's'}, ${formatDuration(average)} each on average`,
      body: `A session ends after ${source.minimumActiveTimeMs > 0 ? '' : ''}the configured inactivity timeout; the longest one lasted ${formatDuration(
        totals.longestSessionMs
      )}.`,
    });
  }

  /* -------------------------------- volume ------------------------------ */
  if (totals.activeDays > 1) {
    insights.push({
      id: 'volume',
      kind: 'volume',
      icon: 'spark',
      tone: 'neutral',
      title: `${formatDuration(totals.ms)} of active time across ${totals.activeDays} days`,
      body: `That averages ${formatDuration(totals.averagePerActiveDayMs)} per active day, with ${formatDuration(
        totals.filesModified > 0 ? totals.ms : 0
      )} recorded in the busiest one.`,
    });
  }

  /* -------------------------------- streak ------------------------------ */
  if (streaks.current > 1 || streaks.longest > 1) {
    insights.push({
      id: 'streak',
      kind: 'streak',
      icon: 'flame',
      tone: 'neutral',
      title:
        streaks.current > 1
          ? `${streaks.current} days in a row above ${streaks.minimumActiveTimeMinutes} minutes`
          : `Longest run: ${streaks.longest} days in a row`,
      body:
        streaks.longestStart && streaks.longestEnd
          ? `The longest run so far is ${formatDateLongRange(streaks.longestStart, streaks.longestEnd, source.locale)}.`
          : 'Streaks count days that reach the configured minimum active time.',
    });
  }

  /* ------------------------------ comparison ---------------------------- */
  if (previous && (previous.ms > 0 || previous.activeDays > 0)) {
    const delta = totals.ms - previous.ms;
    const direction = delta >= 0 ? 'more' : 'less';
    insights.push({
      id: 'comparison',
      kind: 'comparison',
      icon: 'calendar',
      tone: 'neutral',
      title: `${formatDuration(Math.abs(delta))} ${direction} than the previous period`,
      body: `${formatDuration(totals.ms)} now versus ${formatDuration(previous.ms)} before — ${formatPercent(
        previous.ms > 0 ? Math.abs(delta) / previous.ms : 0,
        0,
        source.locale
      )} ${direction}.`,
    });
  }

  /* ----------------------------- session shape -------------------------- */
  const longest = longestSessionOf(source, range);
  if (longest && longest.duration > 0) {
    insights.push({
      id: 'longest-session',
      kind: 'sessions',
      icon: 'spark',
      tone: 'neutral',
      title: `Longest session: ${formatDuration(longest.duration)}`,
      body: `Started ${formatDateLong(longest.startTime, source.locale)}${
        longest.language ? ` in ${languageLabel(longest.language)}` : ''
      }.`,
    });
  }

  return insights;
}

/** Insights page payload: insights, records, streaks, rhythm and slices. */
export function buildInsightsPayload(
  source: StatsSource,
  range: RangeDescriptor,
  totals: RangeTotals,
  streaks: StreakResult,
  records: InsightsPayload['records'],
  slices: { languages: InsightsPayload['languages']; projects: InsightsPayload['projects'] }
): InsightsPayload {
  const insights = buildInsights(source, range, totals, streaks);
  const hour = peakHour(totals);
  const quietestHours = [...totals.hourly.entries()]
    .filter(([, ms]) => ms === 0)
    .map(([index]) => index)
    .slice(0, 6);

  const payload: InsightsPayload = {
    insights,
    records,
    streaks: {
      current: streaks.current,
      longest: streaks.longest,
      qualifyingDays: streaks.qualifyingDays,
      minimumActiveTimeMinutes: streaks.minimumActiveTimeMinutes,
      ...(streaks.currentStart ? { currentStart: streaks.currentStart } : {}),
      ...(streaks.longestStart ? { longestStart: streaks.longestStart } : {}),
      ...(streaks.longestEnd ? { longestEnd: streaks.longestEnd } : {}),
    },
    consistency: {
      activeDays: totals.activeDays,
      trackedDays: range.days.length,
      ratio: range.days.length > 0 ? totals.activeDays / range.days.length : 0,
      label: `Active on ${totals.activeDays} of ${range.days.length} days`,
    },
    rhythm: {
      quietestHours,
      note:
        hour === undefined
          ? 'No activity recorded in this range yet.'
          : `Activity concentrates around ${formatHour(hour, source.locale)}; ${quietestHours.length} of the 24 hours have no recorded activity.`,
    },
    languages: slices.languages,
    projects: slices.projects,
  };

  if (hour !== undefined) {
    payload.rhythm.bestHour = {
      hour,
      label: formatHour(hour, source.locale),
      ms: totals.hourly[hour] ?? 0,
      share: totals.ms > 0 ? (totals.hourly[hour] ?? 0) / totals.ms : 0,
    };
  }
  const weekday = busiestWeekdayOf(totals);
  if (weekday !== undefined) {
    payload.rhythm.busiestWeekday = {
      weekday,
      label: formatWeekday(weekday, source.locale),
      ms: totals.weekdays[weekday] ?? 0,
      share: totals.ms > 0 ? (totals.weekdays[weekday] ?? 0) / totals.ms : 0,
    };
  }
  return payload;
}

/** First hour with any recorded activity. */
export function firstHourWithActivity(totals: RangeTotals): number | undefined {
  const index = totals.hourly.findIndex((ms) => ms > 0);
  return index >= 0 ? index : undefined;
}

/** Weekday index with the most active time. */
function busiestWeekdayOf(totals: RangeTotals): number | undefined {
  let index: number | undefined;
  let best = 0;
  totals.weekdays.forEach((ms, weekday) => {
    if (ms > best) {
      best = ms;
      index = weekday;
    }
  });
  return index;
}

/** Range label used inside insight sentences. */
function rangeLabelOf(range: RangeDescriptor): string {
  switch (range.kind) {
    case 'day':
      return 'this day';
    case 'week':
      return 'this week';
    case 'month':
      return 'this month';
    case 'year':
      return `in ${range.year}`;
    case 'all':
    default:
      return 'the recorded history';
  }
}

/** `Sep 1 – Sep 20` (or the same day twice). */
function formatDateLongRange(startKey: string, endKey: string, locale: string): string {
  const start = new Date(`${startKey}T12:00:00`).getTime();
  const end = new Date(`${endKey}T12:00:00`).getTime();
  if (startKey === endKey) {
    return formatDateLong(start, locale);
  }
  return `${formatDateLong(start, locale)} to ${formatDateLong(end, locale)}`;
}
