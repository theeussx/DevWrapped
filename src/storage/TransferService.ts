/**
 * Import, export and reset flows.
 *
 * Every one of these operations is user initiated and nothing is ever erased
 * before it has been validated and confirmed:
 *
 *  - export writes to the location the user picks (JSON backup, CSV folder or
 *    a standalone retrospective);
 *  - import validates first, shows what was found, asks for confirmation and
 *    takes a safety copy before replacing anything;
 *  - reset asks for a modal confirmation *and* a typed word, then keeps a
 *    safety copy of the previous file.
 */

import * as vscode from 'vscode';

import type { WrappedPayload } from '../types/analytics';
import type { WrappedSettings } from '../types/config';
import { sanitizeFileName } from '../security/Sanitization';
import type { Logger } from '../utils/log';
import { formatBytes, formatDuration, formatNumber } from '../utils/format';
import { buildCsvExports, buildJsonBackup } from './Exporter';
import { describeImport, previewImport } from './Importer';
import type { Storage } from './Storage';
import { buildWrappedHtml } from './WrappedExport';

export type ExportFormat = 'json' | 'csv' | 'wrapped';

export interface TransferServiceOptions {
  storage: Storage;
  version: () => string;
  locale: () => string;
  logger: Logger;
  settings: () => WrappedSettings;
  /** Retrospective of the selected year, built on demand. */
  wrappedPayload: () => WrappedPayload;
  /** Called after data changed (import/reset) so the dashboard refreshes. */
  onDataChanged: () => void;
}

export class TransferService {
  private readonly options: TransferServiceOptions;

  public constructor(options: TransferServiceOptions) {
    this.options = options;
  }

  /** Entry point used by the "Export Data" command (with a format picker). */
  public async exportData(format?: ExportFormat): Promise<void> {
    const chosen =
      format ??
      (await vscode.window.showQuickPick(
        [
          { label: 'JSON backup', description: 'Everything, re-importable on any machine', value: 'json' as const },
          { label: 'CSV files', description: 'Daily, sessions, languages and projects for spreadsheets', value: 'csv' as const },
          { label: 'Code Wrapped (HTML)', description: 'A standalone retrospective page', value: 'wrapped' as const },
        ],
        { title: 'Export Dev Wrapped data', placeHolder: 'Choose an export format' }
      ))?.value;

    if (!chosen) {
      return;
    }
    switch (chosen) {
      case 'csv':
        await this.exportCsv();
        return;
      case 'wrapped':
        await this.exportWrapped();
        return;
      case 'json':
      default:
        await this.exportJson();
        return;
    }
  }

