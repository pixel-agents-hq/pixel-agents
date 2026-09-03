/**
 * Disclosure text for the hooks consent gate, OpenCode provider. Both surfaces
 * show the SAME in-app ask: the server ships these strings in the
 * `hooksConsentRequest` message and the webview's IntroBubble renders them
 * verbatim, so there is exactly one copy of the terms and no client-side
 * duplicate to drift.
 *
 * Two pieces: the HEADLINE is the title of the Intro's consent step and the
 * DISCLOSURE is that step's body. The headline carries NO disclosure facts —
 * every fact lives in the shared disclosure block (consentCopy.test.ts pins
 * that split for the Claude copy; the same shape is honored here).
 */

import { OPENCODE_PLUGIN_FILE_NAME } from './constants.js';

/** Plugin destination as shown to the user. A static display string, not a
 *  computed path: this module loads wherever the provider registry loads
 *  (including test processes with a mocked `os`), and calling os.homedir()
 *  at import time crashes those. The installer owns the real path
 *  (getBridgePluginPath); this copy only names the conventional location. */
const PLUGIN_DESTINATION = `~/.config/opencode/plugins/${OPENCODE_PLUGIN_FILE_NAME}`;

/** WHY we ask + WHAT we write. */
export const OPENCODE_CONSENT_FACT_WHAT =
  `To bring your OpenCode agents to life in real time, Pixel Agents adds a ` +
  `small bridge plugin to OpenCode's global plugin directory (${PLUGIN_DESTINATION}). ` +
  `Note that your existing OpenCode config is never modified — the plugin is a ` +
  `single new file, and removing that file uninstalls the integration.`;

/** WHAT data moves, and where it stops.
 *
 *  "Nothing leaves your machine" is not something this prompt can promise:
 *  `npx pixel-agents --host 0.0.0.0` binds the same server to every interface,
 *  and an accepted socket receives the store broadcasts
 *  (server/src/httpServer.ts). So it states the default and names the one
 *  thing that changes it, rather than making a promise the software can be
 *  asked to break. */
export const OPENCODE_CONSENT_FACT_DATA =
  'OpenCode will send session and tool events - including tool names and tool inputs - to a Pixel Agents ' +
  'server on this machine. Everything stays local - the server listens only on 127.0.0.1 - unless ' +
  'you explicitly start it with --host to expose it on your network.';

/** HOW to undo it. */
export const OPENCODE_CONSENT_FACT_REVERSIBLE =
  'You can remove the bridge plugin at any time from Settings → Instant Detection (Hooks).';

/** Headline for the first-run gate. Carries NO disclosure facts by design. */
export const OPENCODE_CONSENT_INSTALL_HEADLINE = 'One more thing: OpenCode hooks!';

/** The three disclosure facts, in order, as one block. */
export const OPENCODE_CONSENT_DISCLOSURE = [
  OPENCODE_CONSENT_FACT_WHAT,
  OPENCODE_CONSENT_FACT_DATA,
  OPENCODE_CONSENT_FACT_REVERSIBLE,
].join('\n\n');
