/**
 * Command layer.
 *
 * Thin and defensive: every command maps to one service call, wraps it in a
 * try/catch so a failure shows a message instead of an unhandled rejection,
 * and keeps the `codeWrapped.trackingPaused` context key in sync so menus and
 * the status bar can react to the pause state.
 */

import * as vscode from 'vscode';

import type { DashboardPage } from '../types/dashboard';
import type { ExportFormat } from '../storage/TransferService';

/** Command ids, mirrored by `package.json` (the manifest is the source of truth). */
export const COMMAND_IDS = {
  openDashboard: 'codeWrapped.openDashboard',
  showToday: 'codeWrapped.showToday',
  showWeek: 'codeWrapped.showWeek',
  showMonth: 'codeWrapped.showMonth',
  showYear: 'codeWrapped.showYear',
  showWrapped: 'codeWrapped.showWrapped',
  pauseTracking: 'codeWrapped.pauseTracking',
  resumeTracking: 'codeWrapped.resumeTracking',
  exportData: 'codeWrapped.exportData',
  exportWrapped: 'codeWrapped.exportWrapped',
  importData: 'codeWrapped.importData',
  resetStatistics: 'codeWrapped.resetStatistics',
  openPrivacy: 'codeWrapped.openPrivacy',
  openSettings: 'codeWrapped.openSettings',
  refresh: 'codeWrapped.refresh',
  showLogs: 'codeWrapped.showLogs',
} as const;

/** Context key set while tracking is paused. */
export const TRACKING_PAUSED_CONTEXT = 'codeWrapped.trackingPaused';

/** Everything the commands need from the rest of the extension. */
export interface CommandServices {
  /** Opens the dashboard on a page (`overview` by default). */
  showDashboard(page?: DashboardPage): void;
  /** Opens the dashboard on the privacy page. */
  openPrivacy(): void;
  /** Opens the settings UI filtered to this extension. */
  openSettings(): void;
  /** Exports data; `format` skips the format picker. */
  exportData(format?: ExportFormat): Promise<void>;
  /** Exports the retrospective of the selected year. */
  exportWrapped(): Promise<void>;
  /** Validates and imports a backup. */
  importData(): Promise<void>;
  /** Deletes every statistic (with confirmations). */
  resetStatistics(): Promise<void>;
  pauseTracking(): Promise<void>;
  resumeTracking(): Promise<void>;
  /** Rebuilds the payload and tells the user it happened. */
  refresh(): Promise<void>;
  /** Reveals the output channel. */
  showLogs(): void;
  /** `true` while the user paused tracking (used for the toggle command). */
  isPaused(): boolean;
}

/** Registers every command; returns the disposables (pushed by the caller). */
export function registerCommands(context: vscode.ExtensionContext, services: CommandServices): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const run = (name: string, task: () => unknown): (() => Promise<void>) => {
    return async () => {
      try {
        await task();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Dev Wrapped: ${name} failed. ${message}`);
      }
    };
  };

  const register = (id: string, task: () => unknown): void => {
    disposables.push(vscode.commands.registerCommand(id, run(id, task)));
  };

  register(COMMAND_IDS.openDashboard, () => services.showDashboard('overview'));
  register(COMMAND_IDS.showToday, () => services.showDashboard('today'));
  register(COMMAND_IDS.showWeek, () => services.showDashboard('week'));
  register(COMMAND_IDS.showMonth, () => services.showDashboard('month'));
  register(COMMAND_IDS.showYear, () => services.showDashboard('year'));
  register(COMMAND_IDS.showWrapped, () => services.showDashboard('wrapped'));
  register(COMMAND_IDS.openPrivacy, () => services.openPrivacy());
  register(COMMAND_IDS.openSettings, () => services.openSettings());
  register(COMMAND_IDS.exportData, () => services.exportData());
  register(COMMAND_IDS.exportWrapped, () => services.exportWrapped());
  register(COMMAND_IDS.importData, () => services.importData());
  register(COMMAND_IDS.resetStatistics, () => services.resetStatistics());
  register(COMMAND_IDS.refresh, () => services.refresh());
  register(COMMAND_IDS.showLogs, () => services.showLogs());

  // Pause/resume share the keyboard shortcut space and stay idempotent, so
  // the command palette entry always does what its label promises.
  register(COMMAND_IDS.pauseTracking, () => services.pauseTracking());
  register(COMMAND_IDS.resumeTracking, () => services.resumeTracking());

  for (const disposable of disposables) {
    context.subscriptions.push(disposable);
  }
  return disposables;
}

/** Keeps the `codeWrapped.trackingPaused` context key in sync. */
export async function updateTrackingContext(paused: boolean): Promise<void> {
  try {
    await vscode.commands.executeCommand('setContext', TRACKING_PAUSED_CONTEXT, paused);
  } catch {
    // The context key is cosmetic: failing to set it must never break tracking.
  }
}

/** Command ids as a plain array (used by tests and diagnostics). */
export function commandIds(): string[] {
  return Object.values(COMMAND_IDS);
}
