/**
 * Aggregation.
 *
 * One place turns the stored database (plus the not-yet-flushed live
 * contribution) into range totals. Every page is built from these totals, so
 * the numbers on two pages can never disagree.
 *
 * Everything here is pure: no VS Code, no clock, no file system.
 */

import type { LiveContribution } from '../types/delta';
import type {
  CodingSession,
  DateKey,
  DatabaseData,
  DayStats,
  ProjectMeta,
} from '../types/statistics';
import { languageLabel } from '../utils/format';
import { createDayStats } from '../types/statistics';
import { dayOfWeek, hourOfDay } from '../utils/time';
import type { RangeDescriptor } from './Ranges';

/** The single input of every analytics function. */
export interface StatsSource {
  data: DatabaseData;
  /** Contribution of the session in progress, if any. */
  live?: LiveContribution;
  /** Reference "now"; all ranges end here. */
  now: number;
  locale: string;
  weekStartsOn: number;
  /** Minimum active time for a day to count towards a streak. */
  minimumActiveTimeMs: number;
}

/** Per-day totals with the live contribution already merged in. */
export interface DayTotals {
  date: DateKey;
  ms: number;
  sessions: number;
  languages: Record<string, number>;
  projects: Record<string, number>;
  filesModified: number;
  filesSaved: number;
  filesOpened: number;
  longestSession: number;
  hourly: number[];
  firstActivity?: number;
  lastActivity?: number;
  /** `true` when the day reached the streak threshold. */
  qualifies: boolean;
  /** `true` when any activity (or a stored record) exists for the day. */
  active: boolean;
}

/** Aggregated totals for one range. */
export interface RangeTotals {
  range: RangeDescriptor;
  ms: number;
  sessions: number;
  filesModified: number;
  filesSaved: number;
  filesOpened: number;
  languages: Record<string, number>;
  projects: Record<string, number>;
  /** Milliseconds per local hour (24 buckets). */
  hourly: number[];
  /** Milliseconds per weekday, 0 = Sunday (7 buckets). */
  weekdays: number[];
  /** One entry per day of the range, even when the day has no activity. */
  days: DayTotals[];
  activeDays: number;
  qualifyingDays: number;
  averagePerActiveDayMs: number;
  longestSessionMs: number;
  firstActivity?: number;
  lastActivity?: number;
}

/** Per-day totals of one day, merged with the live contribution when relevant. */
export function dayTotals(source: StatsSource, date: DateKey): DayTotals {
  const stored = source.data.days[date];
  const live = source.live && source.live.date === date ? source.live : undefined;
  return mergeDay(source, stored, live);
}

/** `true` when the day has any activity at all. */
function mergeDay(source: StatsSource, stored: DayStats | undefined, live: LiveContribution | undefined): DayTotals {
  const base: DayTotals = {
    date: stored?.date ?? live?.date ?? '',
    ms: stored?.activeTime ?? 0,
    sessions: stored?.sessions ?? 0,
    languages: { ...(stored?.languages ?? {}) },
    projects: { ...(stored?.projects ?? {}) },
    filesModified: stored?.filesModified ?? 0,
    filesSaved: stored?.filesSaved ?? 0,
    filesOpened: stored?.filesOpened ?? 0,
    longestSession: stored?.longestSession ?? 0,
    hourly: stored?.hourly ? [...stored.hourly] : new Array<number>(24).fill(0),
    active: (stored?.activeTime ?? 0) > 0,
    qualifies: false,
  };
  if (stored?.firstActivity !== undefined) {
    base.firstActivity = stored.firstActivity;
  }
  if (stored?.lastActivity !== undefined) {
    base.lastActivity = stored.lastActivity;
  }

  if (live) {
    base.ms += live.ms;
    base.sessions += live.sessions;
    base.filesModified += live.filesModified;
    base.filesSaved += live.filesSaved;
    base.filesOpened += live.filesOpened;
    base.longestSession = Math.max(base.longestSession, live.longestSession);
    for (const [id, ms] of Object.entries(live.languages)) {
      base.languages[id] = (base.languages[id] ?? 0) + ms;
    }
    for (const [id, ms] of Object.entries(live.projects)) {
      base.projects[id] = (base.projects[id] ?? 0) + ms;
    }
    for (let hour = 0; hour < 24; hour += 1) {
      base.hourly[hour] = (base.hourly[hour] ?? 0) + (live.hourly[hour] ?? 0);
    }
    if (live.firstActivity !== undefined) {
      base.firstActivity =
        base.firstActivity === undefined ? live.firstActivity : Math.min(base.firstActivity, live.firstActivity);
    }
    if (live.lastActivity !== undefined) {
      base.lastActivity =
        base.lastActivity === undefined ? live.lastActivity : Math.max(base.lastActivity, live.lastActivity);
    }
    if (live.ms > 0) {
      base.active = true;
    }
  }

  base.qualifies = base.ms >= source.minimumActiveTimeMs;
  return base;
}

