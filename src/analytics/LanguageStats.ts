/**
 * Languages page.
 *
 * Shows the language mix of a range, the sessions behind each language and a
 * timeline of when each language was used. Language ids come from the active
 * editor; no file name, path or content is ever involved.
 */

import type { LanguagesPagePayload, TrendPoint, TrendView } from '../types/analytics';
import type { StatsSource } from './Aggregator';
import { rangeTotals, sessionsInRange } from './Aggregator';
import { buildLanguageSlices, buildSessionViews } from './Periods';
import { describeRange, type RangeDescriptor } from './Ranges';

/** Builds the Languages page for a range. */
export function buildLanguagesPage(source: StatsSource, range: RangeDescriptor, limit = 12): LanguagesPagePayload {
  const totals = rangeTotals(source, range);
  const sessions = sessionsInRange(source, range);
  const sessionViews = buildSessionViews(source, range);
  const slices = buildLanguageSlices(totals, limit, sessionViews).map((slice) => {
    const last = sessions
      .filter((session) => session.language === slice.id)
      .reduce((max, session) => Math.max(max, session.endTime), 0);
    return last > 0 ? { ...slice, lastActive: last } : slice;
  });

  const totalMs = totals.ms;
  return {
    range: describeRange(range, source.locale),
    rangeKey: range.key,
    totalMs,
    slices,
    trend: buildLanguageTrend(source, range),
    languages: Object.values(totals.languages).filter((ms) => ms > 0).length,
    filesTouched: totals.filesModified,
    note:
      totalMs > 0
        ? 'A language is attributed the time that was active while its editor was in the foreground.'
        : 'No language activity recorded in this range yet.',
  };
}

/** Daily series of the total active time (the language chart's backdrop). */
export function buildLanguageTrend(source: StatsSource, range: RangeDescriptor): TrendView {
  const totals = rangeTotals(source, range);
  const points: TrendPoint[] = totals.days.map((day) => ({
    key: day.date,
    label: day.date.slice(5),
    value: day.ms,
  }));
  return { points, granularity: 'day', max: Math.max(0, ...points.map((point) => point.value)) };
}