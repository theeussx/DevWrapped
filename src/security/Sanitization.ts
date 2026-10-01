/**
 * Sanitization primitives.
 *
 * Everything that leaves the extension host — HTML, CSV, file names, log
 * lines — is cleaned here first. The rules are intentionally conservative:
 * when in doubt, drop the value instead of fixing it up.
 *
 * No VS Code or Node API is used, so this module is trivially testable.
 */

import { createHash } from 'node:crypto';

/** Hard limits, applied to every value that comes from outside. */
export const LIMITS = {
  /** Longest accepted project name (a folder name). */
  projectName: 64,
  /** Longest accepted language id. */
  languageId: 40,
  /** Longest accepted generic text value. */
  text: 512,
  /** Longest accepted export file name. */
  fileName: 96,
  /** Longest accepted CSV/HTML cell. */
  cell: 2048,
} as const;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const PATH_SEPARATORS = /[\\/]+/g;
// eslint-disable-next-line no-control-regex -- file names must not contain control characters
const UNSAFE_FILE_NAME = /[<>:"|?*\u0000-\u001f]/g;
const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Removes control characters and truncates a value.
 *
 * Used for every string that is stored or rendered, so a hostile workspace
 * name cannot smuggle terminal escape sequences into the dashboard.
 */
export function sanitizeText(value: unknown, maxLength: number = LIMITS.text): string {
  if (typeof value !== 'string') {
    return '';
  }
  const withoutControl = value.replace(CONTROL_CHARACTERS, '');
  const collapsed = withoutControl.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Extracts a safe display name from a workspace folder name.
 *
 * Only the last path segment is kept: Dev Wrapped never stores the location of
 * a project, just what it is called.
 */
export function sanitizeProjectName(value: unknown): string {
  if (typeof value !== 'string') {
    return 'Untitled project';
  }
  const trimmed = value.replace(/[/\\]+$/u, '');
  const segments = trimmed.split(PATH_SEPARATORS).filter((segment) => segment.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] ?? '' : '';
  const cleaned = sanitizeText(last, LIMITS.projectName);
  return cleaned.length > 0 ? cleaned : 'Untitled project';
}

/** Keeps a VS Code language id inside a strict, predictable alphabet. */
export function sanitizeLanguageId(value: unknown): string {
  if (typeof value !== 'string') {
    return 'plaintext';
  }
  const lower = value.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9+#._-]{0,38}$/.test(lower)) {
    return 'plaintext';
  }
  return lower;
}

/** Escapes text for HTML text nodes and attribute values. */
export function escapeHtml(value: unknown): string {
  const text = typeof value === 'string' ? value : stringifyScalar(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes a value so spreadsheet applications treat it as text. */
export function escapeCsvCell(value: unknown): string {
  let text = typeof value === 'string' ? value : stringifyScalar(value);
  text = text.replace(CONTROL_CHARACTERS, '');
  if (text.length > LIMITS.cell) {
    text = text.slice(0, LIMITS.cell);
  }
  // A leading =, +, - or @ makes Excel/LibreOffice evaluate the cell.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  const mustQuote = /[",\n\r;]/.test(text);
  const quoted = text.replace(/"/g, '""');
  return mustQuote ? `"${quoted}"` : quoted;
}

/**
 * Produces a file name that is safe on every platform.
 *
 * The caller still decides the extension; no directory separators survive, so
 * the result can never point outside the chosen folder.
 */
export function sanitizeFileName(value: unknown, fallback = 'code-wrapped'): string {
  const raw = typeof value === 'string' ? value : '';
  const withoutPath = raw.replace(PATH_SEPARATORS, '-').replace(/^\.+/u, '');
  const cleaned = withoutPath.replace(UNSAFE_FILE_NAME, '').replace(/\s+/g, '-').trim();
  const collapsed = cleaned.replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const base = collapsed.length > 0 ? collapsed : fallback;
  const trimmed = base.length > LIMITS.fileName ? base.slice(0, LIMITS.fileName) : base;
  const upper = trimmed.replace(/\.[^.]+$/u, '').toUpperCase();
  return RESERVED_WINDOWS_NAMES.has(upper) ? `${trimmed}-file` : trimmed;
}

/**
 * Removes anything that looks like a path or a credential from a log line.
 *
 * Log output is often pasted into issue trackers; this keeps a workspace path
 * or a token from leaking in a bug report.
 */
export function redactForLog(value: string): string {
  return value
    .replace(/(?:\/[\w.@+-]+){2,}\/?/g, (match) => `<path:${match.length}>`)
    .replace(/[A-Za-z]:\\[\w\\.@+-]*(?:\\[\w.@+-]+)+/g, '<path>')
    .replace(/\b((?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,})\b/g, '<redacted-token>')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '<redacted-key>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted-jwt>');
}

/**
 * Stable pseudonym for a value (workspace URI), salted per installation.
 *
 * The hash is one way: given the stored id there is no way back to the path,
 * and two installations of Dev Wrapped never produce comparable ids.
 */
export function hashIdentifier(value: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${value}`, 'utf8').digest('hex').slice(0, 16);
}

/** String conversion that never falls back to `[object Object]`. */
function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/** Sorts and keeps the `limit` largest entries of a totals map. */
export function topEntries(totals: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(totals)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit));
}

/** Truncates a list of strings, dropping empty entries. */
export function compactList(values: unknown[], limit: number): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const cleaned = sanitizeText(value);
    if (cleaned.length > 0) {
      result.push(cleaned);
    }
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}
