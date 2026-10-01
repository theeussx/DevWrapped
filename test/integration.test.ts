/**
 * End-to-end integration test.
 *
 * Every other suite tests a pure layer. This one boots the real extension
 * (`out/src/extension.js`) against an in-memory VS Code host and follows the
 * whole path a user takes:
 *
 *   first run → tracking → dashboard → export → import → reset → shutdown
 *
 * It covers the parts that unit tests cannot reach: command registration
 * (checked against `package.json`), the webview message protocol and its
 * Content Security Policy, the status bar, pause/resume, the transfer flows
 * with their confirmations, and the rule that document contents are never read
 * (the fake documents throw on every content accessor).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';

import type * as ExtensionModule from '../src/extension';
import type * as ImporterModule from '../src/storage/Importer';
import type * as ValidationModule from '../src/security/Validation';

import {
  extensionRootFromHere,
  installVscodeMock,
  MockUri,
  MockWebviewView,
  type MockVscode,
  type MockWebviewPanel,
} from './helpers/vscode-mock';

/* ------------------------------- environment ------------------------------- */

const root = extensionRootFromHere();
const nodeRequire = createRequire(__filename);

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    views: Record<string, Array<{ id: string; type: string }>>;
    viewsContainers: { activitybar: Array<{ id: string; title: string }> };
  };
}

interface StoredDatabase {
  meta: { privacySalt: string; retentionDays: number; schemaVersion: number };
  days: Record<
    string,
    {
      activeTime: number;
      filesModified: number;
      filesSaved: number;
      languages: Record<string, number>;
      projects: Record<string, number>;
    }
  >;
  sessions: Array<{ duration: number; language?: string; projectName?: string }>;
  projects: Record<string, { name: string }>;
}

