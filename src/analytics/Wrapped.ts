/**
 * The yearly retrospective ("Wrapped").
 *
 * A deck of slides describing the year in numbers: total time, months,
 * languages, projects, sessions, rhythm and streaks. Every sentence is
 * descriptive — the retrospective reports what happened, it does not rank the
 * user, compare them with other people or call anything productive.
 */

import type { WrappedPayload, WrappedSlide } from '../types/analytics';
import { formatDateLong, formatDuration, formatHours, formatPercent, languageLabel } from '../utils/format';
import { hourOfDay } from '../utils/time';
import type { RangeTotals, StatsSource } from './Aggregator';
import { projectMeta, rangeTotals } from './Aggregator';
import { busiestMonth } from './YearlyStats';
import { monthlyTotals } from './MonthlyStats';
import { buildWeekdayBuckets } from './Periods';
import { previousRange, yearRange, type RangeContext, type RangeDescriptor } from './Ranges';
import type { StreakResult } from './Streaks';
import { computeStreaks } from './Streaks';

export interface WrappedOptions {
  streaks?: StreakResult;
}

/** Builds the retrospective of a year. */
export function buildWrapped(source: StatsSource, year: number, options: WrappedOptions = {}): WrappedPayload {
  const context: RangeContext = { now: source.now, locale: source.locale, weekStartsOn: source.weekStartsOn };
  const range = yearRange(context, year);
  const totals = rangeTotals(source, range);
  if (totals.ms <= 0) {
    return {
      year,
      slides: [],
      available: false,
      message: `No activity recorded in ${year} yet. Once you start coding, your retrospective appears here.`,
    };
  }

  const months = monthlyTotals(source, year);
  const streaks = options.streaks ?? computeStreaks(source, { windowDays: range.days.length + 1 });
  const previous = previousRange(context, range, source.data);
  const previousTotals = previous ? rangeTotals(source, previous) : undefined;

  const slides: WrappedSlide[] = [
    buildIntroSlide(source, year, range, totals),
    buildVolumeSlide(source, year, totals, months),
    buildLanguageSlide(year, totals, source.locale),
    buildProjectSlide(source, year, totals),
    buildSessionSlide(source, year, totals, range),
    buildRhythmSlide(source, totals),
    buildStreakSlide(year, totals, streaks),
    buildOutroSlide(year, totals, previousTotals, previous),
  ];

  return { year, slides, available: true };
}

/* --------------------------------- slides --------------------------------- */

function buildIntroSlide(source: StatsSource, year: number, range: RangeDescriptor, totals: RangeTotals): WrappedSlide {
  const activeDays = totals.activeDays;
  const days = range.days.length;
  return {
    id: 'intro',
    kind: 'intro',
    icon: 'spark',
    kicker: `Your ${year}`,
    title: `${year} in code`,
    value: formatHours(totals.ms),
    unit: 'hours of active coding time',
    caption: `${activeDays} active day${activeDays === 1 ? '' : 's'} out of ${days} — ${formatPercent(
      days > 0 ? activeDays / days : 0,
      0,
      source.locale
    )} of the year. Everything below comes from local statistics only.`,
    bars: [],
    footnote: 'Only time with editor activity is counted; idle time is excluded.',
  };
}

function buildVolumeSlide(
  source: StatsSource,
  year: number,
  totals: RangeTotals,
  months: Array<{ label: string; ms: number; sessions: number }>
): WrappedSlide {
  void source;
  const busiest = busiestMonth(months.map((month, index) => ({
    key: `${year}-${String(index + 1).padStart(2, '0')}`,
    label: month.label,
    ms: month.ms,
    sessions: month.sessions,
    share: 0,
    activeDays: 0,
  })));
  const top = [...months].sort((a, b) => b.ms - a.ms).slice(0, 6);
  const max = top[0]?.ms ?? 0;
  return {
    id: 'volume',
    kind: 'volume',
    icon: 'calendar',
    kicker: 'The hours',
    title: `${formatDuration(totals.ms)} of active coding`,
    value: formatHours(totals.ms),
    unit: 'hours',
    caption: busiest
      ? `${busiest.label} was the busiest month with ${formatDuration(busiest.ms)} across ${busiest.sessions} sessions.`
      : 'No single month stands out yet.',
    bars: top.map((month) => ({
      label: month.label,
      detail: formatDuration(month.ms),
      share: max > 0 ? month.ms / max : 0,
      leader: month.ms === max && max > 0,
    })),
    footnote: `${totals.sessions} sessions · ${formatDuration(Math.round(totals.ms / Math.max(1, totals.sessions)))} on average`,
  };
}

