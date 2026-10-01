/**
 * Configuration access.
 *
 * This is one of the few modules that touches the VS Code API; everything else
 * receives plain values. Every read is validated against the documented option
 * sets, so a hand edited `settings.json` can never break the tracker.
 */

import * as vscode from 'vscode';

import {
  DEFAULT_SETTINGS,
  INACTIVITY_TIMEOUT_OPTIONS,
  MINIMUM_ACTIVE_TIME_OPTIONS,
  SESSION_RETENTION_OPTIONS,
  snapToOption,
  type WrappedSettings,
} from './types/config';

export { snapToOption };
export const CONFIG_SECTION = 'codeWrapped';

/** Reads every `codeWrapped.*` setting, repairing invalid values silently. */
export function readSettings(): WrappedSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const readBoolean = (key: keyof WrappedSettings, fallback: boolean): boolean => {
    const value = configuration.get<unknown>(key);
    return typeof value === 'boolean' ? value : fallback;
  };
  return {
    inactivityTimeout: snapToOption(
      configuration.get<unknown>('inactivityTimeout'),
      INACTIVITY_TIMEOUT_OPTIONS,
      DEFAULT_SETTINGS.inactivityTimeout
    ),
    minimumActiveTime: snapToOption(
      configuration.get<unknown>('minimumActiveTime'),
      MINIMUM_ACTIVE_TIME_OPTIONS,
      DEFAULT_SETTINGS.minimumActiveTime
    ),
    sessionRetentionDays: snapToOption(
      configuration.get<unknown>('sessionRetentionDays'),
      SESSION_RETENTION_OPTIONS,
      DEFAULT_SETTINGS.sessionRetentionDays
    ),
    trackLanguages: readBoolean('trackLanguages', DEFAULT_SETTINGS.trackLanguages),
    trackProjects: readBoolean('trackProjects', DEFAULT_SETTINGS.trackProjects),
    enableNotifications: readBoolean('enableNotifications', DEFAULT_SETTINGS.enableNotifications),
    debugLogging: readBoolean('debugLogging', DEFAULT_SETTINGS.debugLogging),
    showStatusBar: readBoolean('showStatusBar', DEFAULT_SETTINGS.showStatusBar),
  };
}

/** Subscribes to settings changes for the `codeWrapped` section. */
export function onDidChangeSettings(listener: (settings: WrappedSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      listener(readSettings());
    }
  });
}

/** Opens the Settings UI filtered to this extension. */
export async function openExtensionSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
}

/** Locale used for dates and numbers, from the VS Code display language. */
export function displayLocale(): string {
  const locale = vscode.env.language;
  return typeof locale === 'string' && locale.length > 0 ? locale : 'en';
}

/** First day of the week, following the locale (0 = Sunday, 1 = Monday). */
export function weekStartsOn(): number {
  const locale = displayLocale().toLowerCase();
  // Regions that commonly start the week on Sunday.
  if (/^(en-us|en-ca|ja|ko|zh-tw|he|ar|fa|pt-br|es-mx|es-ar|hi)/.test(locale)) {
    return 0;
  }
  return 1;
}

/** Reads the effective retention window from the settings. */
export function retentionDays(): number {
  return readSettings().sessionRetentionDays;
}
