/**
 * Security and privacy guarantees, enforced as tests.
 *
 * These assertions protect the promises made on the Privacy page and in the
 * README: no network API, no dynamic code execution, no document reading, a
 * strict webview policy and a retrospective export that cannot run scripts.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { buildWrappedHtml } from '../src/storage/WrappedExport';
import { buildWrapped } from '../src/analytics/Wrapped';
import { computeStreaks } from '../src/analytics/Streaks';
import type { StatsSource } from '../src/analytics/Aggregator';
import {
  NETWORK_STATEMENT,
  PRIVACY_COLLECTED,
  PRIVACY_FACTS,
  PRIVACY_NEVER_COLLECTED,
  PRIVACY_SAFETY,
  PRIVACY_SUMMARY,
} from '../src/security/Privacy';
import { MIN_YEAR, MAX_YEAR, describeRejectedMessage, normalizeYear, parseWebviewMessage } from '../src/webview/messages';
import { DB_SCHEMA_VERSION, createDayStats, type DatabaseData } from '../src/types/statistics';
import { MS_PER_HOUR } from '../src/utils/time';

const ROOT = join(__dirname, '..', '..');

/** Reads every shipped source file (compiled output is not inspected). */
async function sourceFiles(): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.ts')) {
        continue;
      }
      files.push({ path: relative(ROOT, absolute), content: await fs.readFile(absolute, 'utf8') });
    }
  }
  await walk(join(ROOT, 'src'));
  return files;
}

test('no shipped source imports a network or process module', async () => {
  const forbidden = [
    /from\s+'(?:node:)?(?:http|https|net|dgram|tls|dns|child_process)'/,
    /require\(\s*'(?:node:)?(?:http|https|net|dgram|tls|dns|child_process)'\s*\)/,
    /\bfetch\s*\(/,
    /new\s+WebSocket\s*\(/,
  ];
  const files = await sourceFiles();
  assert.ok(files.length > 20, 'expected the extension sources to be present');
  for (const file of files) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(file.content), false, `${file.path} matches ${pattern}`);
    }
  }
});

