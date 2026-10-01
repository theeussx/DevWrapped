/**
 * Export formats.
 *
 * A JSON backup contains exactly what Dev Wrapped stores (and nothing else), so
 * it can be imported again on another machine. The CSV exports are meant for
 * spreadsheets and are written as plain text with escaped cells.
 *
 * Nothing in this module touches the file system: it builds strings, and the
 * transfer service writes them where the user chose.
 */

import type { DatabaseData, DayStats } from '../types/statistics';
import { DB_SCHEMA_VERSION } from '../types/statistics';
import { escapeCsvCell } from '../security/Sanitization';
import { MS_PER_MINUTE } from '../utils/time';

export interface ExportOptions {
  version: string;
  now: number;
  locale: string;
}

/** One CSV file: a suggested name plus its content. */
export interface CsvFile {
  name: string;
  content: string;
}

const CSV_NEWLINE = '\r\n';

/** Complete JSON backup, pretty printed so it stays reviewable by hand. */
export function buildJsonBackup(data: DatabaseData, options: ExportOptions): string {
  const payload = {
    format: 'dev-wrapped-backup',
    formatVersion: 1,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date(options.now).toISOString(),
    extensionVersion: options.version,
    locale: options.locale,
    /** The store itself: days, sessions, projects and metadata. */
    data: {
      meta: {
        ...data.meta,
        // The salt is deliberately not exported: a backup restored on another
        // machine gets a fresh salt, so project hashes can never be correlated
        // across installations.
        privacySalt: '',
      },
      days: data.days,
      sessions: data.sessions,
      projects: data.projects,
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** All CSV exports, ready to be written into the chosen folder. */
export function buildCsvExports(data: DatabaseData): CsvFile[] {
  return [
    { name: 'daily.csv', content: dailyCsv(data) },
    { name: 'sessions.csv', content: sessionsCsv(data) },
    { name: 'languages.csv', content: languagesCsv(data) },
    { name: 'projects.csv', content: projectsCsv(data) },
  ];
}

/** One row per day. */
export function dailyCsv(data: DatabaseData): string {
  const header = [
    'date',
    'active_minutes',
    'sessions',
    'files_modified',
    'files_saved',
    'files_opened',
    'longest_session_minutes',
    'first_activity',
    'last_activity',
    'top_language',
  ];
  const rows = Object.keys(data.days)
    .sort()
    .map((key) => {
      const day = data.days[key];
      if (!day) {
        return '';
      }
      return [
        day.date,
        minutes(day.activeTime),
        day.sessions,
        day.filesModified,
        day.filesSaved,
        day.filesOpened,
        minutes(day.longestSession),
        formatTimestamp(day.firstActivity),
        formatTimestamp(day.lastActivity),
        topEntry(day.languages),
      ]
        .map(escapeCsvCell)
        .join(',');
    })
    .filter((row) => row.length > 0);
  return [header.join(','), ...rows].join(CSV_NEWLINE) + CSV_NEWLINE;
}

/** One row per session. */
export function sessionsCsv(data: DatabaseData): string {
  const header = [
    'id',
    'date',
    'start',
    'end',
    'duration_minutes',
    'language',
    'project',
    'project_name',
  ];
  const rows = data.sessions.map((session) =>
    [
      session.id,
      new Date(session.startTime).toISOString().slice(0, 10),
      new Date(session.startTime).toISOString(),
      new Date(session.endTime).toISOString(),
      minutes(session.duration),
      session.language ?? '',
      session.project ?? '',
      session.projectName ?? '',
    ]
      .map(escapeCsvCell)
      .join(',')
  );
  return [header.join(','), ...rows].join(CSV_NEWLINE) + CSV_NEWLINE;
}

/** One row per language. */
export function languagesCsv(data: DatabaseData): string {
  const totals: Record<string, { ms: number; days: Set<string>; first: number; last: number }> = {};
  for (const day of Object.values(data.days)) {
    for (const [id, ms] of Object.entries(day.languages)) {
      const entry = totals[id] ?? { ms: 0, days: new Set<string>(), first: Number.MAX_SAFE_INTEGER, last: 0 };
      entry.ms += ms;
      entry.days.add(day.date);
      if (day.firstActivity !== undefined) {
        entry.first = Math.min(entry.first, day.firstActivity);
      }
      if (day.lastActivity !== undefined) {
        entry.last = Math.max(entry.last, day.lastActivity);
      }
      totals[id] = entry;
    }
  }
  const header = ['language', 'active_minutes', 'days_used', 'first_activity', 'last_activity'];
  const rows = Object.entries(totals)
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([id, entry]) =>
      [
        id,
        minutes(entry.ms),
        entry.days.size,
        entry.first === Number.MAX_SAFE_INTEGER ? '' : new Date(entry.first).toISOString(),
        entry.last > 0 ? new Date(entry.last).toISOString() : '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  return [header.join(','), ...rows].join(CSV_NEWLINE) + CSV_NEWLINE;
}

/** One row per project (hash, name and totals only). */
export function projectsCsv(data: DatabaseData): string {
  const totals: Record<string, { ms: number; sessions: number }> = {};
  for (const day of Object.values(data.days)) {
    for (const [id, ms] of Object.entries(day.projects)) {
      const entry = totals[id] ?? { ms: 0, sessions: 0 };
      entry.ms += ms;
      entry.sessions += 1;
      totals[id] = entry;
    }
  }
  const header = ['project_id', 'project_name', 'active_minutes', 'days_active', 'first_seen', 'last_seen'];
  const rows = Object.entries(totals)
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([id, entry]) => {
      const meta = data.projects[id];
      return [
        id,
        meta?.name ?? '',
        minutes(entry.ms),
        entry.sessions,
        meta ? new Date(meta.firstSeen).toISOString() : '',
        meta ? new Date(meta.lastSeen).toISOString() : '',
      ]
        .map(escapeCsvCell)
        .join(',');
    });
  return [header.join(','), ...rows].join(CSV_NEWLINE) + CSV_NEWLINE;
}

/** Daily totals as a small array (used by tests and the wrapped export). */
export function dayRows(data: DatabaseData): Array<{ date: string; ms: number; sessions: number }> {
  return Object.keys(data.days)
    .sort()
    .map((key) => {
      const day: DayStats | undefined = data.days[key];
      return { date: key, ms: day?.activeTime ?? 0, sessions: day?.sessions ?? 0 };
    });
}

/* --------------------------------- helpers -------------------------------- */

function minutes(ms: number): number {
  return Math.round((Math.max(0, ms) / MS_PER_MINUTE) * 10) / 10;
}

function formatTimestamp(ts: number | undefined): string {
  return ts === undefined ? '' : new Date(ts).toISOString();
}

function topEntry(values: Record<string, number>): string {
  const top = Object.entries(values).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : '';
}
