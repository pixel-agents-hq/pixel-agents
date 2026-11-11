/**
 * Private directories under ~/.pixel-agents/: the one check every store of
 * operator-private state (Roles, the Knowledge Base) applies level by level.
 *
 * A private directory is a real directory (lstat: never a symlink), owned by
 * the operator, mode exactly 0700. One that already exists but fails the check
 * is refused, never repaired: a directory someone else prepared is exactly
 * where a forged record would live. Only a directory this module just created
 * is chmod-ed to 0700.
 */

import * as fs from 'fs';

import { ROLES_STORAGE_DIR_MODE, ROLES_STORAGE_FILE_MODE } from './constants.js';

/** Thrown when a storage directory exists but is not private to the operator. */
export class StorageUnsafeError extends Error {}

export function errnoCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? 'unknown';
}

/** The operator's uid, or null where the platform has none (Windows): no uid
 *  means ownership cannot be proved, so every storage check fails there. */
function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** lstat-based: a real directory (never a symlink), owned by us, mode exactly 0700. */
export function isPrivateDirectory(stats: fs.Stats): boolean {
  const uid = currentUid();
  return (
    uid !== null &&
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.uid === uid &&
    (stats.mode & 0o777) === ROLES_STORAGE_DIR_MODE
  );
}

/** fstat-based (the handle was opened with O_NOFOLLOW): a regular file owned by
 *  us, mode exactly 0600. Same no-uid rule as directories: fails on Windows. */
export function isPrivateFile(stats: fs.Stats): boolean {
  const uid = currentUid();
  return (
    uid !== null &&
    stats.isFile() &&
    stats.uid === uid &&
    (stats.mode & 0o777) === ROLES_STORAGE_FILE_MODE
  );
}

/** 'absent' when nothing is at `dirPath`; throws StorageUnsafeError when
 *  something is there but is not a private directory. */
export async function checkPrivateDirectory(dirPath: string): Promise<'ok' | 'absent'> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(dirPath);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 'absent';
    throw new StorageUnsafeError(`lstat failed (${errnoCode(err)})`);
  }
  if (!isPrivateDirectory(stats)) {
    throw new StorageUnsafeError('not a private directory');
  }
  return 'ok';
}

/** Create `dirPath` (one level) when absent, then verify it. Only a directory
 *  created by this call is chmod-ed; an existing one must already be right.
 *  A mkdir failure other than EEXIST is rethrown as the raw fs error. */
export async function ensurePrivateDirectory(dirPath: string): Promise<void> {
  if ((await checkPrivateDirectory(dirPath)) === 'absent') {
    try {
      await fs.promises.mkdir(dirPath, { mode: ROLES_STORAGE_DIR_MODE });
      await fs.promises.chmod(dirPath, ROLES_STORAGE_DIR_MODE);
    } catch (err) {
      // Lost a race with another creator: fall through to the check, which
      // decides whether what is there now is acceptable.
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
    await checkPrivateDirectory(dirPath);
  }
}
