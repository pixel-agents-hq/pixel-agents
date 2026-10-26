/**
 * Disclosure text for the Hermes provider's hooks consent gate. Same contract
 * as Claude's consentCopy.ts: the headline titles the ask and carries NO
 * disclosure facts; the disclosure body states what is written, what data
 * moves, and how to undo, split on blank lines for the IntroBubble. The shared
 * consent gate ships these verbatim, so exactly one copy of the terms exists.
 *
 * The event count is interpolated from HERMES_HOOK_EVENTS — a hardcoded number
 * silently becomes a lie the next time the list changes.
 */

import { HERMES_HOOK_EVENTS } from './constants.js';

/** WHY we ask + WHAT we write. Path wording: the file lives at the resolved
 *  Hermes data home (`~/.hermes` on Linux/macOS, `%LOCALAPPDATA%\hermes` on
 *  Windows) — naming one literal path would be wrong for half the installs,
 *  so the disclosure names the file and the resolution rule. */
export const CONSENT_FACT_WHAT =
  `To bring your agents to life in real time, Pixel Agents adds an outbound webhook for ` +
  `${HERMES_HOOK_EVENTS.length} Hermes Agent lifecycle events to your Hermes config.yaml. ` +
  `Note that your existing settings are kept, a one-time backup is saved as config.yaml.pixel-agents.backup, ` +
  `and the rewrite through Hermes' YAML format does not preserve comments in that file. ` +
  `New events take effect on the next Hermes session start (or gateway restart).`;

/** WHAT data moves, and where it stops — same honesty contract as Claude's:
 *  no "nothing leaves your machine" promise the --host flag could break. */
export const CONSENT_FACT_DATA =
  'Hermes Agent will POST those events - including tool names, tool inputs, and per-turn token ' +
  'totals for the context gauge - to a Pixel Agents server on this machine. Everything stays ' +
  'local - the server listens only on 127.0.0.1 - unless you explicitly start it with --host to ' +
  'expose it on your network.';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'You can remove the hooks at any time from Settings → Hermes Agent hooks, or by deleting the ' +
  'entry named "pixel-agents" from hooks.outbound in your Hermes config.yaml.';

/** Headline for the first-run gate. A user whose hooks were installed before
 *  consent existed is migrated silently (install detection ⇒ granted), so no
 *  second headline. */
export const CONSENT_INSTALL_HEADLINE = 'One more thing: Hermes hooks!';

export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');
