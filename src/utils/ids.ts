/**
 * Identifier helpers.
 *
 * Session ids are stored in the local database, so they only need to be
 * unique inside one data directory; they are generated from the platform
 * random source and never derived from file paths or workspace names.
 */

import { randomBytes } from 'node:crypto';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random lowercase id (`s1f3k9ab...`). */
export function createId(prefix = '', length = 20): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index] ?? 0;
    result += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return prefix.length > 0 ? `${prefix}${result}` : result;
}

/** New session id (`s` + 20 characters). */
export function createSessionId(): string {
  return createId('s', 20);
}

/** Random salt used to anonymize project identifiers. */
export function createPrivacySalt(): string {
  return randomBytes(24).toString('hex');
}

/** Short, stable, non reversible identifier for an arbitrary value. */
export function fingerprint(value: string): string {
  // Deliberately cheap: this is only used for cache keys inside one session.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
