/**
 * Sessions page.
 *
 * Sessions are the rawest information Dev Wrapped keeps: a start, an end, the
 * active duration, the dominant language and the project. They are filtered in
 * the webview (the filters are answered client side) so typing in a filter
 * never round-trips to the extension host.
 */

import type { SessionsPagePayload, SessionView } from '../types/analytics';
import { languageLabel } from '../utils/format';
import type { StatsSource } from './Aggregator';
import { buildSessionViews } from './Periods';
import { describeRange, type RangeDescriptor } from './Ranges';

/** Builds the Sessions page for a range. */
export function buildSessionsPage(source: StatsSource, range: RangeDescriptor, limit = 300): SessionsPagePayload {
  const views = buildSessionViews(source, range, limit);
  const stored = views.filter((view) => !view.live);
  const longest = stored.reduce<SessionView | undefined>(
    (best, view) => (!best || view.durationMs > best.durationMs ? view : best),
    undefined
  );

  return {
    range: describeRange(range, source.locale),
    rangeKey: range.key,
    total: stored.length,
    views,
    averageMs: stored.length > 0 ? Math.round(stored.reduce((sum, view) => sum + view.durationMs, 0) / stored.length) : 0,
    longestMs: longest?.durationMs ?? 0,
    ...(longest ? { longestId: longest.id } : {}),
    filters: {
      projects: collectProjects(source, views),
      languages: collectLanguages(views),
      known: stored.length > 0,
    },
  };
}

/** Projects that appear in the session list (for the filter dropdown). */
export function collectProjects(source: StatsSource, views: SessionView[]): Array<{ id: string; name: string }> {
  const ids = new Set<string>();
  for (const view of views) {
    if (view.project) {
      ids.add(view.project);
    }
  }
  return [...ids]
    .map((id) => ({ id, name: source.data.projects[id]?.name ?? source.live?.projectNames?.[id] ?? 'Unknown project' }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 100);
}

/** Languages that appear in the session list (for the filter dropdown). */
export function collectLanguages(views: SessionView[]): Array<{ id: string; label: string }> {
  const ids = new Set<string>();
  for (const view of views) {
    if (view.language) {
      ids.add(view.language);
    }
  }
  return [...ids]
    .map((id) => ({ id, label: languageLabel(id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Total active time of a session list. */
export function totalSessionTime(views: SessionView[]): number {
  return views.reduce((sum, view) => sum + view.durationMs, 0);
}

/** Session duration histogram (used by the sessions page summary). */
export function sessionLengthBuckets(views: SessionView[]): Array<{ label: string; count: number }> {
  const buckets = [
    { label: 'under 15 minutes', count: 0 },
    { label: '15 to 30 minutes', count: 0 },
    { label: '30 to 60 minutes', count: 0 },
    { label: '1 to 2 hours', count: 0 },
    { label: 'over 2 hours', count: 0 },
  ];
  for (const view of views) {
    if (view.live) {
      continue;
    }
    if (view.durationMs < 15 * 60_000) {
      buckets[0]!.count += 1;
    } else if (view.durationMs < 30 * 60_000) {
      buckets[1]!.count += 1;
    } else if (view.durationMs < 60 * 60_000) {
      buckets[2]!.count += 1;
    } else if (view.durationMs < 120 * 60_000) {
      buckets[3]!.count += 1;
    } else {
      buckets[4]!.count += 1;
    }
  }
  return buckets;
}
