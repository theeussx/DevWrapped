/**
 * The dashboard contract: pages, messages from the webview and messages to it.
 *
 * The webview is treated as untrusted input: every message is validated and
 * rebuilt field by field in `src/webview/messages.ts` before it reaches any
 * handler. Outgoing messages only ever carry the read model (`DashboardPayload`)
 * plus a page name or a short toast.
 */

import type { DashboardPayload } from './analytics';

export type { DashboardPayload };

/** Every page of the dashboard, in navigation order. */
export const DASHBOARD_PAGES = [
  'overview',
  'today',
  'week',
  'month',
  'year',
  'activity',
  'languages',
  'projects',
  'sessions',
  'calendar',
  'insights',
  'privacy',
  'wrapped',
] as const;

export type DashboardPage = (typeof DASHBOARD_PAGES)[number];

/** `true` when a value is one of the known pages. */
export function isDashboardPage(value: unknown): value is DashboardPage {
  return typeof value === 'string' && (DASHBOARD_PAGES as readonly string[]).includes(value);
}

/** Export formats offered by the dashboard. */
export type ExportFormat = 'json' | 'csv' | 'wrapped';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['json', 'csv', 'wrapped'];

/* -------------------------- messages from the webview -------------------------- */

export interface WebviewReadyMessage {
  type: 'ready';
}

export interface WebviewRefreshMessage {
  type: 'refresh';
}

export interface WebviewOpenSettingsMessage {
  type: 'openSettings';
}

export interface WebviewOpenPrivacyMessage {
  type: 'openPrivacy';
}

export interface WebviewPauseMessage {
  type: 'pauseTracking';
}

export interface WebviewResumeMessage {
  type: 'resumeTracking';
}

export interface WebviewResetMessage {
  type: 'resetStatistics';
}

export interface WebviewNavigateMessage {
  type: 'navigate';
  page: DashboardPage;
}

export interface WebviewSelectYearMessage {
  type: 'selectYear';
  year: number;
}

export interface WebviewExportMessage {
  type: 'export';
  format: ExportFormat;
}

/** Every message the extension host accepts from the webview. */
export type WebviewMessage =
  | WebviewReadyMessage
  | WebviewRefreshMessage
  | WebviewOpenSettingsMessage
  | WebviewOpenPrivacyMessage
  | WebviewPauseMessage
  | WebviewResumeMessage
  | WebviewResetMessage
  | WebviewNavigateMessage
  | WebviewSelectYearMessage
  | WebviewExportMessage;

/* ------------------------- messages sent to the webview ------------------------ */

export interface PayloadMessage {
  type: 'payload';
  payload: DashboardPayload;
}

export interface NavigateMessage {
  type: 'navigate';
  page: DashboardPage;
}

export interface ToastMessage {
  type: 'toast';
  text: string;
  tone: 'info' | 'warn' | 'error';
}

export type HostMessage = PayloadMessage | NavigateMessage | ToastMessage;

/** Handlers implemented by the extension host for webview messages. */
export interface WebviewHandlers {
  onReady(kind: 'panel' | 'sidebar'): void;
  onNavigate(page: DashboardPage, kind: 'panel' | 'sidebar'): void;
  onSelectYear(year: number): void;
  onRefresh(): void;
  onExport(format: ExportFormat): void;
  onOpenSettings(): void;
  onOpenPrivacyDoc(): void;
  onPause(): void;
  onResume(): void;
  onResetStatistics(): void;
}
