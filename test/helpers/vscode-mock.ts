/**
 * In-memory VS Code API for the integration test.
 *
 * `activate()` is the only part of Dev Wrapped that cannot be exercised by the
 * pure unit tests: it imports `vscode`, so it needs a host. This module
 * provides just enough of that host — window, workspace, commands, webviews,
 * mementos, a file system bridge and a fully deterministic clock — for the
 * extension to run under plain Node.
 *
 * Two properties make it trustworthy as a test double:
 *
 *  1. every API the extension calls is implemented for real (files are written
 *     to a temporary directory, webviews post messages through handlers), so a
 *     passing test means the wiring works;
 *  2. the fake documents throw on every content accessor (`getText`, `lineAt`,
 *     …), which turns "Dev Wrapped never reads your code" into an assertion:
 *     the tracker would explode if it ever tried.
 *
 * It is installed by patching the CommonJS loader for the specifier `vscode`,
 * which is the only way to satisfy a `require('vscode')` that has no file on
 * disk. The patch is global for the test process and installed once.
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, normalize, posix, resolve, sep } from 'node:path';

/* ---------------------------------- clock ---------------------------------- */

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;

export interface FakeClock {
  /** Current fake time in epoch milliseconds. */
  now(): number;
  /** Advances time, running every timer that becomes due (in order). */
  advance(ms: number): void;
  /** Lets pending promise chains (microtasks) run. */
  settle(turns?: number): Promise<void>;
  /** How many timers are still armed (used to prove cleanup on shutdown). */
  pending(): { intervals: number; timeouts: number };
  /** Replaces the global timers; call `restore()` when the test is done. */
  install(): void;
  restore(): void;
}

interface IntervalEntry {
  handler: () => void;
  every: number;
  due: number;
  active: boolean;
}

interface TimeoutEntry {
  handler: () => void;
  due: number;
  active: boolean;
}

/** Deterministic replacement for `Date.now`, `setInterval` and `setTimeout`. */
export function createClock(start: number): FakeClock {
  let current = start;
  let nextIntervalId = 1;
  let nextTimeoutId = 1;
  const intervals = new Map<number, IntervalEntry>();
  const timeouts = new Map<number, TimeoutEntry>();

  const originalIsolate = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: realSetTimeout,
    clearTimeout: realClearTimeout,
    dateNow: Date.now,
  };

  function runDue(): void {
    for (let guard = 0; guard < 10_000; guard += 1) {
      let nextDue = Number.POSITIVE_INFINITY;
      let runInterval: [number, IntervalEntry] | undefined;
      let runTimeout: [number, TimeoutEntry] | undefined;

      for (const entry of intervals.values()) {
        if (entry.active && entry.due <= current && entry.due < nextDue) {
          nextDue = entry.due;
          runInterval = [entry.due, entry];
          runTimeout = undefined;
        }
      }
      for (const entry of timeouts.values()) {
        if (entry.active && entry.due <= current && entry.due < nextDue) {
          nextDue = entry.due;
          runTimeout = [entry.due, entry];
          runInterval = undefined;
        }
      }

      if (runTimeout) {
        timeouts.delete(findKey(timeouts, runTimeout[1]));
        runTimeout[1].active = false;
        runTimeout[1].handler();
        continue;
      }
      if (runInterval) {
        runInterval[1].due = current + runInterval[1].every;
        runInterval[1].handler();
        continue;
      }
      return;
    }
    throw new Error('The fake clock detected a timer loop.');
  }

  function findKey<T>(map: Map<number, T>, value: T): number {
    for (const [key, entry] of map) {
      if (entry === value) {
        return key;
      }
    }
    return -1;
  }

  return {
    now: () => current,
    advance(ms) {
      current += Math.max(0, ms);
      runDue();
    },
    pending() {
      return {
        intervals: [...intervals.values()].filter((entry) => entry.active).length,
        timeouts: [...timeouts.values()].filter((entry) => entry.active).length,
      };
    },
    async settle(turns = 10) {
      // Alternate a macrotask and a real read of the event loop: the extension
      // writes files through the promise based `fs` API, and only a generous
      // drain guarantees that the write has reached disk before the test looks.
      for (let turn = 0; turn < turns; turn += 1) {
        await new Promise<void>((done) => {
          realSetTimeout(done, 1);
        });
        await new Promise<void>((done) => {
          realSetImmediate(done);
        });
      }
    },
    install() {
      Date.now = () => current;
      globalThis.setInterval = ((handler: () => void, every = 0) => {
        const id = nextIntervalId;
        nextIntervalId += 1;
        intervals.set(id, { handler, every: Math.max(1, every), due: current + Math.max(1, every), active: true });
        return id;
      }) as unknown as typeof setInterval;
      globalThis.clearInterval = ((id: number) => {
        intervals.delete(id);
      }) as unknown as typeof clearInterval;
      globalThis.setTimeout = ((handler: () => void, delay = 0) => {
        const id = nextTimeoutId;
        nextTimeoutId += 1;
        timeouts.set(id, { handler, due: current + Math.max(0, delay), active: true });
        return id;
      }) as unknown as typeof setTimeout;
      globalThis.clearTimeout = ((id: number) => {
        timeouts.delete(id);
      }) as unknown as typeof clearTimeout;
    },
    restore() {
      Date.now = originalIsolate.dateNow;
      globalThis.setInterval = originalIsolate.setInterval;
      globalThis.clearInterval = originalIsolate.clearInterval;
      globalThis.setTimeout = originalIsolate.setTimeout;
      globalThis.clearTimeout = originalIsolate.clearTimeout;
      intervals.clear();
      timeouts.clear();
    },
  };
}

