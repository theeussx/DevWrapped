/**
 * Activity page.
 *
 * A chronological view of what happened: day summaries plus the individual
 * sessions, newest first. It is the page to open when a total looks surprising
 * — every number in the dashboard can be traced back to a session here.
 */

import type { ActivityPayload, DailyTotalView, TimelineEventView } from '../types/analytics';
import { formatDateLong, formatDuration, formatPercent, formatTime, languageLabel } from '../utils/format';
import { dateKey } from '../utils/time';
import type { StatsSource } from './Aggregator';
import { rangeTotals, sessionsInRange } from './Aggregator';
import { buildDailyTotals, sessionTimeRange } from './Periods';
import { describeRange, type RangeDescriptor } from './Ranges';

/** Maximum number of timeline entries sent to the webview. */
export const TIMELINE_LIMIT = 300;

/** Builds the Activity page for a range. */
export function buildActivityPage(source: StatsSource, range: RangeDescriptor): ActivityPayload {
  const totals = rangeTotals(source, range);
  const days = buildDailyTotals(source, range, totals);
  const sessions = sessionsInRange(source, range);
  const timeline: TimelineEventView[] = [];

  // Day summaries (oldest first while building, reversed at the end).
  for (const day of totals.days) {
    if (!day.active) {
      continue;
    }
    const ts = new Date(`${day.date}T12:00:00`).getTime();
    timeline.push({
      id: `day-${day.date}`,
      at: day.lastActivity ?? ts,
      time: day.lastActivity ? formatTime(day.lastActivity, source.locale) : '—',
      dayKey: day.date,
      dayLabel: formatDateLong(ts, source.locale, new Date(source.now).getFullYear()),
      kind: 'day',
      title: `${formatDuration(day.ms)} across ${day.sessions} session${day.sessions === 1 ? '' : 's'}`,
      detail: daySummaryDetail(day),
      icon: 'calendar',
      durationMs: day.ms,
    });
  }

  // Sessions.
  for (const session of sessions.slice(-TIMELINE_LIMIT)) {
    const dayKey = dateKey(session.startTime);
    const ts = new Date(`${dayKey}T12:00:00`).getTime();
    timeline.push({
      id: `session-${session.id}`,
      at: session.startTime,
      time: formatTime(session.startTime, source.locale),
      dayKey,
      dayLabel: formatDateLong(ts, source.locale, new Date(source.now).getFullYear()),
      kind: 'sessionStart',
      title: `${formatDuration(session.duration)} in ${languageLabel(session.language)}`,
      detail: sessionDetail(source, session.project, session.projectName, sessionTimeRange(session)),
      icon: 'clock',
      durationMs: session.duration,
    });
  }

  // The live session, if one is in progress.
  const live = source.live;
  if (live && live.ms > 0) {
    const language = topKey(live.languages);
    timeline.push({
      id: 'session-live',
      at: live.lastActivity ?? source.now,
      time: formatTime(live.lastActivity ?? source.now, source.locale),
      dayKey: live.date,
      dayLabel: 'In progress',
      kind: 'sessionStart',
      title: `${formatDuration(live.ms)} in the current session`,
      detail: language ? `Mostly ${languageLabel(language)}` : 'Tracking is active',
      icon: 'spark',
      durationMs: live.ms,
    });
  }

  timeline.sort((a, b) => b.at - a.at);

  const busiest = [...days].sort((a, b) => b.ms - a.ms)[0];
  const longest = sessions.reduce((best, session) => (session.duration > (best?.duration ?? 0) ? session : best), sessions[0]);

  return {
    days: days.reverse(),
    timeline: timeline.slice(0, TIMELINE_LIMIT),
    ...(busiest && busiest.ms > 0 ? { busiestDay: busiest } : {}),
    totals: {
      sessions: totals.sessions,
      activeDays: totals.activeDays,
      averageSessionMs: totals.sessions > 0 ? Math.round(totals.ms / totals.sessions) : 0,
      longestSessionMs: longest?.duration ?? 0,
      ...(longest ? { longestSessionDate: dateKey(longest.startTime) } : {}),
    },
  };
}

/** Description shown under a day summary. */
export function daySummaryDetail(day: {
  languages: Record<string, number>;
  filesModified: number;
  firstActivity?: number;
  lastActivity?: number;
}): string {
  const parts: string[] = [];
  const language = Object.entries(day.languages)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id, ms]) => `${languageLabel(id)} ${formatDuration(ms)}`);
  if (language.length > 0) {
    parts.push(language.join(', '));
  }
  if (day.filesModified > 0) {
    parts.push(`${day.filesModified} document${day.filesModified === 1 ? '' : 's'} edited`);
  }
  if (day.firstActivity && day.lastActivity) {
    parts.push(`${formatTime(day.firstActivity)} – ${formatTime(day.lastActivity)}`);
  }
  return parts.join(' · ');
}

/** Description shown under a session entry. */
export function sessionDetail(
  source: StatsSource,
  projectId: string | undefined,
  projectName: string | undefined,
  timeRange: string
): string {
  const parts: string[] = [timeRange];
  const name = projectName ?? (projectId ? source.data.projects[projectId]?.name : undefined);
  if (name) {
    parts.push(name);
  }
  return parts.join(' · ');
}

/** Share of the range that a day represents (used by the activity list). */
export function dayShare(day: DailyTotalView, totalMs: number, locale: string): string {
  return formatPercent(totalMs > 0 ? day.ms / totalMs : 0, 0, locale);
}

/** `Sep 22` label for a day row. */
export function dayLabelFor(source: StatsSource, day: DailyTotalView): string {
  return formatDateLong(new Date(`${day.date}T12:00:00`).getTime(), source.locale);
}

/** Description of a range for the activity page header. */
export function activityRangeLabel(source: StatsSource, range: RangeDescriptor): string {
  return describeRange(range, source.locale);
}

/** Key with the largest value. */
function topKey(values: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestValue = -1;
  for (const [key, value] of Object.entries(values)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}
