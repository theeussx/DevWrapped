/**
 * Dev Wrapped — entry point.
 *
 * The composition root: it wires the storage, the activity tracker, the
 * analytics service, the dashboard and the command layer together, and owns
 * the two pieces of UI that live outside the webview (the status bar item and
 * the notifications).
 *
 * Nothing here reads source code, file names or document contents: the only
 * inputs are editor events, the settings and the local database.
 */

import * as vscode from 'vscode';

import { buildDashboardPayload, type DashboardInput } from './analytics/StatsService';
import { buildWrapped } from './analytics/Wrapped';
import { computeStreaks } from './analytics/Streaks';
import type { StatsSource } from './analytics/Aggregator';
import { COMMAND_IDS, registerCommands, updateTrackingContext } from './commands/commands';
import { onDidChangeSettings, openExtensionSettings, readSettings, displayLocale, weekStartsOn } from './config';
import { Storage } from './storage/Storage';
import { TransferService } from './storage/TransferService';
import { ActivityTracker } from './tracking/ActivityTracker';
import { ProjectResolver } from './tracking/ProjectResolver';
import { VscodeActivitySource } from './tracking/VscodeActivitySource';
import type { DashboardPage, DashboardPayload, WebviewHandlers } from './types/dashboard';
import type { StatusPayload, WrappedSettings } from './types/config';
import { Logger } from './utils/log';
import { dateKey, MS_PER_MINUTE } from './utils/time';
import { DashboardController } from './webview/Dashboard';

/** How long activity is accumulated before it is written to disk. */
const FLUSH_DELAY_MS = 5_000;
/** How long after a flush the dashboard is refreshed (throttle). */
const REFRESH_DELAY_MS = 1_500;
/** Debounce for refreshes triggered by an event (for example saving a file). */
const EVENT_REFRESH_DELAY_MS = 4_000;