function buildLanguageSlide(year: number, totals: RangeTotals, locale: string): WrappedSlide {
  const entries = Object.entries(totals.languages)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 6);
  const max = top[0]?.[1] ?? 0;
  const leader = top[0];
  return {
    id: 'languages',
    kind: 'languages',
    icon: 'code',
    kicker: 'The languages',
    title: leader ? `${languageLabel(leader[0])} took the lead in ${year}` : `Languages in ${year}`,
    value: leader ? languageLabel(leader[0]) : '—',
    unit: leader ? `${formatPercent(leader[1] / Math.max(1, totals.ms), 0, locale)} of the time` : '',
    caption: leader
      ? `${formatDuration(leader[1])} were spent in ${languageLabel(leader[0])}, out of ${entries.length} language${
          entries.length === 1 ? '' : 's'
        } used.`
      : 'No language activity recorded.',
    bars: top.map(([id, ms]) => ({
      label: languageLabel(id),
      detail: formatDuration(ms),
      share: max > 0 ? ms / max : 0,
      leader: ms === max && max > 0,
    })),
    footnote: 'Languages come from the active editor; file names and contents are never read.',
  };
}

function buildProjectSlide(source: StatsSource, year: number, totals: RangeTotals): WrappedSlide {
  const entries = Object.entries(totals.projects)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 6);
  const max = top[0]?.[1] ?? 0;
  const leader = top[0];
  const leaderName = leader ? projectMeta(source, leader[0])?.name ?? 'Unknown project' : undefined;
  return {
    id: 'projects',
    kind: 'projects',
    icon: 'folder',
    kicker: 'The projects',
    title: leaderName ? `${leaderName} had the most active time` : `Projects in ${year}`,
    value: leaderName ?? '—',
    unit: leader ? formatDuration(leader[1]) : '',
    caption:
      entries.length > 0
        ? `${entries.length} workspace folder${entries.length === 1 ? '' : 's'} recorded time this year.`
        : 'No project activity recorded.',
    bars: top.map(([id, ms]) => ({
      label: projectMeta(source, id)?.name ?? 'Unknown project',
      detail: formatDuration(ms),
      share: max > 0 ? ms / max : 0,
      leader: ms === max && max > 0,
    })),
    footnote: 'Projects are identified by a salted hash; folder locations are never stored.',
  };
}

function buildSessionSlide(source: StatsSource, year: number, totals: RangeTotals, range: RangeDescriptor): WrappedSlide {
  const sessions = source.data.sessions.filter(
    (session) => session.startTime >= range.start && session.startTime < range.end
  );
  const longest = sessions.reduce((best, session) => (session.duration > (best?.duration ?? 0) ? session : best), sessions[0]);
  const buckets = [
    { label: 'under 30 minutes', min: 0, max: 30 * 60_000 },
    { label: '30 to 60 minutes', min: 30 * 60_000, max: 60 * 60_000 },
    { label: '1 to 2 hours', min: 60 * 60_000, max: 120 * 60_000 },
    { label: 'over 2 hours', min: 120 * 60_000, max: Number.POSITIVE_INFINITY },
  ].map((bucket) => ({
    label: bucket.label,
    count: sessions.filter((session) => session.duration >= bucket.min && session.duration < bucket.max).length,
  }));
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));

  return {
    id: 'sessions',
    kind: 'sessions',
    icon: 'clock',
    kicker: 'The sessions',
    title: `${totals.sessions} session${totals.sessions === 1 ? '' : 's'} in ${year}`,
    value: `${totals.sessions}`,
    unit: 'sessions',
    caption: longest
      ? `The longest one lasted ${formatDuration(longest.duration)} and started ${formatDateLong(longest.startTime, source.locale)}.`
      : 'No sessions recorded.',
    bars: buckets.map((bucket) => ({
      label: bucket.label,
      detail: `${bucket.count}`,
      share: bucket.count / maxCount,
      leader: bucket.count === maxCount && bucket.count > 0,
    })),
    footnote: 'A session ends after the configured inactivity timeout.',
  };
}