interface DashboardPayloadLike {
  pages: string[];
  year: number;
  availableYears: number[];
  privacy: { stored: { days: number; sessions: number; projects: number }; network: { requests: number } };
  today: unknown;
  wrapped: { slides: unknown[]; available: boolean };
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
const manifestCommands = manifest.contributes.commands.map((entry) => entry.command).sort();

const ACTIVATION_TIME = new Date('2026-10-01T14:00:00').getTime();
const temp = mkdtempSync(join(tmpdir(), 'dev-wrapped-integration-'));
const storageDirectory = join(temp, 'globalStorage');
const workspaceRoot = join(temp, 'workspace');
const csvDirectory = join(temp, 'csv');
const exportFile = join(temp, 'backup.json');
const wrappedFile = join(temp, 'wrapped.html');
mkdirSync(storageDirectory, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(csvDirectory, { recursive: true });

const dataFile = join(storageDirectory, 'devwrapped-data.json');

function readDatabase(): StoredDatabase {
  return JSON.parse(readFileSync(dataFile, 'utf8')) as StoredDatabase;
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dayRecord(database: StoredDatabase, key: string): StoredDatabase['days'][string] {
  const day = database.days[key];
  assert.ok(day, `expected a stored record for ${key}`);
  return day;
}

function lastPayload(panel: MockWebviewPanel): DashboardPayloadLike {
  const payloads = panel.webview.payloads();
  const message = payloads[payloads.length - 1] as { payload?: DashboardPayloadLike } | undefined;
  assert.ok(message?.payload, 'expected the panel to have received a payload');
  return message.payload;
}

function actionMessages(panel: MockWebviewPanel, type: string): unknown[] {
  return panel.webview.posted.filter(
    (message) => typeof message === 'object' && message !== null && (message as { type?: string }).type === type
  );
}

/* ---------------------------------- suite ---------------------------------- */

test('the extension runs end to end in a VS Code host', async (t) => {
  const mock: MockVscode = installVscodeMock({
    storageDirectory,
    workspaceRoot,
    extensionRoot: root,
    startTime: ACTIVATION_TIME,
  });
  mock.clock.install();

  const api = mock.api as unknown as {
    commands: { executeCommand(id: string, ...args: unknown[]): Promise<unknown>; getCommands(): Promise<string[]> };
  };

  const extension = nodeRequire(join(root, 'out', 'src', 'extension.js')) as typeof ExtensionModule;
  const validation = nodeRequire(join(root, 'out', 'src', 'security', 'Validation.js')) as typeof ValidationModule;
  const importer = nodeRequire(join(root, 'out', 'src', 'storage', 'Importer.js')) as typeof ImporterModule;

  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: mock.globalState,
    globalStorageUri: MockUri.file(storageDirectory),
    extensionUri: MockUri.file(root),
    extension: { id: 'theeussx.dev-wrapped', packageJSON: manifest },
    asAbsolutePath: (relative: string) => join(root, relative),
  } as unknown as ExtensionContext;

  /* ------------------------------ first run ------------------------------- */

  await t.test('the first run asks for consent and then starts tracking', async () => {
    mock.answers.information = (message, items) =>
      message.includes('Welcome') && items.includes('Start tracking') ? 'Start tracking' : undefined;

    await extension.activate(context);
    await mock.clock.settle();

    const welcome = mock.prompts.find((prompt) => prompt.message.includes('Welcome'));
    assert.ok(welcome, 'the welcome modal must be shown on a fresh install');
    assert.deepEqual(welcome.items, ['Start tracking', 'Privacy details', 'Not now']);
    assert.match(String(welcome.options.detail), /never read/i);
    assert.equal(mock.globalState.get('codeWrapped.onboarded'), true);
    assert.equal(mock.contextKeys['codeWrapped.trackingPaused'], false);
    assert.ok(mock.statusBar.visible, 'the status bar item must be visible');
    assert.equal(mock.statusBar.text, '$(graph) no activity yet');
    assert.equal(mock.statusBar.command, 'codeWrapped.openDashboard');
    assert.ok(
      mock.outputLines.some((line) => line.includes('activated')),
      'activation must be logged to the output channel'
    );
    assert.ok(mock.panels.length >= 1, 'the welcome flow opens the dashboard');
  });

  await t.test('every manifest command is registered and nothing else is', async () => {
    const registered = (await api.commands.getCommands()).sort();
    assert.deepEqual(registered, manifestCommands);
    assert.equal(registered.length, 16);
    assert.ok(
      manifestCommands.every((id) => id.startsWith('codeWrapped.')),
      'commands must live in the codeWrapped namespace'
    );
    assert.ok(
      manifest.contributes.commands.every((entry) => entry.category === 'Code Wrapped'),
      'every command must use the "Code Wrapped" category'
    );
  });

  await t.test('the dashboard document is hardened', () => {
    const panel = mock.panels[0];
    assert.ok(panel, 'a panel must be open');
    const html = panel.webview.html;

    assert.match(html, /<title>Code Wrapped Dashboard<\/title>/);
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      assert.ok(html.includes(directive), `the CSP must contain ${directive}`);
    }
    assert.ok(!html.includes('unsafe-eval'), 'the dashboard must never allow eval');
    assert.ok(!html.includes('https://') && !html.includes('http://'), 'no remote resource may be loaded');

    const scripts = [...html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/g)];
    assert.equal(scripts.length, 5, 'the five webview scripts are all present');
    const nonces = new Set(scripts.map((match) => match[1]));
    assert.equal(nonces.size, 1, 'all scripts share the per-load nonce');
    assert.ok(html.includes(`<script nonce="${[...nonces][0]}">`), 'the inline boot script uses the same nonce');
    for (const match of scripts) {
      assert.ok(match[2]?.startsWith('vscode-webview://'), 'scripts may only come from the webview origin');
    }

    const roots = panel.webview.options.localResourceRoots as MockUri[];
    assert.equal(roots.length, 1, 'localResourceRoots must be limited to one folder');
    assert.ok(roots[0]?.path.endsWith('/media'), 'only the media folder may be loaded');
    assert.equal(panel.webview.options.enableScripts, true);
    assert.equal(panel.webview.options.enableCommandUris, false);
  });

  /* ------------------------------- tracking ------------------------------- */

  await t.test('editor activity becomes local statistics on disk', async () => {
    const panel = mock.panels[0];
    assert.ok(panel);
    const payloadsBefore = panel.webview.payloads().length;

    mock.openFile(join(workspaceRoot, 'src', 'app.ts'), 'typescript');
    for (let tick = 0; tick < 5; tick += 1) {
      mock.editActiveFile();
      mock.clock.advance(15_000);
    }
    await mock.clock.settle();
    await api.commands.executeCommand('codeWrapped.refresh');

    assert.ok(existsSync(dataFile), 'the database file must exist after the first flush');
    const raw = readFileSync(dataFile, 'utf8');
    assert.ok(!raw.includes(workspaceRoot), 'the workspace path must never be stored');
    assert.ok(!raw.includes('app.ts'), 'file names must never be stored');

    const database = readDatabase();
    const day = dayRecord(database, localDayKey(mock.clock.now()));
    assert.ok(day.activeTime >= 70_000, `expected five editable ticks, got ${day.activeTime} ms`);
    assert.ok(day.activeTime <= 80_000, `a tick must never be counted twice, got ${day.activeTime} ms`);
    assert.equal(day.filesModified, 1, 'one document edited five times counts once');
    assert.equal(day.languages.typescript, day.activeTime, 'all the time belongs to TypeScript');
    const projectIds = Object.keys(day.projects);
    assert.equal(projectIds.length, 1, 'the day records exactly one anonymized project');
    assert.equal(day.projects[projectIds[0] ?? ''], day.activeTime);
    assert.ok(
      !/[/\\]/.test(projectIds[0] ?? ''),
      'a project id is an opaque hash, never a path'
    );
    assert.ok(database.meta.privacySalt.length > 0, 'a privacy salt must be created');

    assert.match(mock.statusBar.text, /1m/, 'the status bar follows today’s activity');
    assert.ok(panel.webview.payloads().length > payloadsBefore, 'the open dashboard must be refreshed');
  });

  await t.test('idle time is never counted and the session ends', async () => {
    const before = dayRecord(readDatabase(), localDayKey(mock.clock.now())).activeTime;
    // Eleven minutes without a single editor event: past the 10 minute timeout.
    mock.clock.advance(11 * 60_000);
    await mock.clock.settle();
    await api.commands.executeCommand('codeWrapped.refresh');
    const after = dayRecord(readDatabase(), localDayKey(mock.clock.now())).activeTime;
    assert.ok(after - before < 60_000, `idle time leaked into the statistics (${after - before} ms)`);

    const database = readDatabase();
    assert.equal(database.sessions.length, 1, 'the idle stretch is not a second session');
    assert.equal(database.sessions[0]?.language, 'typescript');
    assert.equal(database.sessions[0]?.projectName, 'dev-wrapped-workspace');
    assert.ok((database.sessions[0]?.duration ?? 0) > 0, 'the session must have a duration');
    const projectId = Object.keys(database.projects)[0] ?? '';
    assert.equal(database.projects[projectId]?.name, 'dev-wrapped-workspace');
    assert.ok(!projectId.includes(workspaceRoot), 'the registry key is a hash, not a path');
  });

  /* --------------------------- webview protocol --------------------------- */

  await t.test('the webview protocol accepts known messages and ignores the rest', async () => {
    const panel = mock.panels[0];
    assert.ok(panel);
    const before = panel.webview.payloads().length;

    panel.webview.deliver({ type: 'ready' });
    await mock.clock.settle();
    assert.ok(panel.webview.payloads().length > before, 'ready must be answered with a payload');

    const payload = lastPayload(panel);
    assert.equal(payload.pages.length, 13);
    assert.ok(payload.pages.includes('wrapped') && payload.pages.includes('privacy'));
    assert.ok(payload.privacy.stored.days >= 1, 'the privacy page reports the stored days');
    assert.equal(payload.privacy.network.requests, 0);

    // Anything unknown or out of range is dropped without side effects.
    const payloadsBeforeJunk = panel.webview.payloads().length;
    const promptsBeforeJunk = mock.prompts.length;
    const navigationsBeforeJunk = actionMessages(panel, 'navigate').length;
    for (const hostile of [
      undefined,
      null,
      42,
      'ready',
      {},
      { type: '__proto__' },
      { type: 'constructor' },
      { type: 'toString' },
      { type: 'navigate', page: '../etc/passwd' },
      { type: 'navigate', page: 42 },
      { type: 'navigate' },
      { type: 'selectYear', year: 12_345 },
      { type: 'selectYear', year: 1999 },
      { type: 'selectYear', year: 3.5 },
      { type: 'selectYear', year: 'not-a-year' },
      { type: 'export', format: 'exe' },
      { type: 'export' },
      { get type() {
        throw new Error('hostile getter');
      } },
    ]) {
      panel.webview.deliver(hostile);
    }
    await mock.clock.settle();
    assert.equal(panel.webview.payloads().length, payloadsBeforeJunk, 'rejected messages change nothing');
    assert.equal(mock.prompts.length, promptsBeforeJunk, 'rejected messages trigger no dialog');
    assert.equal(actionMessages(panel, 'navigate').length, navigationsBeforeJunk, 'rejected messages never navigate');
    assert.equal(lastPayload(panel).year, new Date(mock.clock.now()).getFullYear());

    // A known type with extra properties is accepted, and the extras are dropped.
    panel.webview.deliver({ type: 'ready', payload: { evil: true }, page: 'privacy' });
    await mock.clock.settle();
    assert.ok(panel.webview.payloads().length > payloadsBeforeJunk, 'extra properties do not invalidate a message');

    // Numeric strings are coerced; the value stays inside the accepted window.
    panel.webview.deliver({ type: 'selectYear', year: '2024' });
    await mock.clock.settle();
    assert.equal(lastPayload(panel).year, 2024, 'a numeric string is coerced into a valid year');

    // A forged reset only opens the confirmation dialog, which is the defence.
    const daysBeforeForgery = Object.keys(readDatabase().days).length;
    const warningsBeforeForgery = mock.prompts.filter((prompt) => prompt.kind === 'warning').length;
    panel.webview.deliver({ type: 'resetStatistics' });
    panel.webview.deliver({ type: 'pauseTracking' });
    await mock.clock.settle();
    assert.ok(
      mock.prompts.filter((prompt) => prompt.kind === 'warning').length > warningsBeforeForgery,
      'a reset request always goes through the confirmation dialog'
    );
    assert.equal(Object.keys(readDatabase().days).length, daysBeforeForgery, 'the dialog protects the data');
    panel.webview.deliver({ type: 'resumeTracking' });
    await mock.clock.settle();

    // Back to the current year, then mark the retrospective as seen.
    panel.webview.deliver({ type: 'selectYear', year: new Date(mock.clock.now()).getFullYear() });
    await mock.clock.settle();
    panel.webview.deliver({ type: 'navigate', page: 'wrapped' });
    await mock.clock.settle();
    assert.equal(mock.globalState.get('codeWrapped.lastWrappedYear'), new Date(mock.clock.now()).getFullYear());
    assert.ok(actionMessages(panel, 'navigate').length >= 1, 'navigation is echoed back to the webview');

    panel.webview.deliver({ type: 'openSettings' });
    panel.webview.deliver({ type: 'openPrivacy' });
    panel.webview.deliver({ type: 'refresh' });
    await mock.clock.settle();
    assert.ok(mock.executedCommands.includes('workbench.action.openSettings'));
    assert.ok(
      actionMessages(panel, 'navigate').some((message) => (message as { page?: string }).page === 'privacy'),
      'the privacy command navigates the dashboard'
    );
  });

  await t.test('the sidebar view uses the same hardened document', async () => {
    const provider = mock.viewProviders[0];
    assert.ok(provider, 'a webview view provider must be registered');
    assert.equal(provider.viewType, 'codeWrapped.sidebar');
    assert.equal(manifest.contributes.views.codeWrapped?.[0]?.id, 'codeWrapped.sidebar');

    const view = new MockWebviewView();
    provider.provider.resolveWebviewView(view, {}, {});
    assert.equal(view.title, 'Dashboard');
    assert.ok(view.webview.html.includes("default-src 'none'"));
    assert.ok(!view.webview.html.includes('http://'));
    const roots = view.webview.options.localResourceRoots as MockUri[];
    assert.ok(roots[0]?.path.endsWith('/media'));

    view.webview.deliver({ type: 'ready' });
    await mock.clock.settle();
    assert.ok(view.webview.payloads().length >= 1, 'the sidebar receives the same payload');
  });

  await t.test('pausing and resuming from the dashboard is honoured', async () => {
    const panel = mock.panels[0];
    assert.ok(panel);

    panel.webview.deliver({ type: 'pauseTracking' });
    await mock.clock.settle();
    assert.equal(mock.contextKeys['codeWrapped.trackingPaused'], true);
    assert.equal(mock.globalState.get('codeWrapped.paused'), true);
    assert.match(String(mock.statusBar.tooltip), /paused/i);

    const frozen = dayRecord(readDatabase(), localDayKey(mock.clock.now())).activeTime;
    mock.editActiveFile();
    mock.clock.advance(60_000);
    await mock.clock.settle();
    await api.commands.executeCommand('codeWrapped.refresh');
    assert.equal(
      dayRecord(readDatabase(), localDayKey(mock.clock.now())).activeTime,
      frozen,
      'nothing may be recorded while tracking is paused'
    );

    panel.webview.deliver({ type: 'resumeTracking' });
    await mock.clock.settle();
    assert.equal(mock.contextKeys['codeWrapped.trackingPaused'], false);
    assert.equal(mock.globalState.get('codeWrapped.paused'), false);
  });

  /* --------------------------------- data --------------------------------- */

  await t.test('a JSON export round-trips through the real validator', async () => {
    mock.answers.quickPick = (labels) => labels.findIndex((label) => label.startsWith('JSON'));
    mock.answers.save = () => MockUri.file(exportFile);
    await api.commands.executeCommand('codeWrapped.exportData');

    assert.ok(existsSync(exportFile), 'the backup file must be written');
    const text = readFileSync(exportFile, 'utf8');
    const preview = importer.previewImport(text, { now: mock.clock.now(), retentionDays: 1095 });
    assert.equal(preview.ok, true, `the export must validate: ${preview.error ?? ''}`);
    assert.ok(preview.stats.days >= 1, 'the export carries the stored days');
    assert.ok(preview.stats.sessions >= 1, 'the export carries the stored sessions');
    assert.ok(preview.data, 'a valid preview carries the database');
    assert.ok(Object.keys(preview.data.days).length >= 1, 'the inner database survives validation');
    assert.equal(validation.normalizeDatabase(preview.data).issues.length, 0);
    assert.ok(
      mock.prompts.some(
        (prompt) => prompt.kind === 'information' && /Backup exported/i.test(prompt.message)
      ),
      'the user is told where the backup went'
    );
  });

  await t.test('CSV and retrospective exports are written', async () => {
    mock.answers.quickPick = (labels) => labels.findIndex((label) => label.startsWith('CSV'));
    mock.answers.open = () => [MockUri.file(csvDirectory)];
    await api.commands.executeCommand('codeWrapped.exportData');
    const csvFiles = readdirSync(csvDirectory).sort();
    assert.deepEqual(csvFiles, ['daily.csv', 'languages.csv', 'projects.csv', 'sessions.csv']);
    const daily = readFileSync(join(csvDirectory, 'daily.csv'), 'utf8');
    assert.ok(daily.split('\n')[0]?.includes('date'), 'the CSV keeps a header row');

    mock.answers.save = () => MockUri.file(wrappedFile);
    await api.commands.executeCommand('codeWrapped.exportWrapped');
    assert.ok(existsSync(wrappedFile), 'the retrospective must be written');
    const html = readFileSync(wrappedFile, 'utf8');
    assert.ok(html.includes('Code Wrapped'), 'the export names the extension');
    assert.ok(!html.includes('<script'), 'the exported page contains no script');
    assert.ok(!html.includes('http://') && !html.includes('https://'), 'the export is self-contained');
    assert.ok(/style-src 'unsafe-inline'/.test(html), 'inline styles are the only allowance');
  });

  await t.test('importing replaces the data only after a confirmation', async () => {
    const before = Object.keys(readDatabase().days).length;

    // Declining the confirmation leaves everything untouched.
    mock.answers.open = () => [MockUri.file(exportFile)];
    mock.answers.warning = () => undefined;
    await api.commands.executeCommand('codeWrapped.importData');
    assert.equal(Object.keys(readDatabase().days).length, before, 'declining must not import');

    // A file with unexpected (secret looking) keys is refused.
    const hostileFile = join(temp, 'hostile.json');
    const backup = JSON.parse(readFileSync(exportFile, 'utf8')) as { data: Record<string, unknown> };
    writeFileSync(
      hostileFile,
      JSON.stringify({
        ...backup,
        data: { ...backup.data, documents: [{ fileName: 'secret-notes.txt', content: 'never stored' }] },
      }),
      'utf8'
    );
    mock.answers.open = () => [MockUri.file(hostileFile)];
    mock.answers.warning = () => 'Import and replace';
    await api.commands.executeCommand('codeWrapped.importData');
    assert.ok(
      mock.prompts.some(
        (prompt) => prompt.kind === 'error' && /import was refused/i.test(prompt.message)
      ),
      'a file carrying file names or contents is refused'
    );
    assert.ok(
      mock.outputLines.some((line) => line.includes('Import refused')),
      'the refusal is logged'
    );
    assert.equal(Object.keys(readDatabase().days).length, before, 'a refused import changes nothing');

    // Accepting writes a safety copy first and then replaces the data.
    mock.answers.open = () => [MockUri.file(exportFile)];
    await api.commands.executeCommand('codeWrapped.importData');
    const copies = readdirSync(storageDirectory).filter((name) => name.includes('before-import'));
    assert.equal(copies.length, 1, 'a safety copy is written before the import');
    assert.equal(Object.keys(readDatabase().days).length, before, 'the imported data is intact');
    assert.ok(
      mock.prompts.some((prompt) => prompt.kind === 'information' && /Imported/i.test(prompt.message)),
      'the import is confirmed to the user'
    );
  });

  await t.test('resetting requires the typed confirmation', async () => {
    mock.answers.warning = (_message, items) => (items.includes('Continue') ? 'Continue' : undefined);
    mock.answers.input = () => 'nope';
    await api.commands.executeCommand('codeWrapped.resetStatistics');
    assert.ok(Object.keys(readDatabase().days).length >= 1, 'a wrong confirmation word changes nothing');

    mock.answers.input = () => 'RESET';
    mock.clock.advance(120_000);
    await mock.clock.settle();
    await api.commands.executeCommand('codeWrapped.resetStatistics');
    const afterReset = readDatabase();
    assert.deepEqual(Object.keys(afterReset.days), [], 'the reset empties the statistics');
    assert.deepEqual(afterReset.sessions, []);
    assert.ok(
      readdirSync(storageDirectory).some((name) => name.includes('before-reset')),
      'a safety copy is kept'
    );
    assert.equal(mock.statusBar.text, '$(graph) no activity yet');
  });

  /* ------------------------------- shutdown ------------------------------- */

  await t.test('deactivate flushes and releases every timer', async () => {
    mock.openFile(join(workspaceRoot, 'src', 'index.ts'), 'typescript');
    mock.clock.advance(30_000);
    await mock.clock.settle();
    assert.ok(mock.clock.pending().intervals >= 1, 'a running tracker owns a sampling timer');

    await extension.deactivate();
    await mock.clock.settle();
    assert.equal(mock.clock.pending().intervals, 0, 'shutdown must clear the tracker timers');
    assert.ok(existsSync(dataFile), 'the database survives a shutdown');
    const database = readDatabase();
    assert.ok(database.meta.schemaVersion >= 1);
  });

  mock.clock.restore();
});

