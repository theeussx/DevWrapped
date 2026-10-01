/**
 * Calendar helpers.
 *
 * These tests pin the behaviour that the statistics depend on: local days,
 * locally started weeks and DST transitions that must not shift a bucket.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  addMonths,
  dateKey,
  dateKeyRange,
  dayOfWeek,
  daysBetweenDateKeys,
  daysInMonth,
  endOfDay,
  enumerateDateKeys,
  hourOfDay,
  isValidDateKey,
  isValidMonthKey,
  monthKey,
  parseDateKey,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  weekStartKey,
} from '../src/utils/time';

test('dateKey uses the local calendar day', () => {
  const noon = new Date(2026, 9, 1, 12, 30, 0).getTime();
  assert.equal(dateKey(noon), '2026-10-01');
  const lateEvening = new Date(2026, 9, 1, 23, 59, 0).getTime();
  assert.equal(dateKey(lateEvening), '2026-10-01');
  const justAfterMidnight = new Date(2026, 9, 2, 0, 0, 1).getTime();
  assert.equal(dateKey(justAfterMidnight), '2026-10-02');
});

test('monthKey and startOfMonth agree', () => {
  const ts = new Date(2026, 1, 17, 9, 0, 0).getTime();
  assert.equal(monthKey(ts), '2026-02');
  assert.equal(dateKey(startOfMonth(ts)), '2026-02-01');
  assert.equal(dateKey(startOfYear(ts)), '2026-01-01');
});

test('addDays keeps the wall clock time across a DST change', () => {
  // 2026-03-29 is the European DST change; 25 October is the other one.
  const before = new Date(2026, 2, 28, 12, 0, 0).getTime();
  const after = addDays(before, 1);
  assert.equal(new Date(after).getHours(), 12);
  assert.equal(dateKey(after), '2026-03-29');
});

test('daysBetweenDateKeys counts calendar days, not 24 hour blocks', () => {
  assert.equal(daysBetweenDateKeys('2026-03-28', '2026-03-29'), 1);
  assert.equal(daysBetweenDateKeys('2026-10-24', '2026-10-25'), 1);
  assert.equal(daysBetweenDateKeys('2026-01-01', '2026-12-31'), 364);
  assert.equal(daysBetweenDateKeys('2026-01-02', '2026-01-01'), -1);
});

test('weeks start on the configured weekday', () => {
  const wednesday = new Date(2026, 9, 1, 10, 0, 0).getTime();
  assert.equal(dayOfWeek(wednesday), 4); // Thursday
  assert.equal(dateKey(startOfWeek(wednesday, 1)), '2026-09-28'); // Monday
  assert.equal(dateKey(startOfWeek(wednesday, 0)), '2026-09-27'); // Sunday
  assert.equal(weekStartKey(wednesday, 1), '2026-09-28');
});

test('enumerateDateKeys is inclusive and bounded', () => {
  assert.deepEqual(enumerateDateKeys('2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(enumerateDateKeys('2026-10-03', '2026-10-01'), []);
  assert.equal(enumerateDateKeys('2026-01-01', '2026-01-01').length, 1);
});

test('date keys are validated strictly', () => {
  assert.equal(isValidDateKey('2026-10-01'), true);
  assert.equal(isValidDateKey('2026-02-30'), false);
  assert.equal(isValidDateKey('2026-13-01'), false);
  assert.equal(isValidDateKey('01-10-2026'), false);
  assert.equal(isValidDateKey(20261001), false);
  assert.equal(isValidMonthKey('2026-10'), true);
  assert.equal(isValidMonthKey('2026-13'), false);
  assert.equal(parseDateKey('2026-10-01'), startOfDay(new Date(2026, 9, 1, 5, 0, 0).getTime()));
  assert.equal(parseDateKey('nope'), undefined);
});

test('day boundaries and hour buckets', () => {
  const ts = new Date(2026, 4, 5, 7, 45, 0).getTime();
  assert.equal(hourOfDay(ts), 7);
  assert.equal(dateKey(endOfDay(ts) - 1), '2026-05-05');
  const range = dateKeyRange('2026-05-05');
  assert.equal(range.end - range.start, endOfDay(range.start) - startOfDay(range.start));
});

test('month arithmetic clamps to the end of shorter months', () => {
  const january31 = new Date(2026, 0, 31, 12, 0, 0).getTime();
  const february = addMonths(january31, 1);
  assert.equal(dateKey(february), '2026-02-28');
  assert.equal(daysInMonth(2028, 1), 29); // leap year
  assert.equal(daysInMonth(2026, 1), 28);
});