  /** Writes a complete JSON backup. */
  public async exportJson(): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({
      title: 'Export Dev Wrapped data',
      saveLabel: 'Export',
      filters: { JSON: ['json'] },
      defaultUri: defaultUri(`code-wrapped-${stamp}.json`),
    });
    if (!target) {
      return;
    }
    const content = buildJsonBackup(this.options.storage.data, {
      version: this.options.version(),
      now: Date.now(),
      locale: this.options.locale(),
    });
    await writeFile(target, content);
    await this.notify(`Backup exported to ${displayPath(target)} (${formatBytes(Buffer.byteLength(content, 'utf8'))}).`);
    this.options.logger.info('JSON backup exported.');
  }

  /** Writes the CSV exports into a folder chosen by the user. */
  public async exportCsv(): Promise<void> {
    const folders = await vscode.window.showOpenDialog({
      title: 'Choose a folder for the CSV exports',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Export here',
    });
    const folder = folders?.[0];
    if (!folder) {
      return;
    }
    const files = buildCsvExports(this.options.storage.data);
    for (const file of files) {
      const name = sanitizeFileName(file.name, 'code-wrapped');
      await writeFile(vscode.Uri.joinPath(folder, name), file.content);
    }
    await this.notify(`Exported ${files.length} CSV file(s) to ${displayPath(folder)}.`);
    this.options.logger.info('CSV export written.');
  }

  /** Writes the standalone retrospective for the selected year. */
  public async exportWrapped(): Promise<void> {
    const payload = this.options.wrappedPayload();
    if (!payload.available) {
      await showInformation(payload.message ?? 'There is no activity recorded for that year yet.');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: `Export Code Wrapped ${payload.year}`,
      saveLabel: 'Export',
      filters: { HTML: ['html'] },
      defaultUri: defaultUri(sanitizeFileName(`code-wrapped-${payload.year}.html`, 'code-wrapped.html')),
    });
    if (!target) {
      return;
    }
    const html = buildWrappedHtml(payload, {
      version: this.options.version(),
      generatedAt: Date.now(),
      locale: this.options.locale(),
    });
    await writeFile(target, html);
    await this.notify(`Code Wrapped ${payload.year} exported to ${displayPath(target)}.`);
    this.options.logger.info(`Retrospective ${payload.year} exported.`);
  }

  /* --------------------------------- import --------------------------------- */

  /** Imports a backup after validating it and confirming with the user. */
  public async importData(): Promise<void> {
    const selection = await vscode.window.showOpenDialog({
      title: 'Import Dev Wrapped data',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
      openLabel: 'Validate and import',
    });
    const file = selection?.[0];
    if (!file) {
      return;
    }

    let text: string;
    try {
      const stat = await vscode.workspace.fs.stat(file);
      if (stat.size > 64 * 1024 * 1024) {
        await showError('The selected file is larger than the 64 MB import limit.');
        return;
      }
      text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    } catch (error) {
      await showError(`Could not read the file: ${(error as Error).message}`);
      return;
    }

    const preview = previewImport(text, {
      now: Date.now(),
      retentionDays: this.options.settings().sessionRetentionDays,
    });

    if (!preview.ok) {
      const detail = preview.forbiddenKeys.length > 0 ? preview.forbiddenKeys.slice(0, 8).join(', ') : undefined;
      await showError(preview.error ?? 'The file could not be imported.', detail);
      this.options.logger.warn('Import refused.', preview.error);
      return;
    }

    const summary = describeImport(preview);
    const warnings =
      preview.warnings.length > 0
        ? `\n\nNotes:\n${preview.warnings.slice(0, 6).join('\n')}${preview.warnings.length > 6 ? '\n…' : ''}`
        : '';
    const currentStat = this.options.storage.stat();
    const answer = await vscode.window.showWarningMessage(
      `Import ${formatNumber(preview.stats.days)} day(s) of data?`,
      {
        modal: true,
        detail: `${summary}\n\nThe current data (${formatNumber(currentStat.days)} day(s), ${formatNumber(
          currentStat.sessions
        )} session(s)) will be replaced. A safety copy is written first.${warnings}`,
      },
      'Import and replace'
    );
    if (answer !== 'Import and replace') {
      return;
    }

    try {
      const copy = await this.options.storage.createSafetyCopy('before-import');
      await this.options.storage.replaceAll(preview.data!);
      this.options.onDataChanged();
      this.options.logger.info('Import completed.');
      await this.notify(
        `Imported ${formatNumber(preview.stats.days)} day(s) · ${formatDuration(preview.stats.activeTimeMs)} of activity. Safety copy: ${displayPathFromString(copy)}`
      );
    } catch (error) {
      this.options.logger.error('Import failed.', (error as Error).message);
      await showError(`The import failed: ${(error as Error).message}`);
    }
  }

  /* ---------------------------------- reset --------------------------------- */

  /** Deletes every statistic after a modal confirmation and a typed word. */
  public async resetStatistics(): Promise<void> {
    const stat = this.options.storage.stat();
    const first = await vscode.window.showWarningMessage(
      'Reset all Dev Wrapped statistics?',
      {
        modal: true,
        detail: `${formatNumber(stat.days)} day(s), ${formatNumber(stat.sessions)} session(s) and ${formatNumber(
          stat.projects
        )} project(s) will be deleted permanently.\n\nA safety copy of the current file is kept in the extension storage folder. Tracking continues from zero.`,
      },
      'Continue'
    );
    if (first !== 'Continue') {
      return;
    }

    const typed = await vscode.window.showInputBox({
      title: 'Reset Dev Wrapped statistics',
      prompt: 'This cannot be undone. Type RESET to confirm.',
      placeHolder: 'RESET',
      ignoreFocusOut: true,
      validateInput: (value) => (value === 'RESET' ? undefined : 'Type RESET (in capitals) to confirm.'),
    });
    if (typed !== 'RESET') {
      return;
    }

    try {
      const copy = await this.options.storage.reset();
      this.options.onDataChanged();
      this.options.logger.info('Statistics reset by the user.');
      await this.notify(`All statistics were reset. A safety copy was kept at ${displayPathFromString(copy)}.`);
    } catch (error) {
      this.options.logger.error('Reset failed.', (error as Error).message);
      await showError(`The reset failed: ${(error as Error).message}`);
    }
  }

  /* --------------------------------- helpers -------------------------------- */

  private async notify(message: string): Promise<void> {
    await vscode.window.showInformationMessage(`Dev Wrapped: ${message}`);
  }
}

/** Writes text through the workspace file system (works for remote windows). */
async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

/** Default location for a save dialog: the first workspace folder, or home. */
function defaultUri(fileName: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    return vscode.Uri.joinPath(folder.uri, sanitizeFileName(fileName));
  }
  return vscode.Uri.file(sanitizeFileName(fileName));
}

/** Short, safe display of a file system path. */
function displayPath(uri: vscode.Uri): string {
  const path = uri.fsPath || uri.path;
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0);
  const tail = parts.slice(-2).join('/');
  return tail.length > 0 ? tail : path;
}

/** Short display of a path string (used for safety copies). */
function displayPathFromString(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0);
  return parts.slice(-1)[0] ?? path;
}

async function showInformation(message: string): Promise<void> {
  await vscode.window.showInformationMessage(`Dev Wrapped: ${message}`);
}

async function showError(message: string, detail?: string): Promise<void> {
  const selection = await vscode.window.showErrorMessage(`Dev Wrapped: ${message}`, 'Show logs');
  if (selection === 'Show logs') {
    await vscode.commands.executeCommand('codeWrapped.showLogs');
  }
  void detail;
}
