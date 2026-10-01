/**
 * The read model: exactly what the dashboard renders.
 *
 * The analytics layer turns the stored statistics into these plain objects, and
 * the webview renders them without doing any number crunching of its own. Every
 * field is optional safe: the client must be able to render a page even when a
 * comparison has no baseline or a project was never tracked.
 *
 * Wording rules (product decision): metrics are descriptive, never judgemental.
 * Labels say "most active", never "best", "productive" or "improved".
 */

import type { DateKey } from './statistics';

/** Neutral tone enum shared by cards, insights and comparisons. */
export type Tone = 'neutral' | 'positive' | 'muted';

/** A single headline number. */
export interface MetricCard {
  id: string;
  label: string;
  value: string;
  /** Secondary line under the value. */
  sub?: string;
  /** Tooltip / explanation. */
  hint?: string;
  tone?: Tone;
}

/** One point of a trend chart. */
export interface TrendPoint {
  /** Date key for day granularity, `YYYY-MM` for month granularity, hour index for hours. */
  key: string;
  label: string;
  value: number;
}

export interface TrendView {
  points: TrendPoint[];
  granularity: 'hour' | 'day' | 'month';
  /** Highest value in the series (0 when empty). */
  max: number;
}

export interface HourlyBucketView {
  hour: number;
  label: string;
  ms: number;
  share: number;
}

export interface WeekdayBucketView {
  weekday: number;
  label: string;
  ms: number;
  share: number;
}

/** A comparison between two periods. Never framed as an improvement. */
export interface ComparisonView {
  id: string;
  title: string;
  currentLabel: string;
  previousLabel: string;
  currentMs: number;
  previousMs: number;
  deltaMs: number;
  /** `null` when there is no previous period to compare against. */
  deltaRatio: number | null;
  /** `false` when the previous period has no data at all. */
  available: boolean;
  /** Explanation shown when `available` is false. */
  message?: string;
}

export interface LanguageSliceView {
  id: string;
  label: string;
  ms: number;
  /** Sessions whose dominant language was this one. */
  sessions: number;
  /** Share of the total active time of the range (0-1). */
  share: number;
  /** Epoch ms of the last activity recorded for this language. */
  lastActive?: number;
}

export interface ProjectSliceView {
  id: string;
  name: string;
  ms: number;
  sessions: number;
  share: number;
  lastActive: number;
}

export interface SessionView {
  id: string;
  start: number;
  end: number;
  durationMs: number;
  dayKey: DateKey;
  language?: string;
  languageLabel?: string;
  project?: string;
  projectName?: string;
  /** `true` when the session has not finished yet (live session). */
  live?: boolean;
}

export interface CalendarDayView {
  date: DateKey;
  ms: number;
  /** 0 = no activity, 4 = busiest day of the range. */
  level: 0 | 1 | 2 | 3 | 4;
  sessions: number;
  label: string;
  /** `true` for days that belong to the range being displayed. */
  inRange: boolean;
  /** `true` for today (local). */
  isToday: boolean;
  /** `true` when the day reaches the streak threshold. */
  countsForStreak: boolean;
}

export interface CalendarWeekView {
  /** Week start day key (used as a stable key). */
  key: string;
  days: CalendarDayView[];
  ms: number;
}

export interface CalendarMonthView {
  /** `YYYY-MM`. */
  key: string;
  label: string;
  year: number;
  monthIndex: number;
  weeks: CalendarWeekView[];
  ms: number;
  activeDays: number;
}

export interface HeatmapView {
  /** Columns of the calendar, oldest first. */
  weeks: CalendarWeekView[];
  months: Array<{ index: number; label: string }>;
  maxMs: number;
  totalMs: number;
  activeDays: number;
  start: DateKey;
  end: DateKey;
}

