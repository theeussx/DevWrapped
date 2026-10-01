/**
 * Presentation helpers.
 *
 * Everything here is pure: the webview receives plain strings, so the client
 * never needs `Intl` options that could disagree with the extension host.
 */

import { MS_PER_HOUR, MS_PER_MINUTE } from './time';

/** Human readable names for the languages VS Code reports. */
const LANGUAGE_LABELS: Record<string, string> = {
  bat: 'Batch',
  c: 'C',
  clojure: 'Clojure',
  coffeescript: 'CoffeeScript',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  dart: 'Dart',
  dockerfile: 'Dockerfile',
  elixir: 'Elixir',
  erlang: 'Erlang',
  fsharp: 'F#',
  go: 'Go',
  graphql: 'GraphQL',
  groovy: 'Groovy',
  handlebars: 'Handlebars',
  haskell: 'Haskell',
  html: 'HTML',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  javascriptreact: 'JavaScript React',
  json: 'JSON',
  jsonc: 'JSON with Comments',
  julia: 'Julia',
  kotlin: 'Kotlin',
  less: 'Less',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  objectivec: 'Objective-C',
  objectivecpp: 'Objective-C++',
  perl: 'Perl',
  php: 'PHP',
  plaintext: 'Plain Text',
  powershell: 'PowerShell',
  proto: 'Protocol Buffers',
  pug: 'Pug',
  python: 'Python',
  r: 'R',
  razor: 'Razor',
  ruby: 'Ruby',
  rust: 'Rust',
  sass: 'Sass',
  scala: 'Scala',
  scss: 'SCSS',
  shaderlab: 'ShaderLab',
  shellscript: 'Shell Script',
  sql: 'SQL',
  svelte: 'Svelte',
  swift: 'Swift',
  terraform: 'Terraform',
  twig: 'Twig',
  typescript: 'TypeScript',
  typescriptreact: 'TypeScript React',
  vb: 'Visual Basic',
  vue: 'Vue',
  xml: 'XML',
  yaml: 'YAML',
  zig: 'Zig',
};

const FALLBACK_LOCALE = 'en';

function localeOr(locale: string | undefined): string {
  return locale && locale.length > 0 ? locale : FALLBACK_LOCALE;
}

function safeIntl<T>(factory: () => T, fallback: T): T {
  try {
    return factory();
  } catch {
    return fallback;
  }
}

/** Friendly label for a VS Code language id. */
export function languageLabel(languageId: string | undefined): string {
  if (!languageId || languageId.length === 0) {
    return 'Unknown';
  }
  const known = LANGUAGE_LABELS[languageId.toLowerCase()];
  if (known) {
    return known;
  }
  return languageId
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** `2h 05m`, `47m`, `<1m`, `0m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0m';
  }
  if (ms < MS_PER_MINUTE) {
    return '<1m';
  }
  const totalMinutes = Math.floor(ms / MS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes < 10 ? '0' : ''}${minutes}m`;
}

/** Hours with one decimal (`12.4`). */
export function formatHours(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0';
  }
  const hours = ms / MS_PER_HOUR;
  return hours >= 100 ? String(Math.round(hours)) : hours.toFixed(hours >= 10 ? 0 : 1);
}

/** Localized integer with thousand separators. */
export function formatNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return safeIntl(
    () => new Intl.NumberFormat(localeOr(locale), { maximumFractionDigits: 0 }).format(value),
    String(Math.round(value))
  );
}

