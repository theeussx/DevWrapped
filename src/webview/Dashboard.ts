/**
 * The dashboard host: one editor panel plus one Activity Bar view.
 *
 * Both render the same webview application, but they are independent
 * instances. Hardening applied here:
 *
 *  - `localResourceRoots` is limited to the `media` folder of the extension;
 *  - scripts run only with a per-load nonce;
 *  - inline styles, remote origins, frames, workers and connections are all
 *    blocked by the Content Security Policy;
 *  - forms and command URIs are disabled;
 *  - every message coming back is validated (`parseWebviewMessage`).
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import { isDashboardPage, type DashboardPayload, type DashboardPage, type HostMessage } from '../types/dashboard';
import type { Logger } from '../utils/log';
import type { WebviewHandlers } from '../types/dashboard';
import { describeRejectedMessage, parseWebviewMessage } from './messages';

/** Webview kind, used for logging and for "where is the dashboard open?". */
export type WebviewKind = 'panel' | 'sidebar';

/** Files loaded into the webview, in load order (globals depend on each other). */
export const MEDIA_FILES = {
  styles: 'dashboard.css',
  scripts: ['charts.js', 'format.js', 'ui.js', 'pages.js', 'dashboard.js'],
} as const;

export class DashboardController implements vscode.WebviewViewProvider, vscode.Disposable {
  /** Activity Bar view id (must match `package.json`). */
  public static readonly viewType = 'codeWrapped.sidebar';
  /** Editor panel type, used for `vscode.window.createWebviewPanel`. */
  public static readonly panelType = 'codeWrapped.dashboard';

  private readonly handlers: WebviewHandlers;
  private readonly logger: Logger | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private view: vscode.WebviewView | undefined;
  private payload: DashboardPayload | undefined;
  private pendingPage: DashboardPage | undefined;
  private ready = { panel: false, sidebar: false };

  public constructor(context: vscode.ExtensionContext, handlers: WebviewHandlers, logger?: Logger) {
    this.handlers = handlers;
    this.logger = logger;
    this.context = context;
  }

  private readonly context: vscode.ExtensionContext;

  /* ------------------------------- public API ------------------------------ */

  /** `true` when any webview is currently mounted. */
  public get isOpen(): boolean {
    return this.panel !== undefined || this.view !== undefined;
  }

  /** Opens (or reveals) the editor panel and shows a page. */
  public show(page: DashboardPage = 'overview'): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
      this.navigate(page);
      return;
    }
    this.pendingPage = page;
    const panel = vscode.window.createWebviewPanel(
      DashboardController.panelType,
      'Code Wrapped Dashboard',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icons', 'wrapped.svg');
    this.attachPanel(panel);
    panel.webview.html = this.buildHtml(panel.webview);
  }

  /** Posts a navigation message to every mounted webview. */
  public navigate(page: DashboardPage): void {
    if (!isDashboardPage(page)) {
      return;
    }
    this.send({ type: 'navigate', page });
  }

  /** Shows a short message inside the dashboard. */
  public toast(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    if (text.length === 0) {
      return;
    }
    this.send({ type: 'toast', text: text.slice(0, 300), tone });
  }

  /** Sends the read model to every mounted webview. */
  public update(payload: DashboardPayload): void {
    this.payload = payload;
    this.send({ type: 'payload', payload });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.view = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /* --------------------------- WebviewViewProvider -------------------------- */

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.title = 'Dashboard';
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message, 'sidebar'));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.flushPending();
      }
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.ready.sidebar = false;
    });
  }

  /* -------------------------------- internals ------------------------------- */

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message, 'panel'));
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        this.flushPending();
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready.panel = false;
    });
  }

  /** Delivers the payload (and a pending navigation) once a webview is ready. */
  private flushPending(): void {
    if (this.payload && (this.ready.panel || this.ready.sidebar)) {
      this.send({ type: 'payload', payload: this.payload });
    }
    if (this.pendingPage) {
      const page = this.pendingPage;
      this.pendingPage = undefined;
      this.navigate(page);
    }
  }

  private send(message: HostMessage): void {
    void this.postTo(this.panel?.webview, message);
    void this.postTo(this.view?.webview, message);
  }

  private async postTo(webview: vscode.Webview | undefined, message: HostMessage): Promise<void> {
    if (!webview) {
      return;
    }
    try {
      await webview.postMessage(message);
    } catch (error) {
      this.logger?.debug('Could not post a message to the dashboard.', (error as Error).message);
    }
  }

  private handleMessage(raw: unknown, kind: WebviewKind): void {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.logger?.debug(`Ignored an invalid dashboard message (${describeRejectedMessage(raw)}).`);
      return;
    }
    try {
      switch (message.type) {
        case 'ready':
          this.ready[kind] = true;
          this.handlers.onReady(kind);
          this.flushPending();
          return;
        case 'refresh':
          this.handlers.onRefresh();
          return;
        case 'navigate':
          this.handlers.onNavigate(message.page, kind);
          return;
        case 'selectYear':
          this.handlers.onSelectYear(message.year);
          return;
        case 'export':
          this.handlers.onExport(message.format);
          return;
        case 'openSettings':
          this.handlers.onOpenSettings();
          return;
        case 'openPrivacy':
          this.handlers.onOpenPrivacyDoc();
          return;
        case 'pauseTracking':
          this.handlers.onPause();
          return;
        case 'resumeTracking':
          this.handlers.onResume();
          return;
        case 'resetStatistics':
          this.handlers.onResetStatistics();
          return;
        default:
          return;
      }
    } catch (error) {
      this.logger?.error('Dashboard message handler failed.', (error as Error).message);
    }
  }

  /** Builds the webview document with a fresh nonce and a strict CSP. */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, MEDIA_FILES.styles));
    const scripts = MEDIA_FILES.scripts.map((file) =>
      webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file))
    );

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "connect-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');

    const scriptTags = scripts
      .map((uri) => `<script nonce="${nonce}" src="${uri.toString()}"></script>`)
      .join('\n    ');

    return `<!DOCTYPE html>
<html lang="${escapeAttribute(vscode.env.language || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styles.toString()}">
  <title>Code Wrapped Dashboard</title>
</head>
<body>
  <div id="app" class="cw-app" data-state="loading">
    <div class="cw-boot">
      <div class="cw-boot-title">Dev Wrapped</div>
      <p class="cw-boot-text">Loading your local statistics…</p>
    </div>
  </div>
  <script nonce="${nonce}">
    window.__CODE_WRAPPED_BOOT__ = { nonce: "${nonce}" };
  </script>
  ${scriptTags}
</body>
</html>`;
  }
}

/** Random per-load nonce; every script tag must carry it. */
export function createNonce(): string {
  return randomBytes(24).toString('base64');
}

/** Minimal attribute escaping for values that come from the environment. */
function escapeAttribute(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'en';
}
