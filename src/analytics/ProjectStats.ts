/**
 * Projects page.
 *
 * Projects are identified by a salted hash and labelled with the workspace
 * folder name. No path, no repository URL and no file name is stored, so this
 * page can only ever show "the folder called api" — never where it lives.
 */

import type { ProjectsPagePayload, TrendPoint, TrendView } from '../types/analytics';
import { formatDuration, formatPercent, formatTimestamp } from '../utils/format';
import type { StatsSource } from './Aggregator';
import { projectMeta, rangeTotals } from './Aggregator';
import { buildProjectSlices, buildSessionViews } from './Periods';
import { describeRange, type RangeDescriptor } from './Ranges';

/** Builds the Projects page for a range. */
export function buildProjectsPage(source: StatsSource, range: RangeDescriptor, limit = 12): ProjectsPagePayload {
  const totals = rangeTotals(source, range);
  const sessions = buildSessionViews(source, range);
  const slices = buildProjectSlices(source, totals, limit).map((slice) => {
    const meta = projectMeta(source, slice.id);
    return meta ? { ...slice, name: meta.name, lastActive: meta.lastSeen } : slice;
  });

  return {
    range: describeRange(range, source.locale),
    rangeKey: range.key,
    totalMs: totals.ms,
    slices,
    trend: buildProjectTrend(source, range),
    projects: Object.values(totals.projects).filter((ms) => ms > 0).length,
    sessions: sessions.filter((session) => session.project !== undefined).length,
    note:
      totals.ms > 0
        ? 'Projects are workspace folders, identified by a salted hash. Locations are never stored.'
        : 'No project activity recorded in this range yet.',
  };
}

/** Daily series of the total active time, used as the projects chart. */
export function buildProjectTrend(source: StatsSource, range: RangeDescriptor): TrendView {
  const totals = rangeTotals(source, range);
  const points: TrendPoint[] = totals.days.map((day) => ({
    key: day.date,
    label: day.date.slice(5),
    value: day.ms,
  }));
  return { points, granularity: 'day', max: Math.max(0, ...points.map((point) => point.value)) };
}

/** One line summary of a project slice for lists and tooltips. */
export function describeProjectSlice(
  source: StatsSource,
  slice: { id: string; name: string; ms: number; sessions: number; share: number; lastActive: number }
): string {
  const parts = [
    formatDuration(slice.ms),
    `${formatPercent(slice.share, 0, source.locale)} of the range`,
    `${slice.sessions} session${slice.sessions === 1 ? '' : 's'}`,
  ];
  if (slice.lastActive > 0) {
    parts.push(`last active ${formatTimestamp(slice.lastActive, source.locale)}`);
  }
  return parts.join(' · ');
}

/** Number of projects that have any recorded activity. */
export function trackedProjectCount(source: StatsSource): number {
  return Object.keys(source.data.projects).length;
}

/** The project with the most recorded time in the whole history. */
export function mostActiveProject(source: StatsSource): { id: string; name: string; ms: number } | undefined {
  const totals: Record<string, number> = {};
  for (const day of Object.values(source.data.days)) {
    for (const [id, ms] of Object.entries(day.projects)) {
      totals[id] = (totals[id] ?? 0) + ms;
    }
  }
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
  if (!top) {
    return undefined;
  }
  return { id: top[0], name: projectMeta(source, top[0])?.name ?? 'Unknown project', ms: top[1] };
}
