/**
 * Import validation.
 *
 * An imported file is never trusted: it has to be valid JSON under the size
 * limit, must not contain fields that Dev Wrapped never stores (file names,
 * contents, tokens, ...), and is then validated and repaired by the strict
 * schema before anything is written.
 *
 * The preview returned here is what the user sees before deciding: day counts,
 * session counts, date range and any warnings. Importing only replaces the
 * database after an explicit confirmation and after a safety copy was written.
 */

import { findForbiddenKeys, MAX_IMPORT_BYTES, normalizeDatabase, parseJsonSafely } from '../security/Validation';
import type { DatabaseData } from '../types/statistics';

export interface ImportOptions {
  now: number;
  retentionDays: number;
  maxBytes?: number;
}

export interface ImportStats {
  days: number;
  sessions: number;
  projects: number;
  languages: number;
  activeTimeMs: number;
  firstDay?: string;
  lastDay?: string;
}

export interface ImportPreview {
  ok: boolean;
  /** Fatal problem; the import must not continue. */
  error?: string;
  data?: DatabaseData;
  /** Non fatal observations shown to the user. */
  warnings: string[];
  stats: ImportStats;
  /** Forbidden keys that were found (import is refused when non empty). */
  forbiddenKeys: string[];
}

const EMPTY_STATS: ImportStats = { days: 0, sessions: 0, projects: 0, languages: 0, activeTimeMs: 0 };

/**
 * Validates an import without touching the disk or the current database.
 *
 * Never throws: every failure is reported through `ok: false` and `error`.
 */
export function previewImport(text: string, options: ImportOptions): ImportPreview {
  const maxBytes = options.maxBytes ?? MAX_IMPORT_BYTES;
  if (text.length === 0) {
    return failure('The selected file is empty.');
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return failure(`The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB import limit.`);
  }

  const parsed = parseJsonSafely(text, maxBytes);
  if (!parsed.ok) {
    return failure(parsed.error);
  }

  const container = parsed.value as Record<string, unknown> | null;
  if (container === null || typeof container !== 'object') {
    return failure('The file does not contain a Dev Wrapped backup.');
  }

  const payload = extractDatabase(container);
  if (!payload) {
    return failure(
      'The file does not look like a Dev Wrapped backup: a "days" object with daily statistics is required.'
    );
  }

  const forbiddenKeys = findForbiddenKeys(payload);
  if (forbiddenKeys.length > 0) {
    return {
      ok: false,
      error:
        'This file contains fields that Dev Wrapped never stores (for example file names, contents or tokens), so the import was refused for safety.',
      warnings: [],
      stats: EMPTY_STATS,
      forbiddenKeys,
    };
  }

  const normalized = normalizeDatabase(payload, options.now, options.retentionDays);
  const warnings: string[] = [];
  for (const issue of normalized.issues.slice(0, 25)) {
    warnings.push(`${issue.path}: ${issue.message}`);
  }
  if (normalized.issues.length > 25) {
    warnings.push(`…and ${normalized.issues.length - 25} more.`);
  }

  const stats = summarize(normalized.data);
  if (stats.sessions === 0 && stats.days === 0) {
    return {
      ok: false,
      error: 'The backup is valid but contains no recorded activity.',
      warnings,
      stats,
      forbiddenKeys: [],
    };
  }

  return {
    ok: true,
    data: normalized.data,
    warnings,
    stats,
    forbiddenKeys: [],
  };
}

/** Counters shown in the confirmation dialog. */
export function summarize(data: DatabaseData): ImportStats {
  const keys = Object.keys(data.days).sort();
  const languages = new Set<string>();
  for (const day of Object.values(data.days)) {
    for (const id of Object.keys(day.languages)) {
      languages.add(id);
    }
  }
  const stats: ImportStats = {
    days: keys.length,
    sessions: data.sessions.length,
    projects: Object.keys(data.projects).length,
    languages: languages.size,
    activeTimeMs: Object.values(data.days).reduce((sum, day) => sum + day.activeTime, 0),
  };
  if (keys[0]) {
    stats.firstDay = keys[0];
  }
  const last = keys[keys.length - 1];
  if (last) {
    stats.lastDay = last;
  }
  return stats;
}

/** Human readable summary used in the confirmation dialog. */
export function describeImport(preview: ImportPreview): string {
  const { stats } = preview;
  const range = stats.firstDay && stats.lastDay ? `${stats.firstDay} to ${stats.lastDay}` : 'no dates';
  return [
    `${stats.days} day(s) with activity`,
    `${stats.sessions} session(s)`,
    `${stats.projects} project(s)`,
    `${stats.languages} language(s)`,
    `Range: ${range}`,
  ].join('\n');
}

/* --------------------------------- helpers -------------------------------- */

function failure(error: string): ImportPreview {
  return { ok: false, error, warnings: [], stats: EMPTY_STATS, forbiddenKeys: [] };
}

/**
 * Accepts both our backup envelope and a bare database object.
 *
 * Being tolerant here costs nothing: the payload is validated right after.
 */
function extractDatabase(container: Record<string, unknown>): unknown {
  const candidate = container.data;
  if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate;
  }
  if (container.days !== undefined) {
    return container;
  }
  return undefined;
}
