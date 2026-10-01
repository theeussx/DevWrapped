/**
 * Schema validation, normalization and sanitization.
 *
 * The import path is the riskiest part of the extension, so it is tested with
 * hostile inputs: wrong types, out of range counters, forbidden keys and
 * spreadsheet formulas.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countMapSchema,
  findForbiddenKeys,
  normalizeDatabase,
  objectSchema,
  parseJsonSafely,
  stringSchema,
  isValidInactivityTimeout,
  isValidMinimumActiveTime,
} from '../src/security/Validation';
import {
  escapeCsvCell,
  escapeHtml,
  hashIdentifier,
  redactForLog,
  sanitizeFileName,
  sanitizeLanguageId,
  sanitizeProjectName,
  sanitizeText,
  topEntries,
} from '../src/security/Sanitization';
import { DB_SCHEMA_VERSION, createDayStats } from '../src/types/statistics';

test('normalizeDatabase repairs a partial database instead of throwing', () => {
  const result = normalizeDatabase(
    {
      meta: { privacySalt: 'abc', retentionDays: 9999 },
      days: {
        '2026-10-01': { activeTime: 3_600_000, sessions: 2, languages: { typescript: 3_600_000 } },
        'not-a-day': { activeTime: 1 },
      },
      sessions: [{ id: 's1', startTime: 100, endTime: 200, duration: 100 }],
      projects: { abc: { name: 'api', firstSeen: 1, lastSeen: 2 } },
    },
    1_000_000,
    365
  );

  assert.equal(result.data.days['2026-10-01']?.activeTime, 3_600_000);
  assert.equal(result.data.days['not-a-day'], undefined);
  assert.equal(result.data.days['2026-10-01']?.hourly.length, 24);
  assert.equal(result.data.meta.schemaVersion, DB_SCHEMA_VERSION);
  assert.equal(result.data.meta.retentionDays, 365);
  assert.ok(result.issues.length > 0);
  assert.equal(result.repaired, true);
});

test('normalizeDatabase accepts an empty object and produces an empty database', () => {
  const result = normalizeDatabase({}, 42, 365);
  assert.deepEqual(result.data.days, {});
  assert.deepEqual(result.data.sessions, []);
  assert.equal(result.data.meta.createdAt, 42);
  assert.equal(result.data.meta.schemaVersion, DB_SCHEMA_VERSION);
});

test('counters are clamped and negative or non numeric values dropped', () => {
  const schema = countMapSchema({ maxEntries: 3, maxValue: 1000 });
  const issues: Array<{ path: string; message: string }> = [];
  const parsed = schema.validate({ a: 5, b: -3, c: 'oops', d: 5_000_000, e: 1 }, '$.counts', issues);
  assert.deepEqual(parsed, { a: 5, d: 1000, e: 1 });
});

test('forbidden keys are found at any depth and sorted', () => {
  const hits = findForbiddenKeys({
    days: { '2026-10-01': { fileNames: ['a.ts'], content: 'secret' } },
    token: 'xyz',
    nested: { source: 'code' },
  });
  assert.deepEqual(hits, ['$.days.2026-10-01.content', '$.days.2026-10-01.fileNames', '$.nested.source', '$.token']);
});

test('parseJsonSafely never throws and enforces the size limit', () => {
  assert.deepEqual(parseJsonSafely('{"a":1}'), { ok: true, value: { a: 1 } });
  const broken = parseJsonSafely('{oops');
  assert.equal(broken.ok, false);
  const tooBig = parseJsonSafely('x'.repeat(32), 16);
  assert.equal(tooBig.ok, false);
});

test('objectSchema drops unknown fields and keeps valid ones', () => {
  const schema = objectSchema<{ name: string; size?: Record<string, number> }>({
    name: stringSchema({ maxLength: 10 }),
    size: { optional: true, schema: countMapSchema({ maxEntries: 1, maxValue: 10 }) },
  });
  const issues: Array<{ path: string; message: string }> = [];
  const value = schema.validate({ name: 'api', size: { a: 1 }, extra: 'ignored' }, '$', issues);
  assert.deepEqual(value, { name: 'api', size: { a: 1 } });
});

test('text sanitization strips control characters and truncates', () => {
  assert.equal(sanitizeText('hello\u0000\u001b[31m world'), 'hello[31m world');
  assert.equal(sanitizeText('  many   spaces \n here '), 'many spaces here');
  assert.equal(sanitizeText('abcdef', 4), 'abc…');
  assert.equal(sanitizeText(42), '');
});

test('project names keep only the folder name', () => {
  // secret-scan:allow — deliberately fake paths, used to prove they are stripped
  assert.equal(sanitizeProjectName('/home/user/code/api/'), 'api');
  assert.equal(sanitizeProjectName('C:\\Users\\dev\\project'), 'project');
  assert.equal(sanitizeProjectName('   '), 'Untitled project');
  assert.equal(sanitizeProjectName(12), 'Untitled project');
});

test('language ids are restricted to a safe alphabet', () => {
  assert.equal(sanitizeLanguageId('TypeScript'), 'typescript');
  assert.equal(sanitizeLanguageId('python'), 'python');
  // secret-scan:allow — fake traversal target, used to prove it is neutralized
  assert.equal(sanitizeLanguageId('../../etc/passwd'), 'plaintext');
  assert.equal(sanitizeLanguageId(''), 'plaintext');
  assert.equal(sanitizeLanguageId(undefined), 'plaintext');
});

test('HTML escaping escapes every dangerous character', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("It's fine & dandy"), 'It&#39;s fine &amp; dandy');
});

test('CSV cells cannot become formulas', () => {
  assert.equal(escapeCsvCell('=1+1'), "'=1+1");
  assert.equal(escapeCsvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(escapeCsvCell('plain'), 'plain');
  assert.equal(escapeCsvCell('with,comma'), '"with,comma"');
  assert.equal(escapeCsvCell('with"quote'), '"with""quote"');
});

test('file names cannot escape the chosen folder', () => {
  // secret-scan:allow — fake traversal target, used to prove it is neutralized
  assert.equal(sanitizeFileName('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeFileName('daily.csv'), 'daily.csv');
  assert.equal(sanitizeFileName('a/b\\c'), 'a-b-c');
  assert.equal(sanitizeFileName('   '), 'code-wrapped');
  assert.equal(sanitizeFileName('CON'), 'CON-file');
});

test('log redaction removes paths and tokens', () => {
  // secret-scan:allow — fake path and fake token, used to prove redaction works
  const redacted = redactForLog('open /home/user/projects/app/src/index.ts with ghp_abcdefghijklmnopqrst');
  assert.equal(redacted.includes('/home/user/projects/app/src/index.ts'), false);
  assert.equal(redacted.includes('ghp_abcdefghijklmnopqrst'), false);
});

test('project hashes are stable and salt dependent', () => {
  // secret-scan:allow — fake workspace paths, used to prove hashing is stable
  const a = hashIdentifier('file:///home/user/app', 'salt-one');
  const b = hashIdentifier('file:///home/user/app', 'salt-one');
  const c = hashIdentifier('file:///home/user/app', 'salt-two');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
});

test('topEntries sorts and limits', () => {
  assert.deepEqual(topEntries({ b: 2, a: 3, c: 0 }, 2), [
    ['a', 3],
    ['b', 2],
  ]);
});

test('option sets are validated', () => {
  assert.equal(isValidInactivityTimeout(10), true);
  assert.equal(isValidInactivityTimeout(11), false);
  assert.equal(isValidMinimumActiveTime(30), true);
  assert.equal(isValidMinimumActiveTime(5), false);
});

test('day records always carry 24 hourly buckets', () => {
  const day = createDayStats('2026-10-01');
  assert.equal(day.hourly.length, 24);
  assert.equal(day.activeTime, 0);
  assert.deepEqual(day.languages, {});
});