test('a damaged database never blocks activation and is never deleted', async (t) => {
  const damagedDirectory = join(temp, 'damaged-storage');
  mkdirSync(damagedDirectory, { recursive: true });
  const damagedFile = join(damagedDirectory, 'devwrapped-data.json');
  writeFileSync(damagedFile, '{"meta": {"schemaVersion": 2}, "days":', 'utf8');

  const mock: MockVscode = installVscodeMock({
    storageDirectory: damagedDirectory,
    workspaceRoot,
    extensionRoot: root,
    startTime: ACTIVATION_TIME + 60 * 60_000,
  });
  mock.clock.install();

  const extension = nodeRequire(join(root, 'out', 'src', 'extension.js')) as typeof ExtensionModule;
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: mock.globalState,
    globalStorageUri: MockUri.file(damagedDirectory),
    extensionUri: MockUri.file(root),
    extension: { id: 'theeussx.dev-wrapped', packageJSON: manifest },
    asAbsolutePath: (relative: string) => join(root, relative),
  } as unknown as ExtensionContext;

  await t.test('the extension starts on a fresh database', async () => {
    mock.answers.information = () => undefined;
    await extension.activate(context);
    await mock.clock.settle();

    assert.ok(
      readdirSync(damagedDirectory).some((name) => name.startsWith('devwrapped-data.corrupt-')),
      'the unreadable file is kept aside'
    );
    assert.ok(
      mock.outputLines.some((line) => line.includes('kept aside')),
      'the user can see what happened in the log'
    );
    assert.equal(mock.statusBar.text, '$(graph) no activity yet');
    assert.equal(mock.clock.pending().intervals >= 1, true, 'tracking still runs');
  });

  await t.test('the damaged file is still on disk for inspection', () => {
    const quarantined = readdirSync(damagedDirectory).filter((name) =>
      name.startsWith('devwrapped-data.corrupt-')
    );
    assert.equal(quarantined.length, 1);
    const kept = readFileSync(join(damagedDirectory, quarantined[0] ?? ''), 'utf8');
    assert.match(kept, /"days":$/, 'the original bytes are untouched');
  });

  await extension.deactivate();
  mock.clock.restore();
});
