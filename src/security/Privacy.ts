/**
 * The privacy contract of Dev Wrapped, in one place.
 *
 * These strings are shown in the dashboard, in the README and in the
 * extension notifications. Keeping them here means the promise the extension
 * makes is identical everywhere it is displayed, and the test suite can assert
 * that the shipped build still honours it.
 */

import { hashIdentifier, sanitizeProjectName } from './Sanitization';

export interface PrivacyFact {
  /** Short question, for example "Is my source code read?". */
  question: string;
  /** The answer shown next to it. */
  answer: string;
}

/** What is collected, in plain language. */
export const PRIVACY_COLLECTED: readonly string[] = [
  'Time spent typing, saving or editing in the active editor (active time only, idle time is excluded)',
  'The language of the active editor, for example typescript or python',
  'The name of the workspace folder, hashed with a secret salt before it is stored',
  'Counts of documents edited, saved and opened',
  'Per-day and per-hour totals, so charts can be drawn',
  'Sessions: start, end and active duration, so streaks and long sessions can be shown',
];

/** What is never collected, in plain language. */
export const PRIVACY_NEVER_COLLECTED: readonly string[] = [
  'Source code, not even one character',
  'File names, file paths or the contents of any file',
  'Passwords, API keys, tokens or environment variables',
  'Terminal commands or terminal output',
  'Keystrokes, clipboard contents or mouse activity',
  'Browsing history, open tabs or search queries',
  'Personal identity: no account, no e-mail, no device identifier',
  'Telemetry or crash reports: nothing is ever sent anywhere',
];

/** The network statement, also used by the README and the marketplace listing. */
export const NETWORK_STATEMENT =
  'Dev Wrapped works fully offline. It has no dependencies, makes no network requests, and contains no update check, no telemetry, no analytics service and no remote configuration. You can verify this in the source: the extension never imports http, https, net, tls, dgram or fetch.';

/** Security notes shown on the Privacy page. */
export const PRIVACY_SAFETY: readonly string[] = [
  'Everything is stored in one JSON file inside the extension storage folder on your machine.',
  'Project identifiers are salted SHA-256 hashes: the workspace location cannot be recovered from them.',
  'Writes are atomic (temporary file, then rename) and a backup of the previous file is kept.',
  'Imports are validated against a strict schema, size limited, and refused when they contain fields like "filename", "content" or "token".',
  'Importing never overwrites your data silently: a safety copy is made first and the import must be confirmed.',
  'The webview runs with a strict Content Security Policy, a nonce for every script, no inline styles and no remote origins.',
  'Logs never contain workspace paths or document contents.',
];

/** Answers rendered as cards on the Privacy page. */
export const PRIVACY_FACTS: readonly PrivacyFact[] = [
  {
    question: 'Does Dev Wrapped read my code?',
    answer:
      'No. It never reads document text. It records that the active editor changed, which language it uses and when you save — never what is inside.',
  },
  {
    question: 'Where is my data stored?',
    answer:
      'In a single JSON file in the extension storage folder for this machine. Nothing leaves the computer, there is no account and no cloud sync.',
  },
  {
    question: 'Can I delete everything?',
    answer:
      'Yes. "Code Wrapped: Reset Statistics" permanently removes all activity, sessions and projects after a typed confirmation. A safety copy of the previous file is kept next to it.',
  },
  {
    question: 'Is my project name stored?',
    answer:
      'The workspace folder name is stored so the dashboard can show "most active project". The location of the folder is not stored: only a salted hash plus the folder name.',
  },
  {
    question: 'Does it count time when I am away from the keyboard?',
    answer:
      'No. After the configured inactivity timeout (5, 10, 15 or 30 minutes) the session ends and the idle stretch is discarded, so being away is never counted as coding.',
  },
  {
    question: 'Can I pause tracking?',
    answer:
      'Yes. "Code Wrapped: Pause Tracking" stops recording immediately (a small pause icon appears in the status bar), and the pause survives a window reload.',
  },
  {
    question: 'What does exporting include?',
    answer:
      'Only the statistics described here: day totals, session records, language and project aggregates. The export is a local file written where you choose.',
  },
  {
    question: 'Does it know which files I touched?',
    answer:
      'No. It counts how many documents you edited or saved; file names are never read or stored.',
  },
];

/** One line summary for the README badge block. */
export const PRIVACY_SUMMARY =
  'Local only · No source code · No file names · No telemetry · No account · Works offline';

/** Marks a workspace as a project without storing its location. */
export function pseudonymizeProject(uri: string, salt: string): string {
  return hashIdentifier(uri, salt);
}

/** Display name for a project (folder name only, sanitized). */
export function projectDisplayName(folderName: string): string {
  return sanitizeProjectName(folderName);
}

/** Short, human readable description of the pseudonymization scheme. */
export function describeProjectId(id: string): string {
  return `salted-hash:${id.slice(0, 8)}…`;
}
