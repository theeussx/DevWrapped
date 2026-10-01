/**
 * Storage facade.
 *
 * Owns the local JSON database and the handful of flags that live in the
 * extension's `globalState` (privacy salt, onboarding, pause, last wrapped
 * year). Everything else in the extension talks to this class, never to the
 * file system directly.
 */

import type { DatabaseData } from '../types/statistics';
import type { DatabaseDelta } from '../types/delta';
import { createPrivacySalt } from '../utils/ids';
import type { Logger } from '../utils/log';
import { Database, type LoadOutcome } from './Database';

/** The slice of `vscode.Memento` that the storage layer needs. */
export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface StorageOptions {
  /** Directory that holds the database (usually `globalStorageUri`). */
  storageDirectory: string;
  globalState: KeyValueStore;
  logger?: Logger;
  /** Current retention setting, read on demand. */
  retentionDays: () => number;
  now?: () => number;
}

const STATE_KEYS = {
  onboarded: 'codeWrapped.onboarded',
  paused: 'codeWrapped.paused',
  lastWrappedYear: 'codeWrapped.lastWrappedYear',
} as const;

export interface StoragePaths {
  directory: string;
  dataFile: string;
  backupFile: string;
}

export class Storage {
  private readonly options: StorageOptions;
  private readonly database: Database;
  private readonly log: Logger | undefined;

  private constructor(options: StorageOptions, database: Database) {
    this.options = options;
    this.database = database;
    this.log = options.logger;
  }

  /** Opens the database, creating the privacy salt if this is a fresh install. */
  public static async create(options: StorageOptions): Promise<Storage> {
    const database = await Database.open({
      directory: options.storageDirectory,
      logger: options.logger,
      ...(options.now ? { now: options.now } : {}),
    });
    const storage = new Storage(options, database);
    if (database.data.meta.privacySalt.length === 0) {
      database.data.meta.privacySalt = createPrivacySalt();
      await database.flush();
    }
    database.setRetentionDays(options.retentionDays());
    return storage;
  }

  /* ---------------------------------- data ---------------------------------- */

  public get data(): DatabaseData {
    return this.database.data;
  }

  /** The underlying database, for operations that need more control. */
  public get store(): Database {
    return this.database;
  }

  public get paths(): StoragePaths {
    const dataFile = this.database.filePath;
    const split = Math.max(dataFile.lastIndexOf('/'), dataFile.lastIndexOf('\\'));
    return {
      directory: split > 0 ? dataFile.slice(0, split) : this.options.storageDirectory,
      dataFile,
      backupFile: this.database.backupPath,
    };
  }

  public get loadOutcome(): LoadOutcome {
    return this.database.loadOutcome;
  }

  public get sizeBytes(): number {
    return this.database.sizeBytes;
  }

  public stat(): ReturnType<Database['stat']> {
    return this.database.stat();
  }

  /** One line description used in the logs and the diagnostics command. */
  public describe(): string {
    const stat = this.database.stat();
    return `${stat.days} day(s), ${stat.sessions} session(s), ${stat.projects} project(s), ${stat.languages} language(s)`;
  }

  /* --------------------------------- writes --------------------------------- */

  public applyDelta(delta: DatabaseDelta): void {
    this.database.applyDelta(delta);
  }

  public async flush(): Promise<void> {
    await this.database.flush();
  }

  public setRetentionDays(days: number): void {
    this.database.setRetentionDays(days);
  }

  /** Writes a labelled copy of the database next to it. */
  public async createSafetyCopy(label: string): Promise<string> {
    return this.database.safetyCopy(label);
  }

  /** Replaces the whole database (import flow, after confirmation). */
  public async replaceAll(data: DatabaseData): Promise<void> {
    this.database.replaceAll(data);
    await this.database.flush();
  }

  /**
   * Deletes every statistic.
   *
   * A safety copy is written first, so "reset" is recoverable if it was a
   * mistake — the copy is mentioned in the confirmation dialog.
   */
  public async reset(): Promise<string> {
    const copy = await this.database.safetyCopy('before-reset');
    this.database.reset();
    await this.database.flush();
    this.log?.info(`Statistics reset. Safety copy: ${copy}`);
    return copy;
  }

  /* ------------------------------ salted hashes ----------------------------- */

  /** Random salt used to anonymize project identifiers. */
  public get privacySalt(): string {
    return this.database.data.meta.privacySalt;
  }

  /* ------------------------------ small flags ------------------------------- */

  /** `true` once the welcome flow has been shown. */
  public get onboarded(): boolean {
    return this.options.globalState.get<boolean>(STATE_KEYS.onboarded, false);
  }

  public async setOnboarded(value: boolean): Promise<void> {
    await this.options.globalState.update(STATE_KEYS.onboarded, value);
  }

  /** `true` while the user paused tracking. Survives a window reload. */
  public get userPaused(): boolean {
    return this.options.globalState.get<boolean>(STATE_KEYS.paused, false);
  }

  public async setUserPaused(value: boolean): Promise<void> {
    await this.options.globalState.update(STATE_KEYS.paused, value);
  }

  /** Year of the last retroactive the user opened (avoids repeating a notice). */
  public get lastWrappedYear(): number | undefined {
    const value = this.options.globalState.get<number>(STATE_KEYS.lastWrappedYear, 0);
    return value > 0 ? value : undefined;
  }

  public async setLastWrappedYear(year: number): Promise<void> {
    await this.options.globalState.update(STATE_KEYS.lastWrappedYear, Math.round(year));
  }
}