/** `42%` (or `42.3%` with `digits`). */
export function formatPercent(ratio: number, digits = 0, locale?: string): string {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return '0%';
  }
  const percent = ratio * 100;
  const fixed = percent >= 99.5 && digits === 0 ? 100 : percent;
  return safeIntl(
    () =>
      new Intl.NumberFormat(localeOr(locale), {
        style: 'percent',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(fixed / 100),
    `${fixed.toFixed(digits)}%`
  );
}

/** Percentage change between two values, `null` when there is no baseline. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }
  return (current - previous) / previous;
}

/** `HH:MM` for a timestamp, using the locale's clock convention. */
export function formatTime(ts: number, locale?: string): string {
  return safeIntl(
    () =>
      new Intl.DateTimeFormat(localeOr(locale), { hour: 'numeric', minute: '2-digit' }).format(
        new Date(ts)
      ),
    new Date(ts).toTimeString().slice(0, 5)
  );
}

/** `21:00` for an hour bucket (0-23). */
export function formatHour(hour: number, locale?: string): string {
  const date = new Date(2026, 0, 5, hour, 0, 0, 0);
  return safeIntl(
    () => new Intl.DateTimeFormat(localeOr(locale), { hour: 'numeric', minute: '2-digit' }).format(date),
    `${hour < 10 ? '0' : ''}${hour}:00`
  );
}

/** `Monday, September 22` (year added when it differs from `referenceYear`). */
export function formatDateLong(ts: number, locale?: string, referenceYear?: number): string {
  const date = new Date(ts);
  const withYear = referenceYear !== undefined && date.getFullYear() !== referenceYear;
  return safeIntl(
    () =>
      new Intl.DateTimeFormat(localeOr(locale), {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        ...(withYear ? { year: 'numeric' } : {}),
      }).format(date),
    date.toDateString()
  );
}

/** `Sep 22` (or `Sep 22, 2025` when the year differs from the reference). */
export function formatDateShort(ts: number, locale?: string, referenceYear?: number): string {
  const date = new Date(ts);
  const withYear = referenceYear !== undefined && date.getFullYear() !== referenceYear;
  return safeIntl(
    () =>
      new Intl.DateTimeFormat(localeOr(locale), {
        month: 'short',
        day: 'numeric',
        ...(withYear ? { year: 'numeric' } : {}),
      }).format(date),
    date.toDateString()
  );
}

/** `September 2026`. */
export function formatMonthYear(ts: number, locale?: string): string {
  const date = new Date(ts);
  return safeIntl(
    () => new Intl.DateTimeFormat(localeOr(locale), { month: 'long', year: 'numeric' }).format(date),
    `${date.getFullYear()}-${date.getMonth() + 1}`
  );
}

/** `Sep 22 – Sep 28`, or `Sep 28 – Oct 4` when the week spans two months. */
export function formatWeekRange(startTs: number, endTs: number, locale?: string, referenceYear?: number): string {
  return `${formatDateShort(startTs, locale, referenceYear)} – ${formatDateShort(endTs, locale, referenceYear)}`;
}

/** `Mon`, `Tue`, ... indexed by JS weekday (0 = Sunday). */
export function formatWeekdayShort(weekday: number, locale?: string): string {
  const date = new Date(2026, 0, 4 + weekday, 12, 0, 0, 0); // 2026-01-04 is a Sunday
  return safeIntl(
    () => new Intl.DateTimeFormat(localeOr(locale), { weekday: 'short' }).format(date),
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday] ?? ''
  );
}

/** `Sep`. */
export function formatMonthShort(monthIndex: number, locale?: string): string {
  const date = new Date(2026, monthIndex, 1, 12, 0, 0, 0);
  return safeIntl(
    () => new Intl.DateTimeFormat(localeOr(locale), { month: 'short' }).format(date),
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthIndex] ?? ''
  );
}

/** `1.4 MB`, `812 KB`, `96 B`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  const decimals = index === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[index]}`;
}

/** `Oct 2026 · 21:04` — used in tooltips. */
export function formatTimestamp(ts: number, locale?: string): string {
  return `${formatDateShort(ts, locale)} · ${formatTime(ts, locale)}`;
}

/** Weekday index of the first day of a week, for a configurable week start. */
export function weekStartsOnFor(weekStartsOn: number): number {
  return ((weekStartsOn % 7) + 7) % 7;
}

/** The seven weekday indices of a week, starting at `weekStartsOn`. */
export function weekdayOrder(weekStartsOn: number): number[] {
  const start = weekStartsOnFor(weekStartsOn);
  return Array.from({ length: 7 }, (_, index) => (start + index) % 7);
}