/* ----------------------------------- Uri ----------------------------------- */

export class MockUri {
  public readonly scheme: string;
  public readonly path: string;
  public readonly authority: string;
  public readonly query: string;
  public readonly fragment: string;

  public constructor(scheme: string, path: string, authority = '', query = '', fragment = '') {
    this.scheme = scheme;
    this.path = path;
    this.authority = authority;
    this.query = query;
    this.fragment = fragment;
  }

  public static file(path: string): MockUri {
    return new MockUri('file', normalize(path).split(sep).join('/'));
  }

  public static parse(value: string): MockUri {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)?([^?#]*)/.exec(value);
    if (!match) {
      return MockUri.file(value);
    }
    return new MockUri(match[1] ?? 'file', match[3] ?? '', match[2] ?? '');
  }

  public static joinPath(base: MockUri, ...parts: string[]): MockUri {
    const segments = parts
      .map((part) => part.replace(/^\/+|\/+$/g, ''))
      .filter((part) => part.length > 0);
    const joined = posix.join(base.path, ...segments);
    return new MockUri(base.scheme, joined, base.authority, base.query, base.fragment);
  }

  public get fsPath(): string {
    return this.path;
  }

  public get isAbsolute(): boolean {
    return this.path.startsWith('/') || isAbsolute(this.path);
  }

  public with(change: Partial<{ scheme: string; path: string; authority: string }>): MockUri {
    return new MockUri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
      change.authority ?? this.authority,
      this.query,
      this.fragment
    );
  }

  public toString(): string {
    const authority = this.authority.length > 0 ? `//${this.authority}` : '//';
    return `${this.scheme}:${authority}${this.path}${this.query}${this.fragment}`;
  }
}

/* -------------------------------- documents -------------------------------- */

export interface MockTextDocument {
  uri: MockUri;
  fileName: string;
  languageId: string;
  version: number;
  isDirty: boolean;
  isUntitled: boolean;
  lineCount: number;
}

export interface MockWorkspaceFolder {
  uri: MockUri;
  name: string;
  index: number;
}

function contentForbidden(): never {
  throw new Error('Dev Wrapped must never read document contents.');
}

/** A document whose text is unreachable: any read throws. */
export function createDocument(path: string, languageId: string, version = 1): MockTextDocument {
  const document: MockTextDocument = {
    uri: MockUri.file(path),
    fileName: path,
    languageId,
    version,
    isDirty: false,
    isUntitled: false,
    lineCount: 42,
  };
  return Object.assign(document, {
    getText: contentForbidden,
    lineAt: contentForbidden,
    getWordRangeAtPosition: contentForbidden,
    offsetAt: contentForbidden,
    positionAt: contentForbidden,
    validatePosition: contentForbidden,
    getTextInRange: contentForbidden,
  });
}

