/**
 * OpenCode-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on OpenCode
 * unless OpenCode is the active provider.
 *
 * Adding another provider? Create its own `providers/<kind>/<name>/constants.ts`.
 */

import * as os from 'os';
import * as path from 'path';

/** Provider id used on the wire (`POST /api/hooks/opencode`). Must match the
 *  route pattern `^[a-z0-9-]+$` in `server/src/httpServer.ts`. */
export const OPENCODE_PROVIDER_ID = 'opencode';

/** Filename of the bridge plugin as installed into OpenCode's global plugin
 *  directory (`~/.config/opencode/plugins/`). OpenCode loads it directly with
 *  Bun, so no bundling step is involved — the file is copied verbatim. */
export const OPENCODE_PLUGIN_FILE_NAME = 'pixel-agents.ts';

/** Filename of the bridge source inside this package (`dist/bridge/` after
 *  build, `bridge/` next to this file in source). */
export const OPENCODE_BRIDGE_SOURCE_NAME = 'pixel-agents-bridge.ts';

/** Subdirectory of `dist/` the build copies the bridge source into. */
export const OPENCODE_BRIDGE_DIST_DIR = 'bridge';

/** Marker comment the bridge source carries on its first line. Install state
 *  is file identity, not settings surgery: a plugin file containing this
 *  marker is ours to refresh; a file without it is the user's and is never
 *  touched (install aborts instead). */
export const OPENCODE_PLUGIN_MARKER = 'Managed by Pixel Agents';

/** Suffix of the temp file used for the atomic tmp-write + rename. */
export const OPENCODE_PLUGIN_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for the plugins directory and plugin file we create. The file carries
 *  no secrets (the server token is read from `~/.pixel-agents/servers/` at
 *  event time, never written into the plugin), but restrictive-by-default
 *  matches the hook-script installer. */
export const OPENCODE_PLUGIN_DIR_MODE = 0o700;
export const OPENCODE_PLUGIN_FILE_MODE = 0o600;

/** Terminal name prefix for OpenCode sessions launched from the extension.
 *  Reserved for terminal→agent adoption if the VS Code adapter ever launches
 *  OpenCode terminals; the file-watcher heuristic consults it the same way it
 *  consults the Claude prefix. */
export const OPENCODE_TERMINAL_NAME_PREFIX = 'opencode';

/** Returns the destination path of the installed bridge plugin
 *  (`~/.config/opencode/plugins/pixel-agents.ts`). */
export function getBridgePluginPath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE_NAME);
}
