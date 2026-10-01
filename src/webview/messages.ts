/**
 * Webview message validation.
 *
 * The webview lives in a sandboxed iframe and could, in principle, send
 * anything. Messages are therefore never trusted: they are checked against the
 * exact shape of the contract, rebuilt as fresh objects (so no prototype or
 * extra property can survive) and anything unexpected is dropped and logged in
 * debug mode.
 */

import { EXPORT_FORMATS, isDashboardPage, type ExportFormat, type WebviewMessage } from '../types/dashboard';
import { sanitizeText } from '../security/Sanitization';

const KNOWN_TYPES = new Set([
  'ready',
  'refresh',
  'openSettings',
  'openPrivacy',
  'pauseTracking',
  'resumeTracking',
  'resetStatistics',
  'navigate',
  'selectYear',
  'export',
]);

/** Lowest year the dashboard accepts (a defensive bound, not a product limit). */
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

/**
 * Validates an incoming message.
 *
 * Returns `undefined` for anything unknown or malformed; the caller decides
 * whether to log it (debug level only, never the payload).
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : undefined;
  if (!type || !KNOWN_TYPES.has(type)) {
    return undefined;
  }

  switch (type) {
    case 'ready':
      return { type: 'ready' };
    case 'refresh':
      return { type: 'refresh' };
    case 'openSettings':
      return { type: 'openSettings' };
    case 'openPrivacy':
      return { type: 'openPrivacy' };
    case 'pauseTracking':
      return { type: 'pauseTracking' };
    case 'resumeTracking':
      return { type: 'resumeTracking' };
    case 'resetStatistics':
      return { type: 'resetStatistics' };
    case 'navigate': {
      if (!isDashboardPage(record.page)) {
        return undefined;
      }
      return { type: 'navigate', page: record.page };
    }
    case 'selectYear': {
      const year = normalizeYear(record.year);
      return year === undefined ? undefined : { type: 'selectYear', year };
    }
    case 'export': {
      if (typeof record.format !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(record.format)) {
        return undefined;
      }
      return { type: 'export', format: record.format as ExportFormat };
    }
    default:
      return undefined;
  }
}

/** Year validation: numbers only, bounded to a sane window. */
export function normalizeYear(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_YEAR || parsed > MAX_YEAR) {
    return undefined;
  }
  return parsed;
}

/** Short, safe description of a rejected message (no payload contents). */
export function describeRejectedMessage(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') {
    return `non-object message (${typeof raw})`;
  }
  const type = (raw as Record<string, unknown>).type;
  return `unsupported message type: ${typeof type === 'string' ? sanitizeText(type, 40) : 'missing'}`;
}
