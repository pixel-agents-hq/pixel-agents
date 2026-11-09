/**
 * The standalone host's own Directory contribution.
 *
 * Every host contributes its native context as read-only `source: 'host'`
 * Directories: VS Code its workspace folders (adapters/vscode), standalone the
 * directory the server was started from. The entry is merged with the
 * user-defined ones by directories.ts, which is what stamps `source` and
 * `isDefault` — a host only says what and where.
 */

import * as path from 'path';

import type { HostDirectoryEntry } from './directories.js';

/** Display name for a Directory path: its basename, falling back to the path
 *  itself for a filesystem root (basename('/') === ''). */
export function directoryNameFor(dirPath: string): string {
  return path.basename(dirPath) || dirPath;
}

/** The directory the standalone server was started from. */
export function hostDirectory(): HostDirectoryEntry {
  const cwd = process.cwd();
  return { name: directoryNameFor(cwd), path: cwd };
}