export interface StreakView {
  current: number;
  longest: number;
  currentStart?: DateKey;
  longestStart?: DateKey;
  longestEnd?: DateKey;
  /** Days that reached the minimum active time, in the analysed window. */
  qualifyingDays: number;
  minimumActiveTimeMinutes: number;
}

export interface RecordView {
  id: string;
  label: string;
  value: string;
  /** Day the record belongs to, when applicable. */
  dateKey?: DateKey;
  detail?: string;
}

export type InsightKind =
  | 'rhythm'
  | 'language'
  | 'project'
  | 'streak'
  | 'consistency'
  | 'volume'
  | 'sessions'
  | 'comparison';

export interface InsightView {
  id: string;
  kind: InsightKind;
  title: string;
  body: string;
  tone: Tone;
  /** Short emoji free marker rendered as a small glyph: `clock`, `code`, `folder`, `flame`, `calendar`. */
  icon: 'clock' | 'code' | 'folder' | 'flame' | 'calendar' | 'spark';
}

export interface TimelineEventView {
  id: string;
  at: number;
  /** Full local time, pre-formatted. */
  time: string;
  dayKey: DateKey;
  dayLabel: string;
  kind: 'sessionStart' | 'sessionEnd' | 'milestone' | 'language' | 'project' | 'day';
  title: string;
  detail?: string;
  icon: InsightView['icon'];
  /** Duration badge, when the event is a session. */
  durationMs?: number;
}

export interface MonthlyTotalView {
  key: string;
  label: string;
  ms: number;
  sessions: number;
  share: number;
  activeDays: number;
}

export interface DailyTotalView {
  date: DateKey;
  label: string;
  ms: number;
  sessions: number;
  languages: string[];
  active: boolean;
}

/** A period page: today, week, month, year (short form). */
export interface PeriodPayload {
  id: 'today' | 'week' | 'month' | 'year';
  title: string;
  subtitle: string;
  rangeLabel: string;
  /** Total active time of the range, for summary rows. */
  totalMs: number;
  cards: MetricCard[];
  trend: TrendView;
  hourly: HourlyBucketView[];
  weekdays: WeekdayBucketView[];
  languages: LanguageSliceView[];
  projects: ProjectSliceView[];
  /** Number of languages/projects in the range (before the display limit). */
  languageCount: number;
  projectCount: number;
  sessions: SessionView[];
  insights: InsightView[];
  comparison: ComparisonView;
  daily: DailyTotalView[];
}

export interface YearPayload {
  year: number;
  /** Total active time of the year. */
  totalMs: number;
  cards: MetricCard[];
  trend: TrendView;
  months: MonthlyTotalView[];
  heatmap: HeatmapView;
  hourly: HourlyBucketView[];
  weekdays: WeekdayBucketView[];
  languages: LanguageSliceView[];
  projects: ProjectSliceView[];
  records: RecordView[];
  sessions: SessionView[];
  comparison: ComparisonView;
  insights: InsightView[];
  wrappedAvailable: boolean;
}

export interface CalendarPayload {
  year: number;
  heatmap: HeatmapView;
  months: CalendarMonthView[];
  totalMs: number;
  activeDays: number;
  bestDay?: CalendarDayView;
  bestWeekMs: number;
  monthly: MonthlyTotalView[];
  years: number[];
}

export interface ActivityPayload {
  days: DailyTotalView[];
  timeline: TimelineEventView[];
  busiestDay?: DailyTotalView;
  totals: {
    sessions: number;
    activeDays: number;
    averageSessionMs: number;
    longestSessionMs: number;
    longestSessionDate?: DateKey;
  };
}

/** One slide of the yearly retrospective. */
export interface WrappedSlide {
  id: string;
  kind: 'intro' | 'volume' | 'languages' | 'projects' | 'sessions' | 'rhythm' | 'streak' | 'outro';
  kicker: string;
  title: string;
  /** Headline value, already formatted by the extension host. */
  value: string;
  unit: string;
  caption: string;
  bars: Array<{ label: string; detail: string; share: number; leader: boolean }>;
  footnote: string;
  icon: InsightView['icon'];
}

