/**
 * Streaks.
 *
 * A day counts towards a streak when its active time reaches the configured
 * minimum (10, 30 or 60 minutes). The current streak tolerates "today has not
 * happened yet": if today is still below the threshold, the streak keeps
 * counting from yesterday instead of dropping to zero at midnight.
 *
 * Wording is deliberately neutral: the dashboard reports "18 days in a row",
 * never "you are on fire" or any judgement about the user.
 */

import type { DateKey } from '../types/statistics';
import { MS_PER_MINUTE, dateKey, enumerateDateKeys, parseDateKey } from '../utils/time';
import type { StatsSource } from './Aggregator';
import { dayTotals } from './Aggregator';

export interface StreakResult {
  /** Days in a row up to today (or yesterday) that reached the minimum. */
  current: number;
  /** Longest run in the recorded history. */
  longest: number;
  currentStart?: DateKey;
  longestStart?: DateKey;
  longestEnd?: DateKey;
  /** Qualifying days inside the analysed window. */
  qualifyingDays: number;
  minimumActiveTimeMinutes: number;
  /** Days that were analysed (the whole history by default). */
  analysedDays: number;
}

export interface StreakOptions {
  /** Limit the analysis to the most recent N days (default: whole history). */
  windowDays?: number;
}

/** Computes the streaks of the recorded history. */
export function computeStreaks(source: StatsSource, options: StreakOptions = {}): StreakResult {
  const minimumActiveTimeMinutes = Math.round(source.minimumActiveTimeMs / MS_PER_MINUTE);
  const today = dateKey(source.now);

  const keys = collectDayKeys(source, options.windowDays);
  const qualifying = keys.map((key) => ({ key, qualifies: dayTotals(source, key).qualifies }));
  const qualifyingDays = qualifying.filter((day) => day.qualifies).length;

  // Longest run.
  let longest = 0;
  let longestStart: DateKey | undefined;
  let longestEnd: DateKey | undefined;
  let runStart: DateKey | undefined;
  let runLength = 0;
  for (const day of qualifying) {
    if (day.qualifies) {
      runStart = runStart ?? day.key;
      runLength += 1;
      if (runLength > longest) {
        longest = runLength;
        longestStart = runStart;
        longestEnd = day.key;
      }
    } else {
      runStart = undefined;
      runLength = 0;
    }
  }

  // Current run: walk backwards from today; skip today while it is still
  // below the threshold so the streak does not reset at midnight.
  let current = 0;
  let currentStart: DateKey | undefined;
  const indexByKey = new Map(qualifying.map((day, index) => [day.key, index]));
  let cursor = indexByKey.get(today) ?? qualifying.length - 1;
  if (cursor >= 0 && qualifying[cursor] && !qualifying[cursor]?.qualifies) {
    cursor -= 1;
  }
  for (; cursor >= 0; cursor -= 1) {
    const day = qualifying[cursor];
    if (!day || !day.qualifies) {
      break;
    }
    current += 1;
    currentStart = day.key;
  }

  const result: StreakResult = {
    current,
    longest,
    qualifyingDays,
    minimumActiveTimeMinutes,
    analysedDays: qualifying.length,
  };
  if (currentStart) {
    result.currentStart = currentStart;
  }
  if (longestStart) {
    result.longestStart = longestStart;
  }
  if (longestEnd) {
    result.longestEnd = longestEnd;
  }
  return result;
}

/**
 * Day keys to analyse: every recorded day, plus the days between the first and
 * last record (a gap is a gap, not a missing key).
 */
export function collectDayKeys(source: StatsSource, windowDays?: number): DateKey[] {
  const recorded = Object.keys(source.data.days);
  const firstStored = recorded.sort()[0];
  const today = dateKey(source.now);
  let startKey = firstStored ?? today;
  if (windowDays !== undefined && windowDays > 0) {
    const windowStart = source.now - windowDays * 24 * 60 * MS_PER_MINUTE * 60;
    const candidate = dateKey(windowStart);
    startKey = candidate > startKey ? candidate : startKey;
  }
  const start = parseDateKey(startKey) ?? source.now;
  const lastRecorded = recorded.sort().at(-1);
  const endKey = lastRecorded && lastRecorded > today ? lastRecorded : today;
  return enumerateDateKeys(start, endKey);
}