function buildRhythmSlide(source: StatsSource, totals: RangeTotals): WrappedSlide {
  const busiestHour = totals.hourly.reduce(
    (best, ms, hour) => (ms > best.ms ? { ms, hour } : best),
    { ms: 0, hour: -1 }
  );
  const weekdays = buildWeekdayBuckets(source, totals);
  const topWeekday = weekdays.reduce(
    (best, day) => (day.ms > best.ms ? day : best),
    weekdays[0] ?? { weekday: -1, label: '—', ms: 0, share: 0 }
  );
  const hourLabel = busiestHour.hour >= 0 ? `${String(busiestHour.hour).padStart(2, '0')}:00` : '—';
  return {
    id: 'rhythm',
    kind: 'rhythm',
    icon: 'clock',
    kicker: 'The rhythm',
    title: busiestHour.hour >= 0 ? `${hourLabel} was your most active hour` : 'Your weekly rhythm',
    value: hourLabel,
    unit: 'most active hour',
    caption:
      busiestHour.hour >= 0
        ? `${formatDuration(busiestHour.ms)} were recorded in that hour, and ${topWeekday.label ?? '—'} saw the most activity of the week.`
        : 'Not enough data to describe a rhythm yet.',
    bars: weekdays.map((day) => ({
      label: day.label,
      detail: formatDuration(day.ms),
      share: day.share,
      leader: day.weekday === (topWeekday.weekday ?? -1),
    })),
    footnote: 'Hours are local time, so travel and daylight saving are respected.',
  };
}

function buildStreakSlide(year: number, totals: RangeTotals, streaks: StreakResult): WrappedSlide {
  const qualifyingDays = totals.qualifyingDays;
  return {
    id: 'streak',
    kind: 'streak',
    icon: 'flame',
    kicker: 'The streaks',
    title:
      streaks.longest > 1
        ? `${streaks.longest} days in a row above ${streaks.minimumActiveTimeMinutes} minutes`
        : 'Streaks build with consistency',
    value: `${streaks.longest}`,
    unit: streaks.longest === 1 ? 'day in a row' : 'days in a row',
    caption: `${qualifyingDays} day${qualifyingDays === 1 ? '' : 's'} in ${year} reached the minimum active time of ${
      streaks.minimumActiveTimeMinutes
    } minutes.`,
    bars: [],
    footnote: 'The minimum active time is configurable (10, 30 or 60 minutes).',
  };
}

function buildOutroSlide(
  year: number,
  totals: RangeTotals,
  previous: RangeTotals | undefined,
  previousRangeDescriptor: RangeDescriptor | undefined
): WrappedSlide {
  const comparisonText =
    previous && previous.ms > 0
      ? `${totals.ms >= previous.ms ? 'More' : 'Less'} active time than ${previousRangeDescriptor?.year ?? year - 1} (${formatDuration(
          Math.abs(totals.ms - previous.ms)
        )} ${totals.ms >= previous.ms ? 'more' : 'less'}).`
      : 'No previous year to compare with yet.';
  return {
    id: 'outro',
    kind: 'outro',
    icon: 'spark',
    kicker: 'The summary',
    title: `That was ${year} in code`,
    value: formatDuration(totals.ms),
    unit: 'of active coding',
    caption: `${totals.filesModified} documents edited · ${totals.activeDays} active days · ${comparisonText}`,
    bars: [],
    footnote:
      'Every number lives in one local file. Export it, keep it, or reset it — you are in control of your data.',
  };
}

/** Hour of day of a timestamp (re-export used by tests). */
export { hourOfDay };
