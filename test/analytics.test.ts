/**
 * Aggregation, ranges, streaks, records and period pages.
 *
 * These tests exercise the analytics layer with a hand built database, so the
 * expected numbers are obvious and a regression is easy to spot.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayTotals, rangeTotals, sessionsInRange, topLanguages, type StatsSource } from '../src/analytics/Aggregator';
import { buildDailyStats } from '../src/analytics/DailyStats';
import { buildMonthlyStats } from '../src/analytics/MonthlyStats';
import { buildWeeklyStats } from '../src/analytics/WeeklyStats';
import { buildYearlyStats } from '../src/analytics/YearlyStats';
import { buildHeatmap, buildMonthCalendar, levelFor } from '../src/analytics/CalendarStats';
import { buildLanguagesPage } from '../src/analytics/LanguageStats';
import { buildProjectsPage } from '../src/analytics/ProjectStats';
import { buildSessionsPage } from '../src/analytics/SessionStats';
import { buildActivityPage } from '../src/analytics/Timeline';
import { buildInsightsPayload } from '../src/analytics/Insights';
import { buildRecords } from '../src/analytics/Records';
import { compareTotals } from '../src/analytics/Comparison';
import { allRange, availableYears, dayRange, monthRange, previousRange, weekRange, yearRange } from '../src/analytics/Ranges';
import { computeStreaks } from '../src/analytics/Streaks';
import { emptyLiveContribution } from '../src/types/delta';
import { DB_SCHEMA_VERSION, createDayStats, type DatabaseData, type DayStats } from '../src/types/statistics';
import { MS_PER_HOUR, MS_PER_MINUTE, dateKey } from '../src/utils/time';

const NOW = new Date(2026, 9, 1, 18, 30, 0).getTime(); // Thursday 2026-10-01, 18:30 local

function day(key: string, activeMs: number, extra: Partial<DayStats> = {}): DayStats {
  const record = createDayStats(key);
  record.activeTime = activeMs;
  record.sessions = extra.sessions ?? 1;
  record.longestSession = extra.longestSession ?? activeMs;
  record.hourly[9] = Math.round(activeMs / 2);
  record.hourly[14] = activeMs - (record.hourly[9] ?? 0);
  record.languages = extra.languages ?? { typescript: activeMs };
  record.projects = extra.projects ?? { aaaa: activeMs };
  return { ...record, ...extra };
}

function database(days: DayStats[], sessions: DatabaseData['sessions'] = []): DatabaseData {
  const map: Record<string, DayStats> = {};
  for (const entry of days) {
    map[entry.date] = entry;
  }
  return {
    meta: {
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: 0,
      updatedAt: NOW,
      retentionDays: 365,
      privacySalt: 'salt',
      onboarded: true,
    },
    days: map,
    sessions,
    projects: { aaaa: { id: 'aaaa', name: 'api', firstSeen: 0, lastSeen: NOW } },
  };
}

function source(data: DatabaseData, live?: ReturnType<typeof emptyLiveContribution>): StatsSource {
  const base: StatsSource = {
    data,
    now: NOW,
    locale: 'en',
    weekStartsOn: 1,
    minimumActiveTimeMs: 30 * MS_PER_MINUTE,
    ...(live ? { live } : {}),
  };
  return base;
}

test('dayTotals merges the live contribution of the current day', () => {
  const live = emptyLiveContribution('2026-10-01');
  live.ms = MS_PER_HOUR;
  live.languages = { python: MS_PER_HOUR };
  live.hourly[17] = MS_PER_HOUR;
  live.firstActivity = NOW - MS_PER_HOUR;
  live.lastActivity = NOW;

  const stats = source(database([day('2026-10-01', MS_PER_HOUR)]), live);
  const totals = dayTotals(stats, '2026-10-01');
  assert.equal(totals.ms, 2 * MS_PER_HOUR);
  assert.equal(totals.languages.typescript, MS_PER_HOUR);
  assert.equal(totals.languages.python, MS_PER_HOUR);
  assert.equal(totals.active, true);
});

test('rangeTotals aggregates counters, hours and weekdays', () => {
  const stats = source(
    database([day('2026-09-28', MS_PER_HOUR), day('2026-09-30', 2 * MS_PER_HOUR), day('2026-10-01', MS_PER_HOUR)])
  );
  const range = weekRange({ now: NOW, locale: 'en', weekStartsOn: 1 });
  const totals = rangeTotals(stats, range);

  assert.equal(totals.ms, 4 * MS_PER_HOUR);
  assert.equal(totals.sessions, 3);
  assert.equal(totals.activeDays, 3);
  // The current week stops at "now" (Thursday), so it covers Monday to Thursday.
  assert.equal(totals.days.length, 4);
  assert.equal(totals.hourly.length, 24);
  // Monday contributes one hour, Wednesday two, Thursday one.
  assert.equal(totals.weekdays[1], MS_PER_HOUR);
  assert.equal(totals.weekdays[3], 2 * MS_PER_HOUR);
  assert.equal(totals.averagePerActiveDayMs, Math.round((4 * MS_PER_HOUR) / 3));
});

test('ranges stop at now and expose the previous period', () => {
  const context = { now: NOW, locale: 'en', weekStartsOn: 1 };
  const today = dayRange(context);
  assert.equal(today.key, '2026-10-01');
  assert.equal(today.end, NOW);

  const yesterday = previousRange(context, today, database([]));
  assert.equal(yesterday?.key, '2026-09-30');

  const month = monthRange(context);
  assert.equal(month.key, '2026-10');
  assert.equal(month.days.length, 1);

  const year = yearRange(context, 2026);
  assert.equal(year.start, new Date(2026, 0, 1).getTime());
  assert.equal(year.end, NOW);

  const all = allRange(context, database([day('2026-01-05', 1000)]));
  assert.equal(all.start, new Date(2026, 0, 5).getTime());
  assert.deepEqual(availableYears(database([day('2025-05-05', 1)]), NOW).slice(0, 2), [2026, 2025]);
});

test('sessions are filtered by range and keep their order', () => {
  const sessions = [
    { id: 'a', startTime: new Date(2026, 8, 20, 9).getTime(), endTime: new Date(2026, 8, 20, 10).getTime(), duration: MS_PER_HOUR },
    { id: 'b', startTime: new Date(2026, 9, 1, 8).getTime(), endTime: new Date(2026, 9, 1, 9).getTime(), duration: MS_PER_HOUR },
  ];
  const stats = source(database([day('2026-10-01', MS_PER_HOUR)], sessions));
  const inWeek = sessionsInRange(stats, weekRange({ now: NOW, locale: 'en', weekStartsOn: 1 }));
  assert.deepEqual(inWeek.map((session) => session.id), ['b']);
  assert.deepEqual(inWeek.map((session) => session.id), ['b']);
});

test('language and project slices are ranked and limited', () => {
  const stats = source(
    database([
      day('2026-10-01', 3 * MS_PER_HOUR, {
        languages: { typescript: 2 * MS_PER_HOUR, python: MS_PER_HOUR },
        projects: { aaaa: 3 * MS_PER_HOUR },
      }),
    ])
  );
  const totals = rangeTotals(stats, dayRange({ now: NOW, locale: 'en', weekStartsOn: 1 }));
  const slices = topLanguages(totals, 1);
  assert.equal(slices.length, 1);
  assert.equal(slices[0]?.id, 'typescript');
  assert.ok(Math.abs((slices[0]?.share ?? 0) - 2 / 3) < 1e-9);

  const projects = buildProjectsPage(stats, dayRange({ now: NOW, locale: 'en', weekStartsOn: 1 }));
  assert.equal(projects.projects, 1);
  assert.equal(projects.slices[0]?.name, 'api');
});

test('streaks count qualifying days and tolerate a pending today', () => {
  const days = [
    day('2026-09-27', 40 * MS_PER_MINUTE),
    day('2026-09-28', 45 * MS_PER_MINUTE),
    day('2026-09-29', 50 * MS_PER_MINUTE),
    day('2026-09-30', 5 * MS_PER_MINUTE), // below the minimum
    day('2026-10-01', 2 * MS_PER_MINUTE), // today, still early
  ];
  const streaks = computeStreaks(source(database(days)));
  // Yesterday (2026-09-30) is below the minimum, so the current streak is 0;
  // the run from the 27th to the 29th is still the longest one.
  assert.equal(streaks.current, 0);
  assert.equal(streaks.longest, 3);
  assert.equal(streaks.longestStart, '2026-09-27');
  assert.equal(streaks.longestEnd, '2026-09-29');
  assert.equal(streaks.minimumActiveTimeMinutes, 30);

  // When yesterday qualifies, the streak survives a slow start to today.
  const continuing = computeStreaks(
    source(database([day('2026-09-29', 45 * MS_PER_MINUTE), day('2026-09-30', 40 * MS_PER_MINUTE), day('2026-10-01', 2 * MS_PER_MINUTE)]))
  );
  assert.equal(continuing.current, 2);
  assert.equal(continuing.currentStart, '2026-09-29');
});

test('period pages expose cards, trend, distributions, slices and comparison', () => {
  const stats = source(database([day('2026-09-30', 2 * MS_PER_HOUR), day('2026-10-01', MS_PER_HOUR)]));
  const streaks = computeStreaks(stats);
  const today = buildDailyStats(stats, { streaks });
  assert.equal(today.id, 'today');
  assert.equal(today.totalMs, MS_PER_HOUR);
  assert.equal(today.trend.granularity, 'hour');
  assert.equal(today.hourly.length, 24);
  assert.equal(today.weekdays.length, 7);
  assert.ok(today.cards.some((card) => card.id === 'active-time'));
  assert.equal(today.comparison.available, true);
  assert.equal(today.comparison.previousMs, 2 * MS_PER_HOUR);

  const week = buildWeeklyStats(stats, { streaks });
  assert.equal(week.id, 'week');
  assert.equal(week.trend.granularity, 'day');
  assert.equal(week.totalMs, 3 * MS_PER_HOUR);

  const month = buildMonthlyStats(stats, { streaks });
  assert.equal(month.id, 'month');
  assert.equal(month.calendar.key, '2026-10');
  assert.ok(month.calendar.weeks.length >= 4);
});

test('comparisons report unavailability instead of inventing a baseline', () => {
  const stats = source(database([day('2026-10-01', MS_PER_HOUR)]));
  const current = rangeTotals(stats, dayRange({ now: NOW, locale: 'en', weekStartsOn: 1 }));
  const view = compareTotals(current, undefined, {
    id: 'x',
    title: 'Compared with yesterday',
    currentLabel: 'Today',
    previousLabel: 'Yesterday',
  });
  assert.equal(view.available, false);
  assert.equal(view.deltaRatio, null);
  assert.ok((view.message ?? '').length > 0);
});

test('the year page assembles every section and the retrospective flag', () => {
  const stats = source(database([day('2026-10-01', 2 * MS_PER_HOUR), day('2026-03-04', MS_PER_HOUR)]));
  const year = buildYearlyStats(stats, 2026, { streaks: computeStreaks(stats) });
  assert.equal(year.year, 2026);
  assert.equal(year.totalMs, 3 * MS_PER_HOUR);
  assert.equal(year.months.length, 12);
  assert.equal(year.trend.points.length, 12);
  assert.equal(year.heatmap.weeks.length >= 39, true);
  assert.equal(year.wrappedAvailable, true);
  assert.ok(year.records.length > 0);
  assert.ok(year.cards.some((card) => card.id === 'busiest-month'));
});

test('heat map levels are relative to the busiest day', () => {
  assert.equal(levelFor(0, 1000), 0);
  assert.equal(levelFor(10, 1000), 1);
  assert.equal(levelFor(300, 1000), 2);
  assert.equal(levelFor(500, 1000), 3);
  assert.equal(levelFor(1000, 1000), 4);

  const stats = source(database([day('2026-10-01', 10 * MS_PER_HOUR), day('2026-10-02', MS_PER_HOUR)]));
  const heatmap = buildHeatmap(stats, ['2026-10-01', '2026-10-02'], 1);
  const cells = heatmap.weeks.flatMap((week) => week.days).filter((entry) => entry.inRange);
  assert.equal(cells.length, 2);
  assert.equal(cells[0]?.level, 4);
  assert.equal(heatmap.activeDays, 2);
});

test('month calendars pad to full weeks and mark today', () => {
  const stats = source(database([day('2026-10-01', MS_PER_HOUR)]));
  const calendar = buildMonthCalendar(stats, 2026, 9);
  assert.equal(calendar.weeks.length >= 4, true);
  const cells = calendar.weeks.flatMap((week) => week.days);
  assert.equal(cells.length % 7, 0);
  const today = cells.find((cell) => cell.date === '2026-10-01');
  assert.equal(today?.isToday, true);
  assert.equal(today?.countsForStreak, true); // one hour is above the 30 minute minimum
});

test('languages, projects, sessions and activity pages are consistent', () => {
  const sessions = [
    { id: 's1', startTime: new Date(2026, 9, 1, 9).getTime(), endTime: new Date(2026, 9, 1, 10, 30).getTime(), duration: 90 * MS_PER_MINUTE, language: 'typescript', project: 'aaaa', projectName: 'api' },
    { id: 's2', startTime: new Date(2026, 9, 1, 14).getTime(), endTime: new Date(2026, 9, 1, 15).getTime(), duration: 60 * MS_PER_MINUTE, language: 'python', project: 'aaaa', projectName: 'api' },
  ];
  const stats = source(
    database(
      [
        day('2026-10-01', 150 * MS_PER_MINUTE, {
          sessions: 2,
          languages: { typescript: 90 * MS_PER_MINUTE, python: 60 * MS_PER_MINUTE },
          projects: { aaaa: 150 * MS_PER_MINUTE },
          filesModified: 7,
        }),
      ],
      sessions
    )
  );
  const range = dayRange({ now: NOW, locale: 'en', weekStartsOn: 1 });

  const languages = buildLanguagesPage(stats, range);
  assert.equal(languages.languages, 2);
  assert.equal(languages.filesTouched, 7);
  assert.equal(languages.slices[0]?.sessions, 1);

  const projectsPage = buildProjectsPage(stats, range);
  assert.equal(projectsPage.projects, 1);
  assert.equal(projectsPage.slices[0]?.sessions, 1);

  const sessionsPage = buildSessionsPage(stats, range);
  assert.equal(sessionsPage.total, 2);
  assert.equal(sessionsPage.averageMs, 75 * MS_PER_MINUTE);
  assert.equal(sessionsPage.filters.languages.length, 2);

  const activity = buildActivityPage(stats, range);
  assert.equal(activity.totals.sessions, 2);
  assert.equal(activity.totals.longestSessionMs, 90 * MS_PER_MINUTE);
  assert.ok(activity.timeline.length >= 3);
  assert.ok(activity.days.length >= 1);
});

test('insights and records are descriptive and never empty when there is data', () => {
  const stats = source(
    database([
      day('2026-09-29', 2 * MS_PER_HOUR, { filesModified: 3 }),
      day('2026-09-30', 90 * MS_PER_MINUTE),
      day('2026-10-01', MS_PER_HOUR),
    ])
  );
  const range = weekRange({ now: NOW, locale: 'en', weekStartsOn: 1 });
  const totals = rangeTotals(stats, range);
  const streaks = computeStreaks(stats);
  const records = buildRecords(stats, range, totals);
  assert.ok(records.some((record) => record.id === 'busiest-day'));
  assert.ok(records.some((record) => record.id === 'top-language'));

  const insightsPayload = buildInsightsPayload(stats, range, totals, streaks, records, {
    languages: [],
    projects: [],
  });
  assert.ok(insightsPayload.insights.length >= 4);
  const text = insightsPayload.insights.map((insight) => `${insight.title} ${insight.body}`).join(' ').toLowerCase();
  for (const forbidden of ['productiv', 'you should', 'better than', 'lazy', 'bad ']) {
    assert.equal(text.includes(forbidden), false, `insight text mentions "${forbidden}"`);
  }
});

test('empty ranges render empty structures instead of failing', () => {
  const stats = source(database([]), emptyLiveContribution(dateKey(NOW)));
  const streaks = computeStreaks(stats);
  const today = buildDailyStats(stats, { streaks });
  assert.equal(today.totalMs, 0);
  assert.equal(today.sessions.length, 0);
  assert.equal(today.comparison.available, false);

  const year = buildYearlyStats(stats, 2026, { streaks });
  assert.equal(year.wrappedAvailable, false);
  assert.equal(year.records.length, 0);
});
