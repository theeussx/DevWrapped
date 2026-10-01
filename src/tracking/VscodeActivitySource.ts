/**
 * The only module that listens to VS Code editor events.
 *
 * Its single job is to translate editor events into plain `ActivityEvent`
 * objects. It never reads document text, never records file names and never
 * writes anything: the document key it produces is a salted hash used for
 * de-duplication inside the extension host, and the project id is a salted
 * hash too.
 */

import * as vscode from 'vscode';

import { sanitizeLanguageId } from '../security/Sanitization';
import type { WrappedSettings } from '../types/config';
import type { ActivityEvent, ActivitySource, DocumentSnapshot } from './ActivityTracker';
import type { ProjectResolver } from './ProjectResolver';

export interface VscodeActivitySourceOptions {
  resolver: ProjectResolver;
  settings: () => WrappedSettings;
  /** Injected clock, for tests. */
  now?: () => number;
}

/** URI schemes that never represent the user's own code. */
const IGNORED_SCHEMES = new Set([
  'output',
  'vscode',
  'vscode-terminal',
  'git',
  'gitlens',
  'comment',
  'walkThrough',
  'webview',
  'vscode-webview',
  'chat',
  'chat-editing-snapshot-text-model',
  'vscode-chat-code-block',
]);

export class VscodeActivitySource implements ActivitySource {
  private readonly options: VscodeActivitySourceOptions;
  private readonly now: () => number;
  private focused = vscode.window.state.focused;

  public constructor(options: VscodeActivitySourceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Subscribes to editor events; the returned function removes them all. */
  public listen(handler: (event: ActivityEvent) => void): () => void {
    const subscriptions: vscode.Disposable[] = [];
    const emit = (event: ActivityEvent): void => {
      try {
        handler(event);
      } catch {
        // A tracker failure must never break the editor.
      }
    };

    subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {
          return;
        }
        emit(this.eventFor('editorActivated', editor.document, this.now()));
      })
    );

    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) {
          return;
        }
        emit(this.eventFor('documentChanged', event.document, this.now()));
      })
    );

    subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        emit(this.eventFor('documentSaved', document, this.now()));
      })
    );

    subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        emit(this.eventFor('documentOpened', document, this.now()));
      })
    );

    subscriptions.push(
      vscode.workspace.onDidCreateFiles((event) => {
        const first = event.files[0];
        if (!first) {
          return;
        }
        emit(this.eventForUri('documentCreated', first, this.now()));
      })
    );

    subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        this.focused = state.focused;
        emit({
          kind: 'focusChanged',
          at: this.now(),
          focused: state.focused,
        });
      })
    );

    subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const snapshot = this.currentDocument();
        emit({
          kind: 'workspaceChanged',
          at: this.now(),
          ...(snapshot?.language ? { language: snapshot.language } : {}),
          ...(snapshot?.projectId ? { projectId: snapshot.projectId } : {}),
          ...(snapshot?.projectName ? { projectName: snapshot.projectName } : {}),
        });
      })
    );

    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };
  }

  public currentDocument(): DocumentSnapshot | undefined {
    const document = this.activeDocument();
    if (!document) {
      return undefined;
    }
    return this.snapshotFor(document);
  }

  public isFocused(): boolean {
    return this.focused || vscode.window.state.focused;
  }

  /**
   * Cheap change signal: document identity, version and editor selection.
   *
   * The value lives only in memory; it is compared, never stored.
   */
  public stateSnapshot(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return 'none';
    }
    const document = editor.document;
    if (this.shouldIgnore(document)) {
      return 'ignored';
    }
    const key = this.options.resolver.documentKey(document.uri) ?? 'anon';
    const selection = editor.selections[0];
    const selectionKey = selection ? `${selection.active.line}:${selection.active.character}` : '0:0';
    return `${key}|${document.version}|${document.isDirty ? 'dirty' : 'clean'}|${selectionKey}`;
  }

  /* -------------------------------- private ------------------------------- */

  private activeDocument(): vscode.TextDocument | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && !this.shouldIgnore(editor.document)) {
      return editor.document;
    }
    return undefined;
  }

  private shouldIgnore(document: vscode.TextDocument): boolean {
    if (IGNORED_SCHEMES.has(document.uri.scheme)) {
      return true;
    }
    if (document.isUntitled) {
      return true;
    }
    // The settings output, the extension log and other internal documents.
    if (document.uri.path.endsWith('.log') && document.uri.scheme !== 'file') {
      return true;
    }
    return false;
  }

  private eventFor(
    kind: ActivityEvent['kind'],
    document: vscode.TextDocument,
    at: number
  ): ActivityEvent {
    if (this.shouldIgnore(document)) {
      return { kind, at };
    }
    return this.eventForUri(kind, document.uri, at, document.languageId);
  }

  private eventForUri(
    kind: ActivityEvent['kind'],
    uri: vscode.Uri,
    at: number,
    languageId?: string
  ): ActivityEvent {
    const resolver = this.options.resolver;
    const project = resolver.resolve(uri);
    const settings = this.options.settings();
    const event: ActivityEvent = { kind, at };
    const language = languageId ? sanitizeLanguageId(languageId) : undefined;
    if (settings.trackLanguages && language) {
      event.language = language;
    }
    if (settings.trackProjects && project.id) {
      event.projectId = project.id;
      if (project.name) {
        event.projectName = project.name;
      }
    }
    const documentKey = resolver.documentKey(uri);
    if (documentKey) {
      event.documentKey = documentKey;
    }
    return event;
  }

  private snapshotFor(document: vscode.TextDocument): DocumentSnapshot {
    const settings = this.options.settings();
    const project = this.options.resolver.resolve(document.uri);
    const snapshot: DocumentSnapshot = {
      documentKey: this.options.resolver.documentKey(document.uri),
      language: settings.trackLanguages ? sanitizeLanguageId(document.languageId) : undefined,
    };
    if (settings.trackProjects && project.id) {
      snapshot.projectId = project.id;
      snapshot.projectName = project.name;
    }
    return snapshot;
  }
}
