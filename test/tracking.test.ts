/**
 * Activity tracking: time accounting, idle handling, pause and file counters.
 *
 * The tracker is tested with a fake clock and a fake editor, which makes every
 * rule explicit: idle time is never counted, a tick is never counted twice,
 * pausing stops the accounting and a short session is discarded.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ActivityTracker, TICK_MS, type ActivityEvent, type ActivitySource, type DocumentSnapshot } from '../src/tracking/ActivityTracker';
import { SessionManager } from '../src/tracking/SessionManager';
import type { DatabaseDelta } from '../src/types/delta';
import { DEFAULT_SETTINGS, type WrappedSettings } from '../src/types/config';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../src/utils/time';

class FakeSource implements ActivitySource {
  public document: DocumentSnapshot | undefined = { documentKey: 'doc-1', language: 'typescript', projectId: 'aaaa', projectName: 'api' };
  public focused = true;
  public snapshot = 'doc-1|1|clean';
  public handler: ((event: ActivityEvent) => void) | undefined;

  public listen(handler: (event: ActivityEvent) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  public currentDocument(): DocumentSnapshot | undefined {
    return this.document;
  }

  public isFocused(): boolean {
    return this.focused;
  }

  public stateSnapshot(): string {
    return this.snapshot;
  }

  public emit(event: ActivityEvent): void {
    if (this.handler) {
      this.handler(event);
    }
  }
}

interface Harness {
  tracker: ActivityTracker;
  source: FakeSource;
  deltas: DatabaseDelta[];
  sessionsEnded: number;
  advance(ms: number): void;
  settings: WrappedSettings;
}

function createHarness(): Harness {
  let now = new Date(2026, 9, 1, 10, 0, 0, 0).getTime();
  const settings: WrappedSettings = { ...DEFAULT_SETTINGS, enableNotifications: false };
  const source = new FakeSource();
  const deltas: DatabaseDelta[] = [];
  const state = { sessionsEnded: 0 };

  const tracker = new ActivityTracker({
    source,
    settings: () => settings,
    onDelta: (delta) => deltas.push(delta),
    onSessionEnded: () => {
      state.sessionsEnded += 1;
    },
    now: () => now,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  tracker.start();

  return {
    tracker,
    source,
    deltas,
    settings,
    get sessionsEnded() {
      return state.sessionsEnded;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

function totalMs(deltas: DatabaseDelta[]): number {
  return deltas.reduce((sum, delta) => {
    return (
      sum +
      Object.values(delta.days).reduce((daySum, day) => daySum + day.ms, 0)
    );
  }, 0);
}

test('a changed editor state credits the elapsed tick', () => {
  const harness = createHarness();
  harness.advance(TICK_MS);
  harness.source.snapshot = 'doc-1|2|dirty';
  harness.tracker.tick();

  assert.equal(totalMs(harness.deltas), TICK_MS);
  harness.tracker.dispose();
});

test('an unchanged editor state does not credit time', () => {
  const harness = createHarness();
  harness.advance(TICK_MS);
  harness.source.snapshot = 'doc-1|2|dirty';
  harness.tracker.tick();
  const first = totalMs(harness.deltas);

  harness.advance(TICK_MS);
  harness.tracker.tick();
  harness.advance(TICK_MS);
  harness.tracker.tick();

  assert.equal(totalMs(harness.deltas), first);
  harness.tracker.dispose();
});

test('an explicit editor event counts even without a state change', () => {
  const harness = createHarness();
  harness.advance(TICK_MS);
  harness.source.emit({ kind: 'documentSaved', at: Date.now(), documentKey: 'doc-9', language: 'typescript' });
  harness.tracker.tick();
  assert.equal(totalMs(harness.deltas), TICK_MS);
  harness.tracker.dispose();
});

test('suspended time is capped so a closed laptop cannot book hours', () => {
  const harness = createHarness();
  harness.advance(6 * MS_PER_HOUR); // machine was asleep for six hours
  harness.source.snapshot = 'doc-1|3|dirty';
  harness.tracker.tick();
  assert.equal(totalMs(harness.deltas), TICK_MS * 2);
  harness.tracker.dispose();
});

test('an unfocused window never counts as coding', () => {
  const harness = createHarness();
  harness.source.focused = false;
  harness.advance(TICK_MS);
  harness.source.snapshot = 'doc-1|4|dirty';
  harness.tracker.tick();
  assert.equal(totalMs(harness.deltas), 0);
  harness.tracker.dispose();
});

test('the idle timeout ends the session and discards the idle time', () => {
  const harness = createHarness();
  harness.advance(TICK_MS);
  harness.source.snapshot = 'doc-1|5|dirty';
  harness.tracker.tick();
  const afterFirst = totalMs(harness.deltas);
  assert.equal(harness.tracker.isSessionActive, true);

  // Six minutes without any change: beyond the default ten minute timeout?
  // Not yet — so nothing happens.
  harness.advance(6 * MS_PER_MINUTE);
  harness.tracker.tick();
  assert.equal(harness.tracker.isSessionActive, true);
  assert.equal(totalMs(harness.deltas), afterFirst);

  // Eleven minutes: the session ends and the idle stretch is not counted.
  harness.advance(5 * MS_PER_MINUTE);
  harness.tracker.tick();
  assert.equal(harness.tracker.isSessionActive, false);
  assert.equal(totalMs(harness.deltas), afterFirst);
  harness.tracker.dispose();
});

test('pausing stops the accounting until tracking is resumed', () => {
  const harness = createHarness();
  harness.advance(TICK_MS);
  harness.source.snapshot = 'doc-1|6|dirty';
  harness.tracker.tick();
  const before = totalMs(harness.deltas);

  harness.tracker.pause('user');
  harness.source.snapshot = 'doc-1|7|dirty';
  harness.advance(TICK_MS);
  harness.tracker.tick();
  assert.equal(totalMs(harness.deltas), before);
  assert.equal(harness.tracker.status().state, 'paused');
  assert.equal(harness.tracker.status().reason, 'user');

  harness.tracker.resume();
  harness.source.snapshot = 'doc-1|8|dirty';
  harness.advance(TICK_MS);
  harness.tracker.tick();
  assert.equal(totalMs(harness.deltas) > before, true);
  harness.tracker.dispose();
});

test('document counters are de-duplicated per document and day', () => {
  const harness = createHarness();
  for (let index = 0; index < 5; index += 1) {
    harness.source.emit({ kind: 'documentChanged', at: Date.now(), documentKey: 'doc-1', language: 'typescript' });
  }
  harness.source.emit({ kind: 'documentChanged', at: Date.now(), documentKey: 'doc-2', language: 'typescript' });
  harness.source.emit({ kind: 'documentSaved', at: Date.now(), documentKey: 'doc-1', language: 'typescript' });
  harness.tracker.flush();

  const modified = harness.deltas.reduce(
    (sum, delta) => sum + Object.values(delta.days).reduce((daySum, day) => daySum + day.filesModified, 0),
    0
  );
  const saved = harness.deltas.reduce(
    (sum, delta) => sum + Object.values(delta.days).reduce((daySum, day) => daySum + day.filesSaved, 0),
    0
  );
  assert.equal(modified, 2);
  assert.equal(saved, 1);
  harness.tracker.dispose();
});

test('a session under one second is discarded', () => {
  let now = 1_000_000;
  const manager = new SessionManager({
    inactivityTimeoutMs: () => 10 * MS_PER_MINUTE,
    trackLanguages: () => true,
    trackProjects: () => true,
    now: () => now,
  });
  manager.recordActive(200, now, { language: 'typescript' });
  now += 200;
  assert.equal(manager.end('timeout'), undefined);
});

test('active time is split across hour buckets', () => {
  const start = new Date(2026, 9, 1, 8, 30, 0, 0).getTime();
  const now = start + 2 * MS_PER_HOUR;
  const manager = new SessionManager({
    // A generous timeout here: a real slice never exceeds two ticks.
    inactivityTimeoutMs: () => 24 * MS_PER_HOUR,
    trackLanguages: () => true,
    trackProjects: () => true,
    now: () => now,
  });
  manager.recordActive(2 * MS_PER_HOUR, now, { language: 'typescript' });
  const deltas = manager.takeDeltas();
  assert.equal(deltas.length, 1);
  const hourly = deltas[0]?.hourly ?? [];
  assert.equal(hourly[8], 30 * MS_PER_MINUTE);
  assert.equal(hourly[9], MS_PER_HOUR);
  assert.equal(hourly[10], 30 * MS_PER_MINUTE);
  assert.equal(deltas[0]?.ms, 2 * MS_PER_HOUR);
});

test('a session that crosses midnight is attributed to both days', () => {
  const midnight = new Date(2026, 9, 2, 0, 0, 0, 0).getTime();
  const now = midnight + 30 * MS_PER_MINUTE;
  const manager = new SessionManager({
    inactivityTimeoutMs: () => 24 * MS_PER_HOUR,
    trackLanguages: () => true,
    trackProjects: () => true,
    now: () => now,
  });
  manager.recordActive(60 * MS_PER_MINUTE, now, { language: 'typescript', projectId: 'aaaa', projectName: 'api' });
  const deltas = manager.takeDeltas();
  assert.equal(deltas.length, 2);
  const byDate: Record<string, number> = {};
  for (const delta of deltas) {
    byDate[delta.date] = delta.ms;
  }
  assert.equal(byDate['2026-10-01'], 30 * MS_PER_MINUTE);
  assert.equal(byDate['2026-10-02'], 30 * MS_PER_MINUTE);
});

test('a finished session carries its dominant language and project', () => {
  let now = new Date(2026, 9, 1, 9, 0, 0, 0).getTime();
  const manager = new SessionManager({
    inactivityTimeoutMs: () => 10 * MS_PER_MINUTE,
    trackLanguages: () => true,
    trackProjects: () => true,
    now: () => now,
  });
  manager.recordActive(5 * MS_PER_MINUTE, now, { language: 'markdown', projectId: 'aaaa', projectName: 'api' });
  now += MS_PER_HOUR;
  manager.recordActive(10 * MS_PER_MINUTE, now, { language: 'typescript', projectId: 'aaaa', projectName: 'api' });
  const ended = manager.end('timeout', now + 1000);
  assert.ok(ended);
  assert.equal(ended?.session.language, 'typescript');
  assert.equal(ended?.session.projectName, 'api');
  assert.equal(ended?.session.duration, 15 * MS_PER_MINUTE);
  assert.equal(ended?.dayKey, '2026-10-01');
});
