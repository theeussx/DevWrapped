/**
 * The analytics entry point.
 *
 * `buildDashboardPayload` turns the database into the complete read model the
 * webview renders: every page, the navigation state, the privacy report and
 * the settings summary. It is called on a throttle (a few seconds) and never
 * touches the disk or the VS Code API, so it is safe to call from any window.
 */

import type { LiveContribution } from '../types/delta';
import type {
  ActivityPayload,
  CalendarPayload,
  DashboardPayload,
  InsightsPayload,
  LanguagesPagePayload,
  PrivacyPayload,
  ProjectsPagePayload,
  SessionsPagePayload,
  SettingsView,
  YearPayload,
} from '../types/analytics';
import type { DatabaseData } from '../types/statistics';
import type { StatusPayload, WrappedSettings } from '../types/config';
import { DASHBOARD_PAGES } from '../types/dashboard';
import { formatBytes } from '../utils/format';
import { PRIVACY_COLLECTED, PRIVACY_FACTS, PRIVACY_NEVER_COLLECTED, PRIVACY_SAFETY, NETWORK_STATEMENT } from '../security/Privacy';
import { MS_PER_MINUTE, dateKey } from '../utils/time';
import { buildActivityPage } from './Timeline';
import { buildCalendarPayload, buildMonthCalendar } from './CalendarStats';
import { buildDailyStats } from './DailyStats';
import { buildInsightsPayload } from './Insights';
import { buildLanguagesPage } from './LanguageStats';
import { buildMonthlyStats } from './MonthlyStats';
import { buildProjectsPage } from './ProjectStats';
import { buildSessionsPage } from './SessionStats';
import { buildWeeklyStats } from './WeeklyStats';
import { buildWrapped } from './Wrapped';
import { buildYearlyStats } from './YearlyStats';
import { computeStreaks } from './Streaks';
import { availableYears, monthRange, yearRange, type RangeContext } from './Ranges';
import type { StatsSource } from './Aggregator';
import { rangeTotals } from './Aggregator';

/** Storage facts shown on the Privacy page. */
export interface StorageFacts {
  directory: string;
  dataFile: string;
  backupFile: string;
  bytes: number;
}

export interface DashboardInput {
  data: DatabaseData;
  live?: LiveContribution;
  settings: WrappedSettings;
  now: number;
  locale: string;
  weekStartsOn: number;
  /** Year selected on the yearly pages. */
  year: number;
  version: string;
  status: StatusPayload;
  storage: StorageFacts;
}

/** Builds every page of the dashboard. */
export function buildDashboardPayload(input: DashboardInput): DashboardPayload {
  const context: RangeContext = {
    now: input.now,
    locale: input.locale,
    weekStartsOn: input.weekStartsOn,
  };
  const source: StatsSource = {
    data: input.data,
    now: input.now,
    locale: input.locale,
    weekStartsOn: input.weekStartsOn,
    minimumActiveTimeMs: Math.max(1, input.settings.minimumActiveTime) * MS_PER_MINUTE,
    ...(input.live ? { live: input.live } : {}),
  };

  const streaks = computeStreaks(source);
  const currentMonth = monthRange(context);
  const selectedYear = yearRange(context, input.year);

  const today = buildDailyStats(source, { streaks });
  const week = buildWeeklyStats(source, { streaks });
  const month = buildMonthlyStats(source, { streaks });
  const yearView: YearPayload = buildYearlyStats(source, input.year, { streaks });

  const yearTotals = rangeTotals(source, selectedYear);

  const languages: LanguagesPagePayload = buildLanguagesPage(source, selectedYear);
  const projects: ProjectsPagePayload = buildProjectsPage(source, selectedYear);
  const sessions: SessionsPagePayload = buildSessionsPage(source, selectedYear);
  const calendar: CalendarPayload = buildCalendarPayload(source, input.year);
  const activity: ActivityPayload = buildActivityPage(source, selectedYear);

  const insights: InsightsPayload = buildInsightsPayload(
    source,
    selectedYear,
    yearTotals,
    streaks,
    yearView.records,
    { languages: yearView.languages, projects: yearView.projects }
  );

  const privacy = buildPrivacyPayload(input);
  const settings = buildSettingsView(input.settings);

  return {
    version: input.version,
    generatedAt: input.now,
    locale: input.locale,
    weekStartsOn: input.weekStartsOn,
    year: input.year,
    availableYears: availableYears(input.data, input.now),
    pages: [...DASHBOARD_PAGES],
    today,
    week,
    month,
    monthCalendar: buildMonthCalendar(source, new Date(currentMonth.start).getFullYear(), new Date(currentMonth.start).getMonth()),
    yearView,
    activity,
    languages,
    projects,
    sessions,
    calendar,
    insights,
    privacy,
    wrapped: buildWrapped(source, input.year, { streaks }),
    settings,
    status: input.status,
  };
}

/** The privacy report: what is stored, where it lives and what is never read. */
export function buildPrivacyPayload(input: DashboardInput): PrivacyPayload {
  const dayKeys = Object.keys(input.data.days).sort();
  const languages = new Set<string>();
  for (const day of Object.values(input.data.days)) {
    for (const id of Object.keys(day.languages)) {
      languages.add(id);
    }
  }

  const payload: PrivacyPayload = {
    collected: [...PRIVACY_COLLECTED],
    neverCollected: [...PRIVACY_NEVER_COLLECTED],
    safety: [...PRIVACY_SAFETY],
    facts: PRIVACY_FACTS.map((fact) => ({ question: fact.question, answer: fact.answer })),
    networkStatement: NETWORK_STATEMENT,
    storage: {
      directory: input.storage.dataFile.slice(0, Math.max(0, input.storage.dataFile.length - input.storage.dataFile.split(/[/\\]/).pop()!.length)),
      dataFile: input.storage.dataFile,
      backupFile: input.storage.backupFile,
      size: formatBytes(input.storage.bytes),
    },
    stored: {
      days: dayKeys.length,
      sessions: input.data.sessions.length,
      projects: Object.keys(input.data.projects).length,
      languages: languages.size,
      retentionDays: input.data.meta.retentionDays,
      ...(dayKeys[0] ? { firstDay: dayKeys[0] } : {}),
      ...(dayKeys[dayKeys.length - 1] ? { lastDay: String(dayKeys[dayKeys.length - 1]) } : {}),
    },
    tracking: {
      enabled: !input.status.tracking.paused,
      paused: input.status.tracking.paused,
      idleTimeoutMinutes: input.settings.inactivityTimeout,
      minimumActiveTimeMinutes: input.settings.minimumActiveTime,
      trackLanguages: input.settings.trackLanguages,
      trackProjects: input.settings.trackProjects,
      debugLogging: input.settings.debugLogging,
    },
    network: {
      requests: 0,
      statement: NETWORK_STATEMENT,
    },
  };

  // The "last stored day" is the most useful sanity check for the user: it is
  // the newest day in the database, not the newest day with data.
  const lastKey = dayKeys[dayKeys.length - 1];
  if (lastKey) {
    payload.stored.lastDay = lastKey;
  }
  return payload;
}

/** Settings summary shown in the dashboard's Privacy page and the settings view. */
export function buildSettingsView(settings: WrappedSettings): SettingsView {
  return {
    inactivityTimeout: settings.inactivityTimeout,
    minimumActiveTime: settings.minimumActiveTime,
    trackLanguages: settings.trackLanguages,
    trackProjects: settings.trackProjects,
    enableNotifications: settings.enableNotifications,
    debugLogging: settings.debugLogging,
    showStatusBar: settings.showStatusBar,
    sessionRetentionDays: settings.sessionRetentionDays,
  };
}

/** Day key of "today" in the local timezone (used by commands). */
export function todayKey(source: StatsSource): string {
  return source.live?.date ?? dateKey(source.now);
}
