/**
 * Write a private file without ever exposing a half-written or guessable one.
 *
 * The existing writers (config.json, layout.json, ...) stage through a FIXED
 * tmp name, which a second writer can collide with and another local user can
 * pre-plant. This helper is the replacement for new files: a tmp name no one
 * can predict (pid + random UUID), created exclusively (`wx`: fails instead of
 * following anything already at that path), private from the first byte
 * (0600, re-applied with fchmod in case the umask narrowed it oddly), then
 * renamed over the target -- so readers only ever see the old file or the
 * complete new one.
 *
 * Every failure removes the tmp file and rethrows: a caller that cannot write
 * must say so, never carry on as if it had.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

import { ROLES_STORAGE_FILE_MODE } from './constants.js';

/** The staging name for `filePath`: same directory (so rename is atomic), unguessable. */
export function secureTmpPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

/**
 * Atomically replace `filePath` with `data`, mode 0600. Throws on any failure,
 * after removing the tmp file; the target is then exactly as it was.
 */
export async function writeFileSecure(filePath: string, data: string | Buffer): Promise<void> {
  const tmpPath = secureTmpPathFor(filePath);
  let handle: fs.promises.FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.promises.open(tmpPath, 'wx', ROLES_STORAGE_FILE_MODE);
    created = true;
    await handle.writeFile(data);
    await handle.chmod(ROLES_STORAGE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    // Only a file this call created: an exclusive create that failed means
    // something else holds that name, and it is not ours to delete.
    if (created) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    }
    throw err;
  }
}