/* -------------------------------- event bags ------------------------------- */

interface Disposable {
  dispose(): void;
}

type Listener = (...args: never[]) => void;

class EventBag {
  private readonly listeners = new Map<string, Listener[]>();

  public on(name: string, listener: Listener): Disposable {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
    return {
      dispose: () => {
        const current = this.listeners.get(name) ?? [];
        this.listeners.set(
          name,
          current.filter((entry) => entry !== listener)
        );
      },
    };
  }

  public fire(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }

  public count(name: string): number {
    return (this.listeners.get(name) ?? []).length;
  }
}

/* ------------------------------- webview host ------------------------------ */

export class MockWebview {
  public html = '';
  public options: Record<string, unknown> = {};
  public readonly posted: unknown[] = [];
  public readonly cspSource = 'vscode-webview://code-wrapped-test';
  private handler: ((message: unknown) => void) | undefined;

  public asWebviewUri(uri: MockUri): MockUri {
    return new MockUri('vscode-webview', uri.path, 'code-wrapped-test');
  }

  public postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }

  public onDidReceiveMessage(handler: (message: unknown) => void): Disposable {
    this.handler = handler;
    return { dispose: () => (this.handler = undefined) };
  }

  /** Simulates a message from the dashboard. */
  public deliver(message: unknown): void {
    this.handler?.(message);
  }

  /** Every payload message posted to this webview, newest last. */
  public payloads(): unknown[] {
    return this.posted.filter(
      (message) => typeof message === 'object' && message !== null && (message as { type?: string }).type === 'payload'
    );
  }
}

export class MockWebviewPanel {
  public readonly webview = new MockWebview();
  public title: string;
  public viewColumn: number;
  public visible = true;
  public active = true;
  public iconPath: MockUri | undefined;
  public disposed = false;
  private readonly bag = new EventBag();

  public constructor(title: string, viewColumn: number) {
    this.title = title;
    this.viewColumn = viewColumn;
  }

  public reveal(): void {
    this.visible = true;
  }

  public onDidDispose(listener: () => void): Disposable {
    return this.bag.on('dispose', listener);
  }

  public onDidChangeViewState(listener: () => void): Disposable {
    return this.bag.on('change', listener);
  }

  public dispose(): void {
    this.disposed = true;
    this.bag.fire('dispose');
  }
}

export class MockWebviewView {
  public readonly webview = new MockWebview();
  public title = '';
  public visible = true;
  public readonly onDidChangeVisibility: (listener: () => void) => Disposable;
  public readonly onDidDispose: (listener: () => void) => Disposable;
  private readonly bag = new EventBag();

  public constructor() {
    this.onDidChangeVisibility = (listener) => this.bag.on('visibility', listener);
    this.onDidDispose = (listener) => this.bag.on('dispose', listener);
  }

  public show(): void {
    this.visible = true;
    this.bag.fire('visibility');
  }

  public dispose(): void {
    this.bag.fire('dispose');
  }
}

/* --------------------------------- status bar ------------------------------ */

export interface MockStatusBarItem extends Disposable {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  name: string | undefined;
  visible: boolean;
  show(): void;
  hide(): void;
}

/* ---------------------------------- memento -------------------------------- */

export interface MockMemento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): string[];
}

/* ---------------------------------- the mock ------------------------------- */

export interface PromptCall {
  kind: 'information' | 'warning' | 'error' | 'quickPick' | 'save' | 'open' | 'input';
  message: string;
  items: string[];
  options: Record<string, unknown>;
}

