/**
 * The scripts Pixel Agents ships for Claude Code to run (the hook script, the
 * status line bridge): where each one lives once installed, and the copy from
 * the package that puts it there. One spelling of `~/.pixel-agents/hooks/<name>`
 * for every installer and every command it writes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';

/** Where a bundled script is installed: ~/.pixel-agents/hooks/<name>. */
export function bundledScriptPath(name: string): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, name);
}

/** Copy one bundled script (`dist/hooks/<name>`) to ~/.pixel-agents/hooks/<name>.
 *  Returns true if the script was copied, false if the source was missing or the
 *  copy failed, so callers can report the failure instead of logging a false
 *  success (issue #333: a path regression silently installed nothing). */
export function copyBundledScript(extensionPath: string, name: string): boolean {
  const src = path.join(extensionPath, 'dist', 'hooks', name);
  const dst = bundledScriptPath(name);
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Script not found at ${src}`);
      return false;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Script installed at ${dst}`);
    return true;
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy ${name}: ${e}`);
    return false;
  }
}
