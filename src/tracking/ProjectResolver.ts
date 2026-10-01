/**
 * Maps a document to a project without ever storing a location.
 *
 * The project identity is `sha256(salt + workspace URI)` truncated to 16 hex
 * characters, and the display name is the workspace folder name, sanitized.
 * That is enough to draw "most active project" charts while the path itself
 * never leaves the editor: it only exists in memory for the duration of the
 * lookup, and the salt can be regenerated from the Privacy page.
 */

import * as vscode from 'vscode';

import { hashIdentifier, sanitizeProjectName } from '../security/Sanitization';

export interface ResolvedProject {
  /** Salted hash, or `undefined` when the document belongs to no folder. */
  id?: string;
  /** Folder name, sanitized; never a path. */
  name?: string;
}

const EMPTY: ResolvedProject = {};

export class ProjectResolver {
  private readonly salt: string;
  private readonly cache = new Map<string, ResolvedProject>();
  private enabled: boolean;

  public constructor(salt: string, enabled = true) {
    this.salt = salt;
    this.enabled = enabled;
  }

  /** Enables or disables project tracking without losing the salt. */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Resolves the project of a document, workspace folder or `undefined`. */
  public resolve(resource: vscode.Uri | undefined): ResolvedProject {
    if (!this.enabled || !resource) {
      return EMPTY;
    }
    const folder = vscode.workspace.getWorkspaceFolder(resource);
    if (!folder) {
      return EMPTY;
    }
    const key = folder.uri.toString();
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const resolved: ResolvedProject = {
      id: hashIdentifier(key, this.salt),
      name: sanitizeProjectName(folder.name),
    };
    // The cache holds one entry per open workspace folder; bounded for safety.
    if (this.cache.size > 64) {
      this.cache.clear();
    }
    this.cache.set(key, resolved);
    return resolved;
  }

  /** Forgets cached lookups (used when the salt changes). */
  public clear(): void {
    this.cache.clear();
  }

  /** Salted hash of a document URI; used for in-memory change detection only. */
  public documentKey(uri: vscode.Uri | undefined): string | undefined {
    if (!uri) {
      return undefined;
    }
    return hashIdentifier(`${uri.scheme}:${uri.toString()}`, this.salt);
  }
}
