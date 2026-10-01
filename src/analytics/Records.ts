/**
 * Personal records.
 *
 * Records are descriptive extremes of the recorded history ("longest session",
 * "busiest day"). They are worded as facts, never as achievements to beat —
 * the dashboard does not gamify or judge the user.
 */

import type { RecordView } from '../types/analytics';
import type { DateKey } from '../types/statistics';
import { formatDateLong, formatDuration, formatHour, languageLabel } from '../utils/format';
import type { RangeTotals, StatsSource } from './Aggregator';
import { peakHour, projectMeta, topKey } from './Aggregator';
import type { RangeDescriptor } from './Ranges';

/** Records computed over a range, ordered by relevance. */
export function buildRecords(source: StatsSource, range: RangeDescriptor, totals: RangeTotals): RecordView[] {
  const records: RecordView[] = [];

  // Longest session.
  const longest = longestSessionOf(source, range);
  if (longest) {
    records.push({
      id: 'longest-session',
      label: 'Longest session',
      value: formatDuration(longest.duration),
      dateKey: longest.dayKey,
      detail: `${formatDateLong(longest.startTime, source.locale)} · ${languageLabel(longest.language)}`,
    });
  }

  // Busiest day.
  const busiest = busiestDayOf(totals);
  if (busiest) {
    records.push({
      id: 'busiest-day',
      label: 'Busiest day',
      value: formatDuration(busiest.ms),
      dateKey: busiest.date,
      detail: `${busiest.sessions} session${busiest.sessions === 1 ? '' : 's'} · ${formatDateLong(
        parseDay(busiest.date),
        source.locale
      )}`,
    });
  }

  // Most sessions in one day.
  const mostSessions = [...totals.days]
    .filter((day) => day.active)
    .sort((a, b) => b.sessions - a.sessions)[0];
  if (mostSessions && mostSessions.sessions > 0) {
    records.push({
      id: 'most-sessions',
      label: 'Most sessions in a day',
      value: `${mostSessions.sessions}`,
      dateKey: mostSessions.date,
      detail: formatDateLong(parseDay(mostSessions.date), source.locale),
    });
  }

  // Most active language.
  const language = topKey(totals.languages);
  if (language) {
    records.push({
      id: 'top-language',
      label: 'Most active language',
      value: languageLabel(language),
      detail: formatDuration(totals.languages[language] ?? 0),
    });
  }

  // Most active project.
  const project = topKey(totals.projects);
  if (project) {
    records.push({
      id: 'top-project',
      label: 'Most active project',
      value: projectMeta(source, project)?.name ?? 'Unknown project',
      detail: formatDuration(totals.projects[project] ?? 0),
    });
  }

  // Most active hour.
  const hour = peakHour(totals);
  if (hour !== undefined) {
    records.push({
      id: 'peak-hour',
      label: 'Most active hour',
      value: formatHour(hour, source.locale),
      detail: formatDuration(totals.hourly[hour] ?? 0),
    });
  }

  // Most active weekday.
  const weekdayIndex = busiestWeekday(totals);
  if (weekdayIndex !== undefined) {
    records.push({
      id: 'top-weekday',
      label: 'Most active day of the week',
      value: formatWeekday(weekdayIndex, source.locale),
      detail: formatDuration(totals.weekdays[weekdayIndex] ?? 0),
    });
  }

  // Average per active day.
  if (totals.activeDays > 0) {
    records.push({
      id: 'average-day',
      label: 'Average active day',
      value: formatDuration(totals.averagePerActiveDayMs),
      detail: `${totals.activeDays} active day${totals.activeDays === 1 ? '' : 's'}`,
    });
  }

  // Longest streak is added by the insights page, which owns the streak data.
  return records;
}

/** Longest session inside a range, with the day it started. */
export function longestSessionOf(
  source: StatsSource,
  range: RangeDescriptor
): { duration: number; startTime: number; endTime: number; dayKey: DateKey; language?: string } | undefined {
  let best: { duration: number; startTime: number; endTime: number; dayKey: DateKey; language?: string } | undefined;
  for (const session of source.data.sessions) {
    if (session.startTime < range.start || session.startTime >= range.end) {
      continue;
    }
    if (!best || session.duration > best.duration) {
      best = {
        duration: session.duration,
        startTime: session.startTime,
        endTime: session.endTime,
        dayKey: dateKeyOf(session.startTime),
        ...(session.language ? { language: session.language } : {}),
      };
    }
  }
  // The session in progress participates in its own record only when it is
  // already longer than the stored best, which is what a user would expect.
  const live = source.live;
  if (live && live.ms > 0) {
    if (!best || live.ms > best.duration) {
      best = {
        duration: live.ms,
        startTime: live.firstActivity ?? source.now - live.ms,
        endTime: live.lastActivity ?? source.now,
        dayKey: live.date,
        ...(topKey(live.languages) ? { language: topKey(live.languages) } : {}),
      };
    }
  }
  return best;
}

/** Day with the most active time inside a range. */
export function busiestDayOf(totals: RangeTotals): { date: DateKey; ms: number; sessions: number } | undefined {
  let best: { date: DateKey; ms: number; sessions: number } | undefined;
  for (const day of totals.days) {
    if (!day.active) {
      continue;
    }
    if (!best || day.ms > best.ms) {
      best = { date: day.date, ms: day.ms, sessions: day.sessions };
    }
  }
  return best;
}

/** Weekday index with the most active time. */
export function busiestWeekday(totals: RangeTotals): number | undefined {
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

/** Localized weekday name, from an index where 0 = Sunday. */
export function formatWeekday(weekday: number, locale: string): string {
  const date = new Date(2026, 0, 4 + weekday, 12, 0, 0, 0);
  return new Intl.DateTimeFormat(locale.length > 0 ? locale : 'en', { weekday: 'long' }).format(date);
}

/** Local date key of a timestamp. */
function dateKeyOf(ts: number): DateKey {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local noon timestamp of a day key (avoids DST edge cases). */
function parseDay(key: DateKey): number {
  return new Date(`${key}T12:00:00`).getTime();
}