test('no shipped source uses dynamic code execution', async () => {
  const files = await sourceFiles();
  for (const file of files) {
    assert.equal(/\beval\s*\(/.test(file.content), false, `${file.path} uses eval`);
    assert.equal(/new\s+Function\s*\(/.test(file.content), false, `${file.path} uses Function()`);
  }
});

test('the extension never reads document text', async () => {
  const files = await sourceFiles();
  for (const file of files) {
    if (file.path.includes('test')) {
      continue;
    }
    assert.equal(/getText\s*\(/.test(file.content), false, `${file.path} reads document text`);
    assert.equal(/readFileSync\s*\(\s*document/.test(file.content), false, `${file.path} reads a document`);
  }
});

test('the webview policy blocks remote content, frames and connections', async () => {
  const dashboard = await fs.readFile(join(ROOT, 'src', 'webview', 'Dashboard.ts'), 'utf8');
  assert.ok(dashboard.includes("default-src 'none'"));
  assert.ok(dashboard.includes('connect-src \'none\''));
  assert.ok(dashboard.includes("frame-src 'none'"));
  assert.ok(dashboard.includes('script-src \'nonce-'));
  assert.ok(dashboard.includes('enableCommandUris: false'));
  assert.ok(dashboard.includes('enableForms: false'));
  assert.ok(dashboard.includes('localResourceRoots'));
  assert.equal(/unsafe-inline/.test(dashboard), false);
  assert.equal(/unsafe-eval/.test(dashboard), false);
});

test('webview client scripts never use inline styles or remote origins', async () => {
  const directory = join(ROOT, 'media');
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.js'));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const content = await fs.readFile(join(directory, file), 'utf8');
    assert.equal(/innerHTML/.test(content), false, `${file} uses innerHTML`);
    assert.equal(/setAttribute\(\s*'style'/.test(content), false, `${file} sets an inline style`);
    // The SVG namespace ("http://www.w3.org/2000/svg") is an identifier, not a request.
    assert.equal(
      /https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(content),
      false,
      `${file} references a remote origin`
    );
    assert.equal(/\beval\s*\(/.test(content), false, `${file} uses eval`);
  }
});

test('the exported retrospective contains no script and escapes its content', () => {
  const data: DatabaseData = {
    meta: {
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: 0,
      updatedAt: 0,
      retentionDays: 365,
      privacySalt: 'salt',
      onboarded: true,
    },
    days: {
      '2026-10-01': {
        ...createDayStats('2026-10-01'),
        activeTime: 2 * MS_PER_HOUR,
        sessions: 1,
        languages: { '<script>alert(1)</script>': MS_PER_HOUR },
        projects: { aaaa: MS_PER_HOUR },
      },
      '2026-11-01': {
        ...createDayStats('2026-11-01'),
        activeTime: MS_PER_HOUR,
        sessions: 1,
        languages: { typescript: MS_PER_HOUR },
      },
    },
    sessions: [],
    projects: { aaaa: { id: 'aaaa', name: '<img src=x onerror=alert(1)>', firstSeen: 0, lastSeen: 0 } },
  };
  const source: StatsSource = {
    data,
    now: new Date(2026, 11, 1).getTime(),
    locale: 'en',
    weekStartsOn: 1,
    minimumActiveTimeMs: 30 * 60_000,
  };
  const payload = buildWrapped(source, 2026, { streaks: computeStreaks(source) });
  const html = buildWrappedHtml(payload, { version: '1.0.0', generatedAt: 0, locale: 'en' });

  assert.equal(/<script/i.test(html), false);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;'));
  assert.ok(html.includes("script-src 'none'"));
  assert.ok(html.includes("default-src 'none'"));
});

test('privacy statements stay complete and free of promises about tracking users', () => {
  assert.ok(PRIVACY_COLLECTED.length >= 4);
  assert.ok(PRIVACY_NEVER_COLLECTED.length >= 6);
  assert.ok(PRIVACY_SAFETY.length >= 5);
  assert.ok(PRIVACY_FACTS.length >= 6);
  const joined = [
    PRIVACY_COLLECTED.join(' '),
    PRIVACY_NEVER_COLLECTED.join(' '),
    PRIVACY_SAFETY.join(' '),
    NETWORK_STATEMENT,
    PRIVACY_SUMMARY,
  ]
    .join(' ')
    .toLowerCase();
  assert.ok(joined.includes('no network') || joined.includes('never performs network requests') || joined.includes('offline'));
  assert.ok(joined.includes('source code'));
  assert.equal(/we sell|share your data|third party/.test(joined), false);
});

test('webview messages are validated field by field', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseWebviewMessage({ type: 'navigate', page: 'calendar' }), { type: 'navigate', page: 'calendar' });
  assert.deepEqual(parseWebviewMessage({ type: 'selectYear', year: '2025' }), { type: 'selectYear', year: 2025 });
  assert.deepEqual(parseWebviewMessage({ type: 'export', format: 'csv' }), { type: 'export', format: 'csv' });

  const rejected = [
    null,
    42,
    'ready',
    [],
    { type: 'navigate' },
    { type: 'navigate', page: 'admin' },
    { type: 'navigate', page: { toString: () => 'overview' } },
    { type: 'selectYear', year: 1900 },
    { type: 'selectYear', year: MAX_YEAR + 1 },
    { type: 'selectYear', year: 2025.5 },
    { type: 'export' },
    { type: 'export', format: 'zip' },
    { type: 'runCommand', command: 'workbench.action.terminal.new' },
    { type: 'ready', extra: 'ignored' },
  ];
  for (const message of rejected) {
    const parsed = parseWebviewMessage(message);
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'ready') {
      // Extra properties are dropped, the message itself is still valid.
      assert.deepEqual(parsed, { type: 'ready' });
      continue;
    }
    assert.equal(parsed, undefined, `expected ${JSON.stringify(message)} to be rejected`);
  }

  assert.equal(normalizeYear(MIN_YEAR), MIN_YEAR);
  assert.equal(normalizeYear(MAX_YEAR), MAX_YEAR);
  assert.equal(normalizeYear('2024'), 2024);
  assert.equal(normalizeYear(undefined), undefined);
  assert.ok(describeRejectedMessage({ type: 'runCommand' }).includes('runCommand'));
  assert.ok(describeRejectedMessage(null).length > 0);
});
