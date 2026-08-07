/**
 * Disclosure text for the hooks consent gate, shared by both surfaces (the VS
 * Code notification and the standalone CLI prompt) so neither can drift into
 * asking for approval on weaker terms than the other.
 *
 * The event count is interpolated from CLAUDE_HOOK_EVENTS, never written out:
 * a hardcoded number silently becomes a lie the next time the list changes.
 */

import { CLAUDE_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } from './constants.js';

const SETTINGS_FILE = '~/.claude/settings.json';

/** WHAT we write. */
export const CONSENT_FACT_WHAT =
  `Adds hook entries for ${CLAUDE_HOOK_EVENTS.length} Claude Code events to ${SETTINGS_FILE}. ` +
  `Your existing settings are kept, and a one-time backup is saved as settings.json${SETTINGS_BACKUP_SUFFIX}.`;

/** WHAT data moves, and where it stops.
 *
 *  "Nothing leaves your machine" used to be the second sentence, and it is not
 *  something this prompt can promise: `npx pixel-agents --host 0.0.0.0` binds
 *  the same server to every interface, and an accepted socket receives the
 *  store broadcasts (server/src/httpServer.ts). The claim was true for the
 *  default and false for a documented flag — so it states the default and names
 *  the one thing that changes it, rather than making a promise the software can
 *  be asked to break. */
export const CONSENT_FACT_DATA =
  'Claude Code will send those events - including tool names and tool inputs - to a Pixel Agents ' +
  'server on this machine. It is not sent anywhere else: by default the server listens on ' +
  '127.0.0.1 only, reachable from this machine alone (starting it with --host exposes it to your ' +
  'network).';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'You can remove the hooks at any time from Settings → Instant Detection (Hooks).';

/** Headline for the first-run gate — the only population that is asked. A user
 *  whose hooks a pre-consent version already installed is migrated silently
 *  (the migration only ever drops events), so there is no second headline. */
export const CONSENT_INSTALL_HEADLINE =
  'To show your agents in real time, Pixel Agents needs to add its hooks to ~/.claude/settings.json.';

/** The three disclosure facts, in order, as one block. */
export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');

/**
 * The complete non-modal notification message.
 *
 * VS Code flattens newlines to spaces and hard-truncates a notification message
 * at 1000 chars (`NotificationViewItem.MAX_MESSAGE_LENGTH`,
 * src/vs/workbench/common/notifications.ts @ 1.129.1) — and a notification WITH
 * BUTTONS renders permanently expanded (`canCollapse = !hasActions`) with no
 * line clamp, so under that cap the full disclosure is legible at the decision
 * point. That is why the facts live in the message itself rather than behind a
 * modal or a "Details" click: a disclosure one click away is the gap this
 * prompt exists to close. The cap is pinned by consentCopy.test.ts; grow the
 * copy past it and the notification silently ends in "...".
 */
export const CONSENT_INSTALL_MESSAGE = `${CONSENT_INSTALL_HEADLINE}\n\n${CONSENT_DISCLOSURE}`;
