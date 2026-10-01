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