export interface WrappedPayload {
  year: number;
  slides: WrappedSlide[];
  /** `true` when the year has enough data for a retrospective. */
  available: boolean;
  message?: string;
}

export interface PrivacyPayload {
  collected: string[];
  neverCollected: string[];
  safety: string[];
  facts: Array<{ question: string; answer: string }>;
  networkStatement: string;
  storage: {
    directory: string;
    dataFile: string;
    backupFile: string;
    size: string;
  };
  /** Counters that prove nothing sensitive is stored. */
  stored: {
    days: number;
    sessions: number;
    projects: number;
    languages: number;
    firstDay?: DateKey;
    lastDay?: DateKey;
    retentionDays: number;
  };
  tracking: {
    enabled: boolean;
    paused: boolean;
    idleTimeoutMinutes: number;
    minimumActiveTimeMinutes: number;
    trackLanguages: boolean;
    trackProjects: boolean;
    debugLogging: boolean;
  };
  network: {
    requests: number;
    statement: string;
  };
}

export interface InsightsPayload {
  insights: InsightView[];
  records: RecordView[];
  streaks: StreakView;
  consistency: {
    activeDays: number;
    trackedDays: number;
    ratio: number;
    label: string;
  };
  rhythm: {
    bestHour?: HourlyBucketView;
    quietestHours: number[];
    busiestWeekday?: WeekdayBucketView;
    note: string;
  };
  languages: LanguageSliceView[];
  projects: ProjectSliceView[];
}

export interface SettingsView {
  inactivityTimeout: number;
  minimumActiveTime: number;
  trackLanguages: boolean;
  trackProjects: boolean;
  enableNotifications: boolean;
  debugLogging: boolean;
  showStatusBar: boolean;
  sessionRetentionDays: number;
}

/** Languages page ("Languages"). */
export interface LanguagesPagePayload {
  range: string;
  /** Range the slices belong to (page selector). */
  rangeKey: string;
  totalMs: number;
  slices: LanguageSliceView[];
  trend: TrendView;
  languages: number;
  filesTouched: number;
  note: string;
}

/** Projects page ("Projects"). */
export interface ProjectsPagePayload {
  range: string;
  rangeKey: string;
  totalMs: number;
  slices: ProjectSliceView[];
  trend: TrendView;
  projects: number;
  sessions: number;
  note: string;
}

/** Sessions page ("Sessions"). */
export interface SessionsPagePayload {
  range: string;
  rangeKey: string;
  total: number;
  views: SessionView[];
  averageMs: number;
  longestMs: number;
  longestId?: string;
  filters: {
    projects: Array<{ id: string; name: string }>;
    languages: Array<{ id: string; label: string }>;
    known: boolean;
  };
}

/** Everything the webview needs to render any page. */
export interface DashboardPayload {
  version: string;
  generatedAt: number;
  locale: string;
  weekStartsOn: number;
  year: number;
  availableYears: number[];
  pages: string[];
  today: PeriodPayload;
  week: PeriodPayload;
  month: PeriodPayload;
  /** Grid of the current month, shown on the Month page. */
  monthCalendar: CalendarMonthView;
  yearView: YearPayload;
  activity: ActivityPayload;
  languages: LanguagesPagePayload;
  projects: ProjectsPagePayload;
  sessions: SessionsPagePayload;
  calendar: CalendarPayload;
  insights: InsightsPayload;
  privacy: PrivacyPayload;
  wrapped: WrappedPayload;
  settings: SettingsView;
  status: {
    tracking: {
      enabled: boolean;
      paused: boolean;
      reason?: string;
      sessionStart?: number;
      sessionActiveTime: number;
      todayActiveTime: number;
      idleTimeoutMinutes: number;
      minimumActiveTimeMinutes: number;
    };
    currentStreak: number;
    version: string;
  };
}
