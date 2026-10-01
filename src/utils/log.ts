/**
 * Logging with safe levels.
 *
 * Levels: `error` (something the user should know about), `warn` (recoverable
 * problem), `info` (lifecycle, shown by default), `debug` (only when
 * `codeWrapped.debugLogging` is on).
 *
 * Privacy: log lines are redacted before they reach the sink, so a workspace
 * path or a file name can never end up in a log file or a bug report. The
 * extension never logs document contents at all.
 */

import { redactForLog } from '../security/Sanitization';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Where log lines end up (usually the VS Code output channel). */
export interface LogSink {
  appendLine(line: string): void;
}

export interface LoggerOptions {
  sink: LogSink;
  /** Evaluated per call so a settings change takes effect immediately. */
  debugEnabled: () => boolean;
  /** Shown in front of every message. */
  prefix?: string;
  /** Injected clock, for tests. */
  now?: () => number;
}

export class Logger {
  private readonly sink: LogSink;
  private readonly debugEnabled: () => boolean;
  private readonly prefix: string;
  private readonly now: () => number;

  public constructor(options: LoggerOptions) {
    this.sink = options.sink;
    this.debugEnabled = options.debugEnabled;
    this.prefix = options.prefix ?? 'Code Wrapped';
    this.now = options.now ?? Date.now;
  }

  public error(message: string, detail?: unknown): void {
    this.write('error', message, detail);
  }

  public warn(message: string, detail?: unknown): void {
    this.write('warn', message, detail);
  }

  public info(message: string, detail?: unknown): void {
    this.write('info', message, detail);
  }

  public debug(message: string, detail?: unknown): void {
    if (!this.safeDebugEnabled()) {
      return;
    }
    this.write('debug', message, detail);
  }

  /** `true` when debug lines are currently emitted. */
  public get isDebug(): boolean {
    return this.safeDebugEnabled();
  }

  /** Writes an already formatted block (used by the diagnostics command). */
  public raw(lines: string[]): void {
    for (const line of lines) {
      this.safeAppend(redactForLog(line));
    }
  }

  private write(level: LogLevel, message: string, detail?: unknown): void {
    const timestamp = new Date(this.now()).toISOString();
    const parts = [`[${timestamp}] [${level.toUpperCase()}] ${this.prefix}:`, message];
    if (detail !== undefined && detail !== null) {
      parts.push(typeof detail === 'string' ? detail : safeJson(detail));
    }
    const line = parts.filter((part) => part.length > 0).join(' ');
    this.safeAppend(redactForLog(line));
  }

  private safeAppend(line: string): void {
    try {
      this.sink.appendLine(line);
    } catch {
      // Logging must never break the extension.
    }
  }

  private safeDebugEnabled(): boolean {
    try {
      return this.debugEnabled();
    } catch {
      return false;
    }
  }
}

/** `JSON.stringify` that survives circular structures and `BigInt`. */
export function safeJson(value: unknown, maxLength = 400): string {
  try {
    const text = JSON.stringify(value, replaceUnsupported);
    if (text === undefined) {
      return String(value);
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return '[unserializable]';
  }
}

function replaceUnsupported(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}