export interface MockVscode {
  clock: FakeClock;
  api: Record<string, unknown>;
  settings: Record<string, unknown>;
  /** Every prompt shown to the user, in order. */
  prompts: PromptCall[];
  /** Answers returned by the prompts (replace to script a flow). */
  answers: {
    information: (message: string, items: string[]) => string | undefined;
    warning: (message: string, items: string[]) => string | undefined;
    error: (message: string, items: string[]) => string | undefined;
    quickPick: (labels: string[]) => number | undefined;
    save: (options: Record<string, unknown>) => MockUri | undefined;
    open: (options: Record<string, unknown>) => MockUri[] | undefined;
    input: (options: Record<string, unknown>) => string | undefined;
  };
  contextKeys: Record<string, unknown>;
  executedCommands: string[];
  outputLines: string[];
  statusBar: MockStatusBarItem;
  panels: MockWebviewPanel[];
  viewProviders: Array<{ viewType: string; provider: { resolveWebviewView(...args: unknown[]): void } }>;
  sidebarViews: MockWebviewView[];
  workspaceFolders: MockWorkspaceFolder[];
  globalState: MockMemento;
  /** Activates a file in the editor and fires the matching event. */
  openFile(path: string, languageId: string): MockTextDocument;
  closeEditor(): void;
  editActiveFile(): void;
  saveActiveFile(): void;
  createFile(path: string): void;
  setFocused(focused: boolean): void;
  createdDocuments: MockTextDocument[];
  /** Writes a file through the mocked `workspace.fs` and the real disk. */
  writeWorkspaceFile(path: string, content: string): Promise<void>;
}

export interface VscodeMockOptions {
  storageDirectory: string;
  workspaceRoot: string;
  extensionRoot: string;
  startTime: number;
}

let installed: MockVscode | undefined;

/** The mock installed by `installVscodeMock`. */
export function getVscodeMock(): MockVscode {
  if (!installed) {
    throw new Error('installVscodeMock() must run before the extension is loaded.');
  }
  return installed;
}

/**
 * Installs the fake `vscode` module for the whole test process.
 *
 * Must be called before anything requires `src/extension`.
 */
export function installVscodeMock(options: VscodeMockOptions): MockVscode {
  if (installed) {
    return installed;
  }

  const clock = createClock(options.startTime);
  const bag = new EventBag();
  const prompts: PromptCall[] = [];
  const contextKeys: Record<string, unknown> = {};
  const executedCommands: string[] = [];
  const outputLines: string[] = [];
  const panels: MockWebviewPanel[] = [];
  const viewProviders: MockVscode['viewProviders'] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const documents: MockTextDocument[] = [];

  const globalState: MockMemento = (() => {
    const values = new Map<string, unknown>();
    return {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        values.has(key) ? (values.get(key) as T) : defaultValue,
      update: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...values.keys()],
    };
  })();

  const settings: Record<string, unknown> = {
    inactivityTimeout: 10,
    minimumActiveTime: 10,
    trackLanguages: true,
    trackProjects: true,
    enableNotifications: false,
    debugLogging: false,
    showStatusBar: true,
    sessionRetentionDays: 1095,
  };

  const statusBar: MockStatusBarItem = {
    text: '',
    tooltip: undefined,
    command: undefined,
    name: undefined,
    visible: false,
    show() {
      statusBar.visible = true;
    },
    hide() {
      statusBar.visible = false;
    },
    dispose() {
      statusBar.visible = false;
    },
  };

  const workspaceFolders: MockWorkspaceFolder[] = [
    { uri: MockUri.file(options.workspaceRoot), name: 'dev-wrapped-workspace', index: 0 },
  ];

  const windowState = { focused: true };
  let activeEditor: { document: MockTextDocument; selections: Array<{ active: { line: number; character: number } }> } | undefined;

  const answers: MockVscode['answers'] = {
    information: () => undefined,
    warning: () => undefined,
    error: () => undefined,
    quickPick: () => undefined,
    save: () => undefined,
    open: () => undefined,
    input: () => undefined,
  };

  const titleOf = (opts: Record<string, unknown>): string =>
    typeof opts.title === 'string' ? opts.title : '';

  const record = (kind: PromptCall['kind'], message: string, items: string[], opts: Record<string, unknown>): void => {
    prompts.push({ kind, message, items, options: opts });
  };

  const mock: MockVscode = {
    clock,
    api: {},
    settings,
    prompts,
    answers,
    contextKeys,
    executedCommands,
    outputLines,
    statusBar,
    panels,
    viewProviders,
    sidebarViews: [],
    workspaceFolders,
    globalState,
    createdDocuments: documents,
    openFile(path, languageId) {
      const document = createDocument(path, languageId, (activeEditor?.document.version ?? 0) + 1);
      documents.push(document);
      activeEditor = { document, selections: [{ active: { line: 0, character: 0 } }] };
      bag.fire('activeEditor', activeEditor);
      return document;
    },
    closeEditor() {
      activeEditor = undefined;
      bag.fire('activeEditor', undefined);
    },
    editActiveFile() {
      if (!activeEditor) {
        throw new Error('No active editor.');
      }
      activeEditor.document.version += 1;
      activeEditor.document.isDirty = true;
      bag.fire('textDocumentChange', {
        document: activeEditor.document,
        contentChanges: [{ text: '', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }],
      });
    },
    saveActiveFile() {
      if (!activeEditor) {
        throw new Error('No active editor.');
      }
      activeEditor.document.isDirty = false;
      bag.fire('saveDocument', activeEditor.document);
    },
    createFile(path) {
      bag.fire('createFiles', { files: [MockUri.file(path)] });
    },
    setFocused(focused) {
      windowState.focused = focused;
      bag.fire('windowState', { focused });
    },
    async writeWorkspaceFile(path, content) {
      await fs.mkdir(resolve(path, '..'), { recursive: true });
      await fs.writeFile(path, content, 'utf8');
    },
  };

  const api = {
    version: '1.90.0',
    Uri: MockUri,
    EventEmitter: class {
      private readonly bag = new EventBag();
      public readonly event = (listener: Listener): Disposable => this.bag.on('event', listener);
      public fire(value: unknown): void {
        this.bag.fire('event', value);
      }
      public dispose(): void {
        // Nothing to release in the fake emitter.
      }
    },
    Disposable: { from: (...items: Disposable[]) => ({ dispose: () => items.forEach((item) => item.dispose()) }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1, Two: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    env: {
      language: 'en',
      appName: 'Visual Studio Code',
      appHost: 'desktop',
      machineId: 'test-machine',
      sessionId: 'test-session',
      uiKind: 1,
      remoteName: undefined,
    },
    window: {
      state: windowState,
      activeColorTheme: { kind: 2 },
      get activeTextEditor() {
        return activeEditor;
      },
      onDidChangeActiveTextEditor: (listener: (editor: unknown) => void) => bag.on('activeEditor', listener),
      onDidChangeWindowState: (listener: (state: unknown) => void) => bag.on('windowState', listener),
      createOutputChannel: (name: string) => ({
        name,
        append: (text: string) => outputLines.push(text),
        appendLine: (line: string) => outputLines.push(line),
        replace: (line: string) => outputLines.push(line),
        clear: () => outputLines.splice(0),
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
      createStatusBarItem: () => statusBar,
      createWebviewPanel: (type: string, title: string, viewColumn: number, panelOptions: unknown) => {
        const panel = new MockWebviewPanel(title, viewColumn);
        panel.webview.options = { ...(panelOptions as Record<string, unknown>), type };
        panels.push(panel);
        return panel;
      },
      registerWebviewViewProvider: (
        viewType: string,
        provider: { resolveWebviewView(...args: unknown[]): void }
      ) => {
        viewProviders.push({ viewType, provider });
        return { dispose: () => undefined };
      },
      showInformationMessage: (message: string, ...rest: unknown[]) => {
        const opts = rest.length > 0 && typeof rest[0] === 'object' ? (rest[0] as Record<string, unknown>) : {};
        const items = rest.filter((item): item is string => typeof item === 'string');
        record('information', message, items, opts);
        return Promise.resolve(answers.information(message, items));
      },
      showWarningMessage: (message: string, ...rest: unknown[]) => {
        const opts = rest.length > 0 && typeof rest[0] === 'object' ? (rest[0] as Record<string, unknown>) : {};
        const items = rest.filter((item): item is string => typeof item === 'string');
        record('warning', message, items, opts);
        return Promise.resolve(answers.warning(message, items));
      },
      showErrorMessage: (message: string, ...rest: unknown[]) => {
        const opts = rest.length > 0 && typeof rest[0] === 'object' ? (rest[0] as Record<string, unknown>) : {};
        const items = rest.filter((item): item is string => typeof item === 'string');
        record('error', message, items, opts);
        return Promise.resolve(answers.error(message, items));
      },
      showQuickPick: (items: Array<{ label?: string }>, opts: Record<string, unknown> = {}) => {
        const labels = items.map((item) => item.label ?? '');
        record('quickPick', titleOf(opts), labels, opts);
        const index = answers.quickPick(labels);
        return Promise.resolve(index === undefined ? undefined : items[index]);
      },
      showSaveDialog: (opts: Record<string, unknown>) => {
        record('save', titleOf(opts), [], opts);
        return Promise.resolve(answers.save(opts));
      },
      showOpenDialog: (opts: Record<string, unknown>) => {
        record('open', titleOf(opts), [], opts);
        return Promise.resolve(answers.open(opts));
      },
      showInputBox: (opts: Record<string, unknown>) => {
        record('input', titleOf(opts), [], opts);
        return Promise.resolve(answers.input(opts));
      },
    },
    workspace: {
      get workspaceFolders() {
        return workspaceFolders;
      },
      getWorkspaceFolder: (uri: MockUri) => {
        return workspaceFolders.find((folder) => uri.path.startsWith(folder.uri.path)) ?? undefined;
      },
      getConfiguration: (section: string) => ({
        get: <T,>(key: string): T | undefined => {
          const value = settings[key];
          return value === undefined ? undefined : (value as T);
        },
        has: (key: string) => key in settings,
        inspect: (key: string) => ({ key: `${section}.${key}`, defaultValue: settings[key] }),
        update: (key: string, value: unknown) => {
          settings[key] = value;
          return Promise.resolve();
        },
      }),
      onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) =>
        bag.on('configuration', listener),
      onDidChangeTextDocument: (listener: (event: unknown) => void) => bag.on('textDocumentChange', listener),
      onDidSaveTextDocument: (listener: (document: unknown) => void) => bag.on('saveDocument', listener),
      onDidOpenTextDocument: (listener: (document: unknown) => void) => bag.on('openDocument', listener),
      onDidCreateFiles: (listener: (event: unknown) => void) => bag.on('createFiles', listener),
      onDidChangeWorkspaceFolders: (listener: () => void) => bag.on('workspaceFolders', listener),
      fs: {
        stat: async (uri: MockUri) => {
          const stats = await fs.stat(uri.fsPath);
          return { size: stats.size, ctime: stats.ctimeMs, mtime: stats.mtimeMs, type: stats.isDirectory() ? 2 : 1 };
        },
        readFile: async (uri: MockUri) => fs.readFile(uri.fsPath),
        writeFile: async (uri: MockUri, content: Uint8Array) => {
          await fs.writeFile(uri.fsPath, Buffer.from(content));
        },
        createDirectory: async (uri: MockUri) => {
          await fs.mkdir(uri.fsPath, { recursive: true });
        },
        delete: async (uri: MockUri) => {
          await fs.rm(uri.fsPath, { recursive: true, force: true });
        },
      },
    },
    commands: {
      registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => {
        commands.set(id, callback);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: (id: string, ...args: unknown[]) => {
        executedCommands.push(id);
        if (id === 'setContext') {
          contextKeys[String(args[0])] = args[1];
          return Promise.resolve(undefined);
        }
        if (id === 'workbench.action.openSettings') {
          return Promise.resolve(undefined);
        }
        const command = commands.get(id);
        if (!command) {
          return Promise.reject(new Error(`command '${id}' not found`));
        }
        return Promise.resolve(command(...args));
      },
      getCommands: () => Promise.resolve([...commands.keys()]),
    },
  };

  mock.api = api;
  installed = mock;

  /* ------------------------------ loader patch ----------------------------- */

  const nodeRequire = createRequire(__filename);
  const loader = nodeRequire('node:module') as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = loader._load.bind(loader);
  loader._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
      return api;
    }
    return originalLoad(request, parent, isMain);
  };

  return mock;
}

/** Absolute path of the extension root, derived from this file being in `out/test/helpers`. */
export function extensionRootFromHere(): string {
  return resolve(__dirname, '..', '..', '..');
}

/** Joins a path for assertions (kept next to the mock so tests stay readable). */
export function joinPath(...parts: string[]): string {
  return join(...parts);
}
