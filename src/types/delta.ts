/**
 * Additive change sets ("deltas").
 *
 * The trackers never rewrite the database: they accumulate small additive
 * records and hand them to the storage layer, which merges them into the
 * aggregates. That keeps writes cheap, makes several open windows safe (each
 * window merges its own delta into the file it read last) and means a crash
 * can only ever lose the last few seconds of activity.
 */

import {
  createDayStats,
  type CodingSession,
  type DateKey,
  type DayStats,
  type LanguageTotals,
  type ProjectMeta,
  type ProjectTotals,
} from './statistics';

/** The part of the current session that has not been written to disk yet. */
export interface LiveContribution {
  date: DateKey;
  /** Active milliseconds. */
  ms: number;
  languages: LanguageTotals;
  projects: ProjectTotals;
  /** Project id -> display name, so the dashboard can label a live session. */
  projectNames: Record<string, string>;
  filesModified: number;
  filesSaved: number;
  filesOpened: number;
  firstActivity?: number;
  lastActivity?: number;
  longestSession: number;
  /** Active milliseconds per local hour (24 entries). */
  hourly: number[];
  /** Sessions that ended inside this delta. */
  sessions: number;
}

/** A day scoped delta. */
export type DayDelta = LiveContribution;

/** Everything one tracker tick can change in the database. */
export interface DatabaseDelta {
  days: Record<DateKey, DayDelta>;
  sessions: CodingSession[];
  projects: Record<string, ProjectMeta>;
}

/** Empty contribution for a day. */
export function emptyLiveContribution(date: DateKey): LiveContribution {
  return {
    date,
    ms: 0,
    languages: {},
    projects: {},
    projectNames: {},
    filesModified: 0,
    filesSaved: 0,
    filesOpened: 0,
    longestSession: 0,
    hourly: new Array<number>(24).fill(0),
    sessions: 0,
  };
}

/** Empty database delta. */
export function createDatabaseDelta(): DatabaseDelta {
  return { days: {}, sessions: [], projects: {} };
}

/** `true` when a delta carries no information at all. */
export function isDayDeltaEmpty(delta: DayDelta): boolean {
  return (
    delta.ms <= 0 &&
    delta.sessions <= 0 &&
    delta.filesModified <= 0 &&
    delta.filesSaved <= 0 &&
    delta.filesOpened <= 0 &&
    Object.keys(delta.languages).length === 0 &&
    Object.keys(delta.projects).length === 0
  );
}

/** `true` when a database delta carries no information at all. */
export function isDatabaseDeltaEmpty(delta: DatabaseDelta): boolean {
  if (delta.sessions.length > 0 || Object.keys(delta.projects).length > 0) {
    return false;
  }
  return Object.values(delta.days).every((day) => isDayDeltaEmpty(day));
}

/** Merges `part` into `target` in place (used by the tracker accumulators). */
export function accumulateDayDelta(target: DayDelta, part: Partial<DayDelta>): void {
  target.ms += part.ms ?? 0;
  target.sessions += part.sessions ?? 0;
  target.filesModified += part.filesModified ?? 0;
  target.filesSaved += part.filesSaved ?? 0;
  target.filesOpened += part.filesOpened ?? 0;
  target.longestSession = Math.max(target.longestSession, part.longestSession ?? 0);

  for (const [language, ms] of Object.entries(part.languages ?? {})) {
    target.languages[language] = (target.languages[language] ?? 0) + ms;
  }
  for (const [project, ms] of Object.entries(part.projects ?? {})) {
    target.projects[project] = (target.projects[project] ?? 0) + ms;
  }
  Object.assign(target.projectNames, part.projectNames ?? {});
  if (part.hourly) {
    for (let hour = 0; hour < 24; hour += 1) {
      target.hourly[hour] = (target.hourly[hour] ?? 0) + (part.hourly[hour] ?? 0);
    }
  }
  if (part.firstActivity !== undefined) {
    target.firstActivity =
      target.firstActivity === undefined ? part.firstActivity : Math.min(target.firstActivity, part.firstActivity);
  }
  if (part.lastActivity !== undefined) {
    target.lastActivity =
      target.lastActivity === undefined ? part.lastActivity : Math.max(target.lastActivity, part.lastActivity);
  }
}

/** Merges one database delta into another (used when several ticks queue up). */
export function mergeDatabaseDelta(target: DatabaseDelta, part: DatabaseDelta): DatabaseDelta {
  for (const [date, day] of Object.entries(part.days)) {
    const existing = target.days[date] ?? emptyLiveContribution(date);
    accumulateDayDelta(existing, day);
    target.days[date] = existing;
  }
  if (part.sessions.length > 0) {
    target.sessions.push(...part.sessions);
  }
  Object.assign(target.projects, part.projects);
  return target;
}

/** Adds a finished session to a delta (counted against the day it ended). */
export function addSessionToDelta(delta: DatabaseDelta, session: CodingSession, dayKey: DateKey): void {
  const day = delta.days[dayKey] ?? emptyLiveContribution(dayKey);
  day.sessions += 1;
  day.longestSession = Math.max(day.longestSession, session.duration);
  delta.days[dayKey] = day;
  delta.sessions.push(session);
  if (session.project && session.projectName) {
    const existing = delta.projects[session.project];
    delta.projects[session.project] = {
      id: session.project,
      name: session.projectName,
      firstSeen: existing ? Math.min(existing.firstSeen, session.startTime) : session.startTime,
      lastSeen: existing ? Math.max(existing.lastSeen, session.endTime) : session.endTime,
    };
  }
}

/** True when a delta carries a project name for an id that is new. */
export function projectNamesOf(delta: DayDelta): Record<string, string> {
  return delta.projectNames;
}

/** Converts a live contribution into a day record (used by tests and exports). */
export function liveToDayStats(live: LiveContribution): DayStats {
  const day = createDayStats(live.date);
  day.activeTime = live.ms;
  day.sessions = live.sessions;
  day.languages = { ...live.languages };
  day.projects = { ...live.projects };
  day.filesModified = live.filesModified;
  day.filesSaved = live.filesSaved;
  day.filesOpened = live.filesOpened;
  day.longestSession = live.longestSession;
  day.hourly = [...live.hourly];
  if (live.firstActivity !== undefined) {
    day.firstActivity = live.firstActivity;
  }
  if (live.lastActivity !== undefined) {
    day.lastActivity = live.lastActivity;
  }
  return day;
}
