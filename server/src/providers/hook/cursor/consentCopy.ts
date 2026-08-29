/**
 * Disclosure text for the Cursor hooks consent gate. Same contract as Claude:
 * the server ships these strings in `hooksConsentRequest` and the webview
 * renders them verbatim.
 */

import { CURSOR_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } from './constants.js';

const SETTINGS_FILE = '~/.cursor/hooks.json';

export const CONSENT_FACT_WHAT =
  `To bring your Cursor agents to life in real time, Pixel Agents adds hooks for ` +
  `${CURSOR_HOOK_EVENTS.length} Cursor events to ${SETTINGS_FILE}. ` +
  `Note that your existing hooks are kept, and a one-time backup is saved as hooks.json${SETTINGS_BACKUP_SUFFIX}.`;

export const CONSENT_FACT_DATA =
  'Cursor will send those events - including tool names and tool inputs - to a Pixel Agents ' +
  'server on this machine. Everything stays local - the server listens only on 127.0.0.1 - unless ' +
  'you explicitly start it with --host to expose it on your network.';

export const CONSENT_FACT_REVERSIBLE =
  'You can remove the hooks at any time from Settings → Instant Detection (Hooks).';

export const CONSENT_INSTALL_HEADLINE = 'One more thing: Cursor hooks!';

export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');
