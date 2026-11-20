import { existsSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A `mkdtempSync` folder name: a prefix, then six random characters. */
const MKDTEMP_NAME = /^.+-[A-Za-z0-9]{6}$/;

/**
 * The ONE place webview tests delete folders (an ESLint rule bans a recursive rm anywhere
 * else in test/): a folder made with `mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))`,
 * refusing anything else.
 */
export function removeTempDir(dir: string): void {
  if (!dir) return;
  const tmp = realpathSync(os.tmpdir());
  const target = existsSync(dir) ? realpathSync(dir) : path.resolve(dir);
  if (path.dirname(target) !== tmp || !MKDTEMP_NAME.test(path.basename(target))) {
    throw new Error(`removeTempDir: refusing to remove ${dir} (not a mkdtemp folder in ${tmp})`);
  }
  rmSync(target, { recursive: true, force: true });
}
