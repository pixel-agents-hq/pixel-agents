import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The ONE place e2e code deletes folders (an ESLint rule bans a recursive rm anywhere else
 * under e2e, server/__tests__ and webview-ui/test). A server test that removed a computed
 * path once deleted the contents of the user's whole temp directory; every delete here
 * refuses what is not provably the test's own.
 */

/** A `fs.mkdtempSync` folder name: a prefix, then six random characters. */
const MKDTEMP_NAME = /^.+-[A-Za-z0-9]{6}$/;

function realOrResolved(dir: string): string {
  return fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The mkdtemp folder (directly in the temp dir) `target` is or lies in, or null. */
function tempRootOf(target: string): string | null {
  const tmp = fs.realpathSync(os.tmpdir());
  if (!inside(tmp, target)) return null;
  const top = path.relative(tmp, target).split(path.sep)[0]!;
  return MKDTEMP_NAME.test(top) ? path.join(tmp, top) : null;
}

/** Remove a folder made with `fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))`, refusing anything else. */
export function removeTempDir(dir: string): void {
  if (!dir) return;
  const target = realOrResolved(dir);
  if (tempRootOf(target) !== target) {
    throw new Error(
      `removeTempDir: refusing to remove ${dir} (not a mkdtemp folder in the temp dir)`,
    );
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/** Remove a folder the suite owns under `root` (its artifacts, results, cache), never `root` itself. */
export function removeUnder(root: string, dir: string): void {
  const target = realOrResolved(dir);
  if (!inside(realOrResolved(root), target)) {
    throw new Error(`removeUnder: refusing to remove ${dir} (not inside ${root})`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
