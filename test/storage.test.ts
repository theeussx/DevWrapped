/**
 * Storage: atomic writes, merging deltas, safety copies, recovery and pruning.
 *
 * Every test uses its own temporary directory, so nothing outside the test
 * process is ever touched.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Database } from '../src/storage/Database';
import { buildJsonBackup, buildCsvExports, dailyCsv } from '../src/storage/Exporter';
import { previewImport } from '../src/storage/Importer';
import { emptyLiveContribution, type DatabaseDelta } from '../src/types/delta';
import { DB_SCHEMA_VERSION, createDayStats, type DatabaseData } from '../src/types/statistics';
import { MS_PER_HOUR } from '../src/utils/time';

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'devwrapped-test-'));
  return directory;
}

function deltaFor(date: string, ms: number, extras: Partial<DatabaseDelta> = {}): DatabaseDelta {
  const day = emptyLiveContribution(date);
  day.ms = ms;
  day.languages = { typescript: ms };
  day.hourly[10] = ms;
  return { days: { [date]: day }, sessions: [], projects: {}, ...extras };
}

test('a fresh database is created empty and flushed to disk', async () => {
  const directory = await tempDir();
  const database = await Database.open({ directory });
  assert.equal(database.loadOutcome.status, 'created');
  assert.equal(database.data.meta.schemaVersion, DB_SCHEMA_VERSION);

  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  assert.equal(database.isDirty, true);
  await database.flush();
  assert.equal(database.isDirty, false);

  const written = JSON.parse(await fs.readFile(database.filePath, 'utf8')) as DatabaseData;
  assert.equal(written.days['2026-10-01']?.activeTime, MS_PER_HOUR);
  assert.ok(database.sizeBytes > 0);
});

test('deltas merge additively and sessions are de-duplicated by id', async () => {
  const directory = await tempDir();
  const database = await Database.open({ directory });
  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  const recent = Date.now() - 60_000;
  database.applyDelta({
    days: {},
    sessions: [
      { id: 's1', startTime: recent, endTime: recent + 60_000, duration: 60_000, language: 'typescript' },
      { id: 's1', startTime: recent, endTime: recent + 60_000, duration: 60_000, language: 'typescript' },
    ],
    projects: { aaaa: { id: 'aaaa', name: 'api', firstSeen: recent, lastSeen: recent } },
  });
  await database.flush();

  assert.equal(database.data.days['2026-10-01']?.activeTime, 2 * MS_PER_HOUR);
  assert.equal(database.data.sessions.length, 1);
  assert.equal(database.data.projects.aaaa?.name, 'api');
});

test('flush writes the previous file to the .bak slot', async () => {
  const directory = await tempDir();
  const database = await Database.open({ directory });
  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  await database.flush();
  const first = await fs.readFile(database.filePath, 'utf8');

  database.applyDelta(deltaFor('2026-10-02', 2 * MS_PER_HOUR));
  await database.flush();

  const backup = await fs.readFile(database.backupPath, 'utf8');
  assert.equal(backup, first);
  const current = JSON.parse(await fs.readFile(database.filePath, 'utf8')) as DatabaseData;
  assert.equal(current.days['2026-10-02']?.activeTime, 2 * MS_PER_HOUR);
});

test('a corrupt file is kept aside and the backup is used', async () => {
  const directory = await tempDir();
  const database = await Database.open({ directory });
  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  await database.flush();
  database.applyDelta(deltaFor('2026-10-02', MS_PER_HOUR));
  await database.flush();

  await fs.writeFile(database.filePath, '{ this is not json', 'utf8');
  const reopened = await Database.open({ directory });
  assert.equal(reopened.loadOutcome.status, 'recovered');
  assert.ok(reopened.data.days['2026-10-01']);

  const files = await fs.readdir(directory);
  assert.ok(files.some((file) => file.includes('.corrupt-')));
});

test('a database that cannot be read at all starts empty without deleting files', async () => {
  const directory = await tempDir();
  await fs.writeFile(join(directory, 'devwrapped-data.json'), 'garbage', 'utf8');
  const database = await Database.open({ directory });
  assert.equal(database.loadOutcome.status, 'reset');
  assert.equal(database.loadOutcome.quarantined !== undefined, true);
  const files = await fs.readdir(directory);
  assert.equal(files.filter((file) => file.includes('.corrupt-')).length, 1);
});

test('safety copies are written next to the database and keep the data', async () => {
  const directory = await tempDir();
  const database = await Database.open({ directory });
  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  const copy = await database.safetyCopy('before-reset');
  const content = JSON.parse(await fs.readFile(copy, 'utf8')) as DatabaseData;
  assert.equal(content.days['2026-10-01']?.activeTime, MS_PER_HOUR);
});

test('reset clears the history but keeps the metadata', async () => {
  const directory = await tempDir();
  const database = await Database.open({ directory });
  database.data.meta.privacySalt = 'salt-value';
  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  await database.flush();

  database.reset();
  await database.flush();
  assert.deepEqual(database.data.days, {});
  assert.equal(database.data.sessions.length, 0);
  assert.equal(database.data.meta.privacySalt, 'salt-value');

  const reloaded = await Database.open({ directory });
  assert.deepEqual(reloaded.data.days, {});
});

test('sessions outside the retention window are pruned', async () => {
  const directory = await tempDir();
  let now = new Date(2026, 9, 1, 12).getTime();
  const database = await Database.open({ directory, now: () => now });
  const day = createDayStats('2026-10-01');
  day.activeTime = MS_PER_HOUR;
  database.applyDelta({
    days: { '2026-10-01': { ...emptyLiveContribution('2026-10-01'), ms: MS_PER_HOUR } },
    sessions: [
      { id: 'old', startTime: now - 400 * 24 * 60 * 60 * 1000, endTime: now - 400 * 24 * 60 * 60 * 1000 + 1000, duration: 1000 },
      { id: 'recent', startTime: now - 1000, endTime: now, duration: 1000 },
    ],
    projects: {},
  });
  database.setRetentionDays(365);
  const removed = database.prune();
  assert.equal(removed, 1);
  assert.deepEqual(database.data.sessions.map((session) => session.id), ['recent']);
  assert.equal(day.activeTime, MS_PER_HOUR);
  await database.flush();

  // Moving the clock forward prunes again on the next flush.
  now += 400 * 24 * 60 * 60 * 1000;
  database.applyDelta(deltaFor('2027-01-01', MS_PER_HOUR));
  await database.flush();
  assert.equal(database.data.sessions.length, 0);
});

test('the JSON backup never contains the privacy salt', () => {
  const data: DatabaseData = {
    meta: {
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: 0,
      updatedAt: 0,
      retentionDays: 365,
      privacySalt: 'super-secret-salt',
      onboarded: true,
    },
    days: {},
    sessions: [],
    projects: {},
  };
  const backup = buildJsonBackup(data, { version: '1.0.0', now: 0, locale: 'en' });
  assert.equal(backup.includes('super-secret-salt'), false);
  const parsed = JSON.parse(backup) as { format: string; data: { meta: { privacySalt: string } } };
  assert.equal(parsed.format, 'dev-wrapped-backup');
  assert.equal(parsed.data.meta.privacySalt, '');
});

test('CSV exports are well formed and safe', () => {
  const data: DatabaseData = {
    meta: {
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: 0,
      updatedAt: 0,
      retentionDays: 365,
      privacySalt: '',
      onboarded: true,
    },
    days: {
      '2026-10-01': {
        ...createDayStats('2026-10-01'),
        activeTime: MS_PER_HOUR,
        languages: { typescript: MS_PER_HOUR },
        projects: { aaaa: MS_PER_HOUR },
      },
    },
    sessions: [
      { id: 's1', startTime: 0, endTime: 1000, duration: 1000, language: 'typescript', project: 'aaaa', projectName: '=cmd' },
    ],
    projects: { aaaa: { id: 'aaaa', name: 'api', firstSeen: 0, lastSeen: 0 } },
  };
  const files = buildCsvExports(data);
  assert.deepEqual(files.map((file) => file.name), ['daily.csv', 'sessions.csv', 'languages.csv', 'projects.csv']);
  const csv = dailyCsv(data);
  assert.ok(csv.startsWith('date,active_minutes,'));
  assert.ok(csv.includes('2026-10-01,60,'));
  assert.equal(files[1]?.content.includes("'=cmd"), true);
});

test('import refuses forbidden keys, broken JSON and empty backups', () => {
  const options = { now: 0, retentionDays: 365 };

  const forbidden = previewImport(
    JSON.stringify({ format: 'dev-wrapped-backup', data: { days: {}, sessions: [], projects: {}, files: [{ filename: 'a.ts' }] } }),
    options
  );
  assert.equal(forbidden.ok, false);
  assert.ok(forbidden.forbiddenKeys.length > 0);

  const broken = previewImport('{nope', options);
  assert.equal(broken.ok, false);

  const empty = previewImport(JSON.stringify({ days: {}, sessions: [], projects: {} }), options);
  assert.equal(empty.ok, false);

  const valid = previewImport(
    JSON.stringify({
      format: 'dev-wrapped-backup',
      data: {
        meta: { retentionDays: 365, privacySalt: '' },
        days: {
          '2026-10-01': {
            activeTime: MS_PER_HOUR,
            sessions: 1,
            languages: { typescript: MS_PER_HOUR },
            projects: {},
            hourly: new Array(24).fill(0),
          },
        },
        sessions: [],
        projects: {},
      },
    }),
    options
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.stats.days, 1);
  assert.equal(valid.stats.activeTimeMs, MS_PER_HOUR);
  assert.equal(valid.data?.days['2026-10-01']?.activeTime, MS_PER_HOUR);
});

test('a delta recorded during a write is never lost', async () => {
  const directory = await tempDir();
  const database = await Database.open({ directory });

  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  const write = database.flush();
  // The tracker keeps counting while the file is being written.
  database.applyDelta(deltaFor('2026-10-01', MS_PER_HOUR));
  await write;

  assert.equal(database.isDirty, true, 'changes made during the write must stay pending');
  await database.flush();
  const stored = JSON.parse(await fs.readFile(database.filePath, 'utf8')) as DatabaseData;
  assert.equal(stored.days['2026-10-01']?.activeTime, 2 * MS_PER_HOUR, 'both deltas must reach the disk');
});