/** Hooks that run when the extension host shuts down. */
const shutdownHooks: Array<() => Promise<void> | void> = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const version = readExtensionVersion(context);

  /* ------------------------------- logging ------------------------------- */

  const output = vscode.window.createOutputChannel('Code Wrapped');
  context.subscriptions.push(output);
  const logger = new Logger({
    sink: { appendLine: (line) => output.appendLine(line) },
    debugEnabled: () => {
      try {
        return readSettings().debugLogging;
      } catch {
        return false;
      }
    },
  });
  logger.info(`Dev Wrapped ${version} activated (local statistics only, no network access).`);

  /* ------------------------------- storage ------------------------------- */

  const storage = await Storage.create({
    storageDirectory: (context.storageUri ?? context.globalStorageUri).fsPath,
    globalState: context.globalState,
    logger,
    retentionDays: () => readSettings().sessionRetentionDays,
  });
  logger.debug(`Database: ${storage.describe()} · ${storage.paths.dataFile}`);
  for (const issue of storage.loadOutcome.issues.slice(0, 5)) {
    logger.warn(`Database note: ${issue}`);
  }
  if (storage.loadOutcome.quarantined) {
    logger.warn(`An unreadable database file was kept aside: ${storage.loadOutcome.quarantined}`);
  }

  let userPaused = storage.userPaused;
  let selectedYear = new Date().getFullYear();
  let lastPayload: DashboardPayload | undefined;
  let lastSignature = '';
  let refreshTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;

  /* ------------------------------- tracker ------------------------------- */

  const resolver = new ProjectResolver(storage.privacySalt, readSettings().trackProjects);
  const source = new VscodeActivitySource({ resolver, settings: readSettings });
  const tracker = new ActivityTracker({
    source,
    settings: readSettings,
    onDelta: (delta) => {
      storage.applyDelta(delta);
      scheduleFlush();
    },
    onStateChange: () => {
      updateStatusBar();
      scheduleRefresh(EVENT_REFRESH_DELAY_MS);
    },
    onSessionEnded: (summary) => {
      logger.debug(
        `Session ended: ${Math.round(summary.activeMs / 60000)} active minute(s) over ${Math.round(
          (summary.endTime - summary.startTime) / 60000
        )} minute(s).`
      );
    },
    logger,
  });
  context.subscriptions.push({ dispose: () => tracker.dispose() });

  /* ------------------------------- dashboard ----------------------------- */

  const handlers: WebviewHandlers = {
    onReady: (kind) => {
      logger.debug(`Dashboard ready (${kind}).`);
      pushDashboard(true);
    },
    onNavigate: (page) => {
      if (page === 'wrapped') {
        void storage.setLastWrappedYear(selectedYear);
      }
      pushDashboard(true);
    },
    onSelectYear: (year) => {
      selectedYear = year;
      pushDashboard(true);
    },
    onRefresh: () => {
      pushDashboard(true);
    },
    onExport: (format) => {
      void transfer.exportData(format);
    },
    onOpenSettings: () => {
      void openExtensionSettings();
    },
    onOpenPrivacyDoc: () => {
      controller.show('privacy');
      pushDashboard(true);
    },
    onPause: () => {
      void pauseTracking();
    },
    onResume: () => {
      void resumeTracking();
    },
    onResetStatistics: () => {
      void transfer.resetStatistics();
    },
  };

  const controller = new DashboardController(context, handlers, logger);
  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(DashboardController.viewType, controller, {
      webviewOptions: { retainContextWhenHidden: false },
    })
  );

  /* -------------------------------- status ------------------------------- */

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = COMMAND_IDS.openDashboard;
  statusBar.name = 'Code Wrapped';
  context.subscriptions.push(statusBar);

  /* ------------------------------- transfer ------------------------------ */

  const transfer = new TransferService({
    storage,
    version: () => version,
    locale: () => displayLocale(),
    logger,
    settings: readSettings,
    wrappedPayload: () => lastPayload?.wrapped ?? buildWrappedNow(),
    onDataChanged: () => {
      pushDashboard(true);
    },
  });

  /* -------------------------------- helpers ------------------------------ */

  function statsSource(settings: WrappedSettings): StatsSource {
    const live = tracker.liveContribution();
    return {
      data: storage.data,
      now: Date.now(),
      locale: displayLocale(),
      weekStartsOn: weekStartsOn(),
      minimumActiveTimeMs: Math.max(1, settings.minimumActiveTime) * MS_PER_MINUTE,
      ...(live ? { live } : {}),
    };
  }

  function buildStatus(settings: WrappedSettings): StatusPayload {
    const status = tracker.status();
    const todayKey = dateKey(Date.now());
    const streaks = computeStreaks(statsSource(settings), { windowDays: 2 });
    const tracking: StatusPayload['tracking'] = {
      enabled: !userPaused,
      paused: userPaused,
      sessionActive: tracker.isSessionActive,
      sessionActiveTime: status.sessionActiveTime,
      todayActiveTime: storage.data.days[todayKey]?.activeTime ?? 0,
      idleTimeoutMinutes: settings.inactivityTimeout,
      minimumActiveTimeMinutes: settings.minimumActiveTime,
    };
    if (status.reason !== undefined) {
      tracking.reason = status.reason;
    }
    if (status.sessionStart !== undefined) {
      tracking.sessionStart = status.sessionStart;
    }
    return { tracking, currentStreak: streaks.current, version };
  }

  function describeStorage() {
    return {
      directory: storage.paths.directory,
      dataFile: storage.paths.dataFile,
      backupFile: storage.paths.backupFile,
      bytes: storage.sizeBytes,
    };
  }

  function buildInput(): DashboardInput {
    const settings = readSettings();
    const live = tracker.liveContribution();
    return {
      data: storage.data,
      settings,
      now: Date.now(),
      locale: displayLocale(),
      weekStartsOn: weekStartsOn(),
      year: selectedYear,
      version,
      status: buildStatus(settings),
      storage: describeStorage(),
      ...(live ? { live } : {}),
    };
  }

  function buildWrappedNow() {
    const settings = readSettings();
    return buildWrapped(statsSource(settings), selectedYear);
  }

  function pushDashboard(force = false): void {
    if (!force && !controller.isOpen) {
      return;
    }
    try {
      const payload = buildDashboardPayload(buildInput());
      const signature = payloadSignature(payload);
      if (!force && signature === lastSignature) {
        return;
      }
      lastSignature = signature;
      lastPayload = payload;
      controller.update(payload);
      updateStatusBar();
    } catch (error) {
      logger.error('Could not build the dashboard payload.', (error as Error).message);
    }
  }

  /**
   * Cheap fingerprint of a payload.
   *
   * The dashboard is rebuilt at most once per throttle window and only pushed
   * when this signature changed, which keeps the webview quiet while the user
   * is not producing new activity.
   */
  function payloadSignature(payload: DashboardPayload): string {
    return [
      payload.year,
      payload.settings.inactivityTimeout,
      payload.settings.minimumActiveTime,
      payload.privacy.stored.days,
      payload.privacy.stored.sessions,
      payload.privacy.stored.projects,
      Math.floor(payload.status.tracking.todayActiveTime / 30_000),
      Math.floor(payload.status.tracking.sessionActiveTime / 30_000),
      payload.status.tracking.paused ? 'p' : 'a',
      payload.sessions.total,
      payload.version,
    ].join('|');
  }

  function scheduleRefresh(delayMs: number): void {
    if (!controller.isOpen) {
      return;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      pushDashboard();
    }, delayMs);
    refreshTimer.unref?.();
  }

  function scheduleFlush(delayMs = FLUSH_DELAY_MS): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      storage.flush().then(
        () => scheduleRefresh(REFRESH_DELAY_MS),
        (error: unknown) => logger.error('Could not save local statistics.', (error as Error).message)
      );
    }, delayMs);
    flushTimer.unref?.();
  }

  function updateStatusBar(): void {
    const settings = readSettings();
    if (!settings.showStatusBar) {
      statusBar.hide();
      return;
    }
    const todayKey = dateKey(Date.now());
    const stored = storage.data.days[todayKey]?.activeTime ?? 0;
    const live = tracker.liveContribution();
    const total = stored + (live && live.date === todayKey ? live.ms : 0);
    const minutes = Math.floor(total / MS_PER_MINUTE);
    const hours = Math.floor(minutes / 60);
    const label = minutes === 0 ? 'no activity yet' : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
    const streaks = computeStreaks(statsSource(settings), { windowDays: 2 });
    statusBar.text = `$(graph) ${label}`;
    statusBar.tooltip = [
      `Code Wrapped — today: ${label}`,
      `Current streak: ${streaks.current} day${streaks.current === 1 ? '' : 's'}`,
      userPaused ? 'Tracking is paused. Click to open the dashboard.' : 'Tracking active · local and private',
    ].join('\n');
    statusBar.show();
  }

  /* ------------------------------ pause/resume ---------------------------- */

  async function pauseTracking(): Promise<void> {
    tracker.pause('user');
    userPaused = true;
    await storage.setUserPaused(true);
    await updateTrackingContext(true);
    await storage.flush();
    updateStatusBar();
    pushDashboard(true);
    if (readSettings().enableNotifications) {
      void vscode.window.showInformationMessage('Dev Wrapped: tracking paused.');
    }
  }

  async function resumeTracking(): Promise<void> {
    userPaused = false;
    await storage.setUserPaused(false);
    await updateTrackingContext(false);
    tracker.start();
    tracker.resume();
    updateStatusBar();
    pushDashboard(true);
    if (readSettings().enableNotifications) {
      void vscode.window.showInformationMessage('Dev Wrapped: tracking resumed.');
    }
  }

  /* ------------------------------- commands ------------------------------ */

  registerCommands(context, {
    showDashboard: (page?: DashboardPage) => {
      const target = page ?? 'overview';
      if (controller.isOpen) {
        controller.show(target);
      } else {
        controller.show(target);
      }
      if (target === 'wrapped') {
        void storage.setLastWrappedYear(selectedYear);
      }
      pushDashboard(true);
    },
    openPrivacy: () => {
      controller.show('privacy');
      pushDashboard(true);
    },
    openSettings: () => {
      void openExtensionSettings();
    },
    exportData: (format) => transfer.exportData(format),
    exportWrapped: async () => {
      await transfer.exportWrapped();
    },
    importData: () => transfer.importData(),
    resetStatistics: () => transfer.resetStatistics(),
    pauseTracking,
    resumeTracking,
    refresh: async () => {
      await storage.flush();
      pushDashboard(true);
      controller.toast('Statistics refreshed.');
    },
    showLogs: () => output.show(true),
    isPaused: () => userPaused,
  });

  /* ----------------------------- configuration --------------------------- */

  context.subscriptions.push(
    onDidChangeSettings((settings) => {
      resolver.setEnabled(settings.trackProjects);
      tracker.applySettings();
      storage.setRetentionDays(settings.sessionRetentionDays);
      updateStatusBar();
      pushDashboard(true);
    })
  );

  /* -------------------------------- startup ------------------------------ */

  await updateTrackingContext(userPaused);
  if (!userPaused) {
    tracker.start();
  } else {
    tracker.pause('user');
  }
  updateStatusBar();
  pushDashboard(true);

  if (!storage.onboarded) {
    await showWelcomeFlow();
  } else if (!userPaused) {
    maybeAnnounceRetrospective();
  }

  shutdownHooks.push(async () => {
    tracker.dispose();
    await storage.flush();
  });

  /* --------------------------------- flows -------------------------------- */

  /** First-run consent: tracking never starts silently. */
  async function showWelcomeFlow(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'Welcome to Dev Wrapped.',
      {
        modal: true,
        detail:
          'Your coding journey starts now.\n\nDev Wrapped stores time, language ids and workspace folder names on this machine only. Source code, file names, paths, terminal commands and environment variables are never read. There is no account and no network access.',
      },
      'Start tracking',
      'Privacy details',
      'Not now'
    );
    await storage.setOnboarded(true);

    if (choice === 'Privacy details') {
      controller.show('privacy');
      pushDashboard(true);
      if (!userPaused) {
        tracker.start();
      }
      return;
    }
    if (choice === 'Start tracking') {
      await resumeTracking();
      controller.show('overview');
      void vscode.window.showInformationMessage(
        'Dev Wrapped is tracking. Run "Code Wrapped: Pause Tracking" any time to stop.'
      );
      return;
    }

    // "Not now" (or dismissed): stay paused until the user asks for it.
    await pauseTracking();
    void vscode.window.showInformationMessage(
      'Dev Wrapped is installed but not tracking. Run "Code Wrapped: Resume Tracking" whenever you are ready.'
    );
  }

  /** One notice when last year's retrospective becomes available. */
  function maybeAnnounceRetrospective(): void {
    const settings = readSettings();
    if (!settings.enableNotifications) {
      return;
    }
    const previousYear = new Date().getFullYear() - 1;
    const hasData = Object.keys(storage.data.days).some(
      (key) => key.startsWith(`${previousYear}-`) && (storage.data.days[key]?.activeTime ?? 0) > 0
    );
    if (!hasData || storage.lastWrappedYear === previousYear) {
      return;
    }
    void vscode.window
      .showInformationMessage(`Your ${previousYear} Code Wrapped retrospective is ready.`, 'Open Wrapped', 'Not now')
      .then((answer) => {
        if (answer === 'Open Wrapped') {
          selectedYear = previousYear;
          controller.show('wrapped');
          void storage.setLastWrappedYear(previousYear).then(() => pushDashboard(true));
        }
      })
      .then(undefined, () => undefined);
  }
}

export async function deactivate(): Promise<void> {
  const hooks = [...shutdownHooks].reverse();
  shutdownHooks.length = 0;
  for (const hook of hooks) {
    try {
      await hook();
    } catch {
      // Shutdown must never throw.
    }
  }
}

/** Extension version, from the manifest (never from a hard coded string). */
function readExtensionVersion(context: vscode.ExtensionContext): string {
  const version = (context.extension.packageJSON as { version?: unknown }).version;
  return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
}
