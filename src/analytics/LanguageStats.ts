/**
 * Languages page.
 *
 * Shows the language mix of a range, the sessions behind each language and a
 * timeline of when each language was used. Language ids come from the active
 * editor; no file name, path or content is ever involved.
 */

import type { LanguagesPagePayload, TrendPoint, TrendView } from '../types/analytics';
import { languageLabel } from '../utils/format';
import { dateKey } from '../utils/time';
import type { StatsSource } from './Aggregator';
import { rangeTotals, sessionsInRange } from './Aggregator';
import { buildLanguageSlices, buildSessionViews, toSessionView } from './Periods';
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

/** Sessions of one language, newest first (used by the languages page). */
export function sessionsForLanguage(
  source: StatsSource,
  range: RangeDescriptor,
  languageId: string,
  limit = 50
): Array<ReturnType<typeof toSessionView>> {
  return sessionsInRange(source, range)
    .filter((session) => session.language === languageId)
    .reverse()
    .slice(0, limit)
    .map((session) => toSessionView(session, range));
}

/** Number of days on which a language was used. */
export function daysUsed(source: StatsSource, range: RangeDescriptor, languageId: string): number {
  return rangeTotals(source, range).days.filter((day) => (day.languages[languageId] ?? 0) > 0).length;
}

/** `First seen <date>` style description for a language. */
export function firstSeenLabel(source: StatsSource, languageId: string): string | undefined {
  const keys = Object.keys(source.data.days).sort();
  for (const key of keys) {
    const day = source.data.days[key];
    if (day && (day.languages[languageId] ?? 0) > 0) {
      return key;
    }
  }
  return undefined;
}

/** Language of the day with the most activity (used by insights). */
export function dominantLanguageOfDay(source: StatsSource, key: string): string | undefined {
  const day = source.data.days[key] ?? (source.live?.date === key ? source.live : undefined);
  if (!day) {
    return undefined;
  }
  const totals = Object.entries(day.languages).sort((a, b) => b[1] - a[1])[0];
  return totals ? totals[0] : undefined;
}

/** Label of the current day, for the "today" hint on the languages page. */
export function todayLanguageHint(source: StatsSource): string {
  const key = dateKey(source.now);
  const language = dominantLanguageOfDay(source, key);
  return language ? `${languageLabel(language)} was most active today.` : 'No language activity recorded today yet.';
}
