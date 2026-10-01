/*
 * Dev Wrapped — formatting helpers used inside the webview.
 *
 * The extension host already formats most numbers, so this file only covers
 * what the UI derives locally: relative days, pluralisation, tone and level
 * class names and short duration strings for chart labels. No dependencies and
 * no access to anything outside the browser globals.
 */
(function () {
  'use strict';

  const MS_PER_MINUTE = 60000;
  const MS_PER_HOUR = 3600000;

  /** `2h 05m`, `47m`, `<1m`, `0m`. */
  function duration(ms) {
    const value = Number(ms);
    if (!isFinite(value) || value <= 0) {
      return '0m';
    }
    if (value < MS_PER_MINUTE) {
      return '<1m';
    }
    const minutes = Math.floor(value / MS_PER_MINUTE);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) {
      return rest + 'm';
    }
    return rest === 0 ? hours + 'h' : hours + 'h ' + (rest < 10 ? '0' : '') + rest + 'm';
  }

  /** Hours with one decimal place (`12.4`). */
  function hours(ms) {
    const value = Number(ms);
    if (!isFinite(value) || value <= 0) {
      return '0';
    }
    const result = value / MS_PER_HOUR;
    return result >= 100 ? String(Math.round(result)) : result.toFixed(result >= 10 ? 0 : 1);
  }

  /** Localized integer with separators (falls back to a plain string). */
  function integer(value, locale) {
    const number = Number(value);
    if (!isFinite(number)) {
      return '0';
    }
    try {
      return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 0 }).format(number);
    } catch (error) {
      return String(Math.round(number));
    }
  }

  /** `42%` from a 0-1 ratio. */
  function percent(ratio, digits) {
    const value = Number(ratio);
    if (!isFinite(value) || value <= 0) {
      return '0%';
    }
    const places = typeof digits === 'number' ? digits : 0;
    const shown = value * 100;
    const rounded = shown >= 99.5 && places === 0 ? 100 : shown;
    return rounded.toFixed(places) + '%';
  }

  /** `Sep 22` from a `YYYY-MM-DD` key, using a local noon anchor. */
  function dayShort(key) {
    const date = parseKey(key);
    if (!date) {
      return String(key || '');
    }
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
    } catch (error) {
      return key;
    }
  }

  /** `Monday, September 22`. */
  function dayLong(key) {
    const date = parseKey(key);
    if (!date) {
      return String(key || '');
    }
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
    } catch (error) {
      return key;
    }
  }

  /** `Sep 22` for a timestamp (epoch milliseconds). */
  function dateFromTs(ts) {
    const date = new Date(Number(ts));
    if (isNaN(date.getTime())) {
      return '';
    }
    const key =
      date.getFullYear() +
      '-' +
      (date.getMonth() + 1 < 10 ? '0' : '') +
      (date.getMonth() + 1) +
      '-' +
      (date.getDate() < 10 ? '0' : '') +
      date.getDate();
    return dayShort(key);
  }

  /** `10:32` for a timestamp. */
  function clock(ts) {
    const date = new Date(Number(ts));
    if (isNaN(date.getTime())) {
      return '';
    }
    const hh = date.getHours();
    const mm = date.getMinutes();
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  /** `HH:MM – HH:MM` for a session. */
  function range(startTs, endTs) {
    return clock(startTs) + ' – ' + clock(endTs);
  }

  /** `Today`, `Yesterday`, `3 days ago` or the short date. */
  function relativeDay(key) {
    const date = parseKey(key);
    if (!date) {
      return String(key || '');
    }
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const diff = Math.round((today.getTime() - date.getTime()) / 86400000);
    if (diff === 0) {
      return 'Today';
    }
    if (diff === 1) {
      return 'Yesterday';
    }
    if (diff > 1 && diff < 7) {
      return diff + ' days ago';
    }
    return dayShort(key);
  }

  /** `1 session` / `3 sessions`. */
  function plural(count, one, many) {
    const value = Number(count) || 0;
    return value + ' ' + (value === 1 ? one : many || one + 's');
  }

  /** Tone class for cards, insights and comparisons. */
  function toneClass(tone) {
    if (tone === 'positive') {
      return 'cw-tone-positive';
    }
    if (tone === 'muted') {
      return 'cw-tone-muted';
    }
    return 'cw-tone-neutral';
  }

  /** Heat map intensity class. */
  function levelClass(level) {
    let value = Number(level) || 0;
    if (value < 0) {
      value = 0;
    }
    if (value > 4) {
      value = 4;
    }
    return 'cw-level-' + Math.round(value);
  }

  /** Swatch class for the first eight legend entries, repeating afterwards. */
  function swatchClass(index) {
    const position = (Number(index) || 0) % 8;
    return 'cw-swatch-' + (position + 1);
  }

  /** Marker used by insight icons (kept to plain letters, no emoji fonts). */
  const ICON_LETTERS = {
    clock: 'T',
    code: '<>',
    folder: '/',
    flame: '*',
    calendar: '#',
    spark: '+',
  };

  function iconLetter(icon) {
    return ICON_LETTERS[icon] || '+';
  }

  /** Status line shown in the navigation footer. */
  function trackingStatus(status) {
    if (!status || !status.tracking) {
      return 'Unknown';
    }
    if (status.tracking.paused) {
      return 'Paused';
    }
    if (status.tracking.sessionActive) {
      return 'Session active';
    }
    return 'Tracking';
  }

  /** Safe number conversion (used by charts). */
  function number(value) {
    const parsed = Number(value);
    return isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /** Parses `YYYY-MM-DD` or `YYYY-MM` at local noon (stable across DST). */
  function parseKey(key) {
    if (typeof key !== 'string') {
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      const date = new Date(key + 'T12:00:00');
      return isNaN(date.getTime()) ? null : date;
    }
    if (/^\d{4}-\d{2}$/.test(key)) {
      const month = new Date(key + '-01T12:00:00');
      return isNaN(month.getTime()) ? null : month;
    }
    return null;
  }

  globalThis.CodeWrappedFormat = {
    duration: duration,
    hours: hours,
    integer: integer,
    percent: percent,
    dayShort: dayShort,
    dateFromTs: dateFromTs,
    dayLong: dayLong,
    clock: clock,
    range: range,
    relativeDay: relativeDay,
    plural: plural,
    toneClass: toneClass,
    levelClass: levelClass,
    swatchClass: swatchClass,
    iconLetter: iconLetter,
    trackingStatus: trackingStatus,
    number: number,
    parseKey: parseKey,
  };
})();
