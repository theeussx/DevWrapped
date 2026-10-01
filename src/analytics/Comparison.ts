/**
 * Period comparisons.
 *
 * The dashboard answers "how does this week compare with the last one?" with
 * numbers only: no improvement score, no verdict, no colour that implies good
 * or bad. A period without a baseline reports `available: false` and a short
 * explanation instead of a misleading "0%".
 */

import type { ComparisonView } from '../types/analytics';
import { formatDuration, percentChange } from '../utils/format';
import type { RangeTotals } from './Aggregator';

export interface ComparisonOptions {
  id: string;
  title: string;
  currentLabel: string;
  previousLabel: string;
}

/** Builds the comparison of two aggregated ranges. */
export function compareTotals(
  current: RangeTotals,
  previous: RangeTotals | undefined,
  options: ComparisonOptions
): ComparisonView {
  const currentMs = current.ms;
  const previousMs = previous?.ms ?? 0;
  const hasBaseline = previous !== undefined && (previous.activeDays > 0 || previousMs > 0);

  const view: ComparisonView = {
    id: options.id,
    title: options.title,
    currentLabel: options.currentLabel,
    previousLabel: options.previousLabel,
    currentMs,
    previousMs,
    deltaMs: currentMs - previousMs,
    deltaRatio: hasBaseline ? percentChange(currentMs, previousMs) : null,
    available: hasBaseline,
  };

  if (!hasBaseline) {
    view.message =
      previousMs === 0 && previous !== undefined && previous.activeDays === 0
        ? `No activity recorded for ${options.previousLabel.toLowerCase()} yet, so there is nothing to compare with.`
        : 'Not enough history to compare these periods yet.';
  } else if (previousMs === 0) {
    view.message = `${options.previousLabel} had no recorded active time.`;
  }

  return view;
}

/** One line summary of a comparison, safe to show next to a metric. */
export function comparisonSummary(view: ComparisonView): string {
  if (!view.available) {
    return view.message ?? 'No baseline to compare with.';
  }
  if (view.currentMs === view.previousMs) {
    return `${formatDuration(view.currentMs)} — the same as ${view.previousLabel.toLowerCase()}.`;
  }
  const direction = view.deltaMs > 0 ? 'more' : 'less';
  return `${formatDuration(Math.abs(view.deltaMs))} ${direction} than ${view.previousLabel.toLowerCase()}.`;
}

/** Neutral tone for a comparison chip: never frames a drop as a failure. */
export function comparisonTone(view: ComparisonView): 'neutral' | 'muted' | 'positive' {
  if (!view.available) {
    return 'muted';
  }
  if (view.deltaMs === 0) {
    return 'neutral';
  }
  return 'positive';
}
