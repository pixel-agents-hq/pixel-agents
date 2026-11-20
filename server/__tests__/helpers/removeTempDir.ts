import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The ONE place server tests delete folders (an ESLint rule bans a recursive rm anywhere
 * else under server/__tests__, e2e and webview-ui/test). A test that removed
 * `path.dirname(workspace)` after reassigning `workspace` once deleted the contents of the
 * user's whole temp directory; every delete here refuses anything but a `fs.mkdtempSync`
 * folder directly in the temp dir, or something inside one.
 */

/** A `fs.mkdtempSync` folder name: a prefix, then six random characters. */
const MKDTEMP_NAME = /^.+-[A-Za-z0-9]{6}$/;

function realOrResolved(dir: string): string {
  return fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
}

/** The mkdtemp folder (directly in the temp dir) `target` is or lies in, or null. */
function tempRootOf(target: string): string | null {
  const tmp = fs.realpathSync(os.tmpdir());
  const rel = path.relative(tmp, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const top = rel.split(path.sep)[0]!;
  return MKDTEMP_NAME.test(top) ? path.join(tmp, top) : null;
}

/**
 * Remove a temp folder a test made with `fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))`,
 * refusing anything else.
 */
export function removeTempDir(dir: string): void {
  if (!dir) return;
  const target = realOrResolved(dir);
  if (tempRootOf(target) !== target) {
    throw new Error(
      `removeTempDir: refusing to remove ${dir} (not a mkdtemp folder directly in ${fs.realpathSync(os.tmpdir())})`,
    );
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Remove something INSIDE a test's mkdtemp folder (a worktree a fixture made in a temp
 * repo, a file tree under a temp root), refusing the folder itself and anything outside one.
 */
export function removeInTempDir(target: string): void {
  const resolved = realOrResolved(target);
  const root = tempRootOf(resolved);
  if (!root || root === resolved) {
    throw new Error(`removeInTempDir: refusing to remove ${target} (not inside a mkdtemp folder)`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

/**
 * Clear `names` (default `.pixel-agents` and `.claude`) under the test's home. Throws unless
 * the home is a mkdtemp folder directly in the temp dir, so a file run without the isolating
 * setup (vitest from the repo root, an IDE runner) can never clear a developer's real data.
 */
export function clearTestHome(...names: string[]): void {
  const home = realOrResolved(os.homedir());
  if (tempRootOf(home) !== home) {
    throw new Error(`clearTestHome: refusing: the home ${home} is not a test's mkdtemp folder`);
  }
  for (const name of names.length > 0 ? names : ['.pixel-agents', '.claude']) {
    if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
      throw new Error(`clearTestHome: ${name} is not a name in the home`);
    }
    fs.rmSync(path.join(home, name), { recursive: true, force: true });
  }
}
