import * as fs from 'fs';
import * as path from 'path';

import {
  getBridgePluginPath,
  OPENCODE_BRIDGE_DIST_DIR,
  OPENCODE_BRIDGE_SOURCE_NAME,
  OPENCODE_PLUGIN_DIR_MODE,
  OPENCODE_PLUGIN_FILE_MODE,
  OPENCODE_PLUGIN_MARKER,
  OPENCODE_PLUGIN_TMP_SUFFIX,
} from './constants.js';

/** Surfaced when the plugin destination holds a file we did not write. The
 *  file is the USER's — overwriting it would destroy hand-written config,
 *  the same class of bug as rewriting a settings file we could not read.
 *  Refuse instead. */
export function bridgeForeignFileMessage(pluginPath: string): string {
  return `${pluginPath} exists but was not installed by Pixel Agents — move or remove it`;
}

/** Surfaced when installHooks runs without a prior copy step. The copy must
 *  come first: claiming "installed" over a missing plugin leaves the user
 *  with a checkbox reading ON and zero events flowing. */
export const BRIDGE_PLUGIN_MISSING_MESSAGE =
  'OpenCode bridge plugin is not installed — the copy step must run before install';

/** Returns the shipped bridge source inside an installed package
 *  (`<packageRoot>/dist/bridge/pixel-agents-bridge.ts`). */
function getBridgeSourcePath(packageRoot: string): string {
  return path.join(packageRoot, 'dist', OPENCODE_BRIDGE_DIST_DIR, OPENCODE_BRIDGE_SOURCE_NAME);
}

/** Best-effort unlink: a leftover tmp file we cannot remove must not mask the
 *  real error we are already reporting. */
function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Whether the Pixel Agents bridge plugin is present in OpenCode's global
 * plugin directory.
 *
 * Identity is the marker comment, not the filename: a same-named file the
 * user wrote by hand is theirs, and every caller treats it as "not ours".
 * An unreadable location reads as "not installed" — the install path will
 * then attempt the write and surface the real error rather than rewriting
 * blindly.
 */
export function areHooksInstalled(): boolean {
  try {
    const pluginPath = getBridgePluginPath();
    if (!fs.existsSync(pluginPath)) return false;
    return fs.readFileSync(pluginPath, 'utf-8').includes(OPENCODE_PLUGIN_MARKER);
  } catch {
    return false;
  }
}

/**
 * Copy the shipped bridge plugin into OpenCode's global plugin directory.
 * Returns true if the plugin was copied, false if the source was missing, the
 * destination holds a foreign file, or the copy failed — so callers report
 * the failure instead of logging a false success (cf. issue #333: a path
 * regression silently installed nothing).
 *
 * No backup is taken, deliberately: the only content this ever replaces is a
 * file carrying our own marker (a byte-identical refresh of what we wrote),
 * mirroring the installer's skip when the replaced settings hold only our
 * own hooks. Anything else aborts before any write.
 */
export function installBridgePlugin(packageRoot: string): boolean {
  const src = getBridgeSourcePath(packageRoot);
  const dst = getBridgePluginPath();
  const dstDir = path.dirname(dst);
  const tmpPath = dst + OPENCODE_PLUGIN_TMP_SUFFIX;

  try {
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] OpenCode bridge source not found at ${src}`);
      return false;
    }
    if (fs.existsSync(dst)) {
      let current: string;
      try {
        current = fs.readFileSync(dst, 'utf-8');
      } catch (e) {
        console.error(`[Pixel Agents] Could not read ${dst}: ${e}`);
        return false;
      }
      if (!current.includes(OPENCODE_PLUGIN_MARKER)) {
        console.error(`[Pixel Agents] ${bridgeForeignFileMessage(dst)} — hooks not installed.`);
        return false;
      }
    }
    removeIfPresent(tmpPath);
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: OPENCODE_PLUGIN_DIR_MODE });
    }
    fs.writeFileSync(tmpPath, fs.readFileSync(src), { mode: OPENCODE_PLUGIN_FILE_MODE });
    fs.chmodSync(tmpPath, OPENCODE_PLUGIN_FILE_MODE);
    fs.renameSync(tmpPath, dst);
    console.log(`[Pixel Agents] OpenCode bridge plugin installed at ${dst}`);
    return true;
  } catch (e) {
    removeIfPresent(tmpPath);
    console.error(`[Pixel Agents] Failed to install OpenCode bridge plugin: ${e}`);
    return false;
  }
}

/**
 * Verify the bridge plugin install. Idempotent: the copy step (host-owned,
 * like copyHookScript) does the writing; this asserts the result so a skipped
 * copy can never report success.
 *
 * Rejects when the plugin is absent — callers surface the error to the user
 * instead of installing.
 */
export async function installHooks(): Promise<void> {
  if (!areHooksInstalled()) {
    throw new Error(`${BRIDGE_PLUGIN_MISSING_MESSAGE} — hooks not installed.`);
  }
  console.log('[Pixel Agents] OpenCode hooks installed (bridge plugin present)');
}

/** Remove the bridge plugin. Cleans up only what we installed: a foreign file
 *  at the destination aborts with an error rather than being deleted, and a
 *  missing file is a silent no-op. Rejects when the file cannot be read —
 *  same protection as install: never rewrite what we could not read. */
export async function uninstallHooks(): Promise<void> {
  const dst = getBridgePluginPath();
  try {
    if (!fs.existsSync(dst)) return;
    let current: string;
    try {
      current = fs.readFileSync(dst, 'utf-8');
    } catch (e) {
      throw new Error(`Could not read ${dst} — hook entries left in place.`, { cause: e });
    }
    if (!current.includes(OPENCODE_PLUGIN_MARKER)) {
      throw new Error(`${bridgeForeignFileMessage(dst)} — hook entries left in place.`);
    }
    fs.rmSync(dst);
  } catch (e) {
    if (e instanceof Error && e.message.endsWith('hook entries left in place.')) throw e;
    throw new Error(`${e instanceof Error ? e.message : String(e)} — hook entries left in place.`, {
      cause: e,
    });
  }
  console.log('[Pixel Agents] OpenCode bridge plugin removed');
}