/** Aggregates every day of a range. */
export function rangeTotals(source: StatsSource, range: RangeDescriptor): RangeTotals {
  const totals: RangeTotals = {
    range,
    ms: 0,
    sessions: 0,
    filesModified: 0,
    filesSaved: 0,
    filesOpened: 0,
    languages: {},
    projects: {},
    hourly: new Array<number>(24).fill(0),
    weekdays: new Array<number>(7).fill(0),
    days: [],
    activeDays: 0,
    qualifyingDays: 0,
    averagePerActiveDayMs: 0,
    longestSessionMs: 0,
  };

  for (const date of range.days) {
    const day = dayTotals(source, date);
    totals.days.push(day);
    if (!day.active) {
      continue;
    }
    totals.activeDays += 1;
    if (day.qualifies) {
      totals.qualifyingDays += 1;
    }
    totals.ms += day.ms;
    totals.sessions += day.sessions;
    totals.filesModified += day.filesModified;
    totals.filesSaved += day.filesSaved;
    totals.filesOpened += day.filesOpened;
    totals.longestSessionMs = Math.max(totals.longestSessionMs, day.longestSession);
    for (const [id, ms] of Object.entries(day.languages)) {
      totals.languages[id] = (totals.languages[id] ?? 0) + ms;
    }
    for (const [id, ms] of Object.entries(day.projects)) {
      totals.projects[id] = (totals.projects[id] ?? 0) + ms;
    }
    for (let hour = 0; hour < 24; hour += 1) {
      totals.hourly[hour] = (totals.hourly[hour] ?? 0) + (day.hourly[hour] ?? 0);
    }
    const weekday = dayOfWeek(new Date(`${date}T12:00:00`).getTime());
    if (weekday >= 0 && weekday < 7) {
      totals.weekdays[weekday] = (totals.weekdays[weekday] ?? 0) + day.ms;
    }
    totals.firstActivity = day.firstActivity ?? totals.firstActivity;
    if (day.lastActivity !== undefined) {
      totals.lastActivity =
        totals.lastActivity === undefined ? day.lastActivity : Math.max(totals.lastActivity, day.lastActivity);
    }
  }

  totals.averagePerActiveDayMs = totals.activeDays > 0 ? Math.round(totals.ms / totals.activeDays) : 0;
  return totals;
}

/* --------------------------------- sessions -------------------------------- */

/** Sessions that started inside the range, oldest first. */
export function sessionsInRange(source: StatsSource, range: RangeDescriptor): CodingSession[] {
  const sessions = source.data.sessions.filter(
    (session) => session.startTime >= range.start && session.startTime < range.end
  );
  return sessions.sort((a, b) => a.startTime - b.startTime);
}

/**
 * The session in progress, as a pseudo session record.
 *
 * The live contribution does not know the exact start of the current session,
 * so the pseudo record is derived from the first activity observed in it.
 */
export function liveSession(source: StatsSource): CodingSession | undefined {
  const live = source.live;
  if (!live || live.ms <= 0) {
    return undefined;
  }
  const start = live.firstActivity ?? source.now - live.ms;
  const end = live.lastActivity ?? source.now;
  const session: CodingSession = {
    id: 'live',
    startTime: start,
    endTime: Math.max(start, end),
    duration: live.ms,
  };
  const language = topKey(live.languages);
  if (language) {
    session.language = language;
  }
  const project = topKey(live.projects);
  if (project) {
    session.project = project;
  }
  return session;
}

/* ------------------------------- projections ------------------------------- */

/** Languages sorted by active time, limited to `limit` entries. */
export function topLanguages(
  totals: RangeTotals,
  limit: number
): Array<{ id: string; label: string; ms: number; share: number }> {
  const entries = Object.entries(totals.languages)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
  return entries.slice(0, limit).map(([id, ms]) => ({
    id,
    label: languageLabel(id),
    ms,
    share: total > 0 ? ms / total : 0,
  }));
}

/** Projects sorted by active time, limited to `limit` entries. */
export function topProjects(
  source: StatsSource,
  totals: RangeTotals,
  limit: number
): Array<{ id: string; name: string; ms: number; share: number; sessions: number; lastActive: number }> {
  const entries = Object.entries(totals.projects)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
  return entries.slice(0, limit).map(([id, ms]) => {
    const meta = projectMeta(source, id);
    const sessions = totals.days.reduce((sum, day) => sum + (day.projects[id] ? 1 : 0), 0);
    return {
      id,
      name: meta?.name ?? 'Unknown project',
      ms,
      share: total > 0 ? ms / total : 0,
      sessions,
      lastActive: meta?.lastSeen ?? totals.lastActivity ?? totals.range.end,
    };
  });
}

/** Project metadata, including names learned from the live contribution. */
export function projectMeta(source: StatsSource, id: string): ProjectMeta | undefined {
  const stored = source.data.projects[id];
  const liveName = source.live?.projectNames?.[id];
  if (stored && (!liveName || stored.name === liveName)) {
    return stored;
  }
  if (stored) {
    return stored;
  }
  if (liveName) {
    return { id, name: liveName, firstSeen: source.live?.firstActivity ?? source.now, lastSeen: source.now };
  }
  return undefined;
}

/** Key with the highest value in a `Record<string, number>`. */
export function topKey(values: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestValue = -1;
  for (const [key, value] of Object.entries(values)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

/** The hour with the most active time. */
export function peakHour(totals: RangeTotals): number | undefined {
  let hour: number | undefined;
  let best = 0;
  totals.hourly.forEach((ms, index) => {
    if (ms > best) {
      best = ms;
      hour = index;
    }
  });
  return hour;
}

/** Empty day record for a date key (re-exported for convenience). */
export { createDayStats };

/** Hour of day of a timestamp (re-exported so analytics modules import less). */
export { hourOfDay };
