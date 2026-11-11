/**
 * Disclosure text for the Codex hooks consent gate. Same contract as the Claude
 * provider's: the server ships these strings in `hooksConsentRequest` and the
 * webview renders them verbatim, so there is exactly one copy of the terms.
 *
 * The event count is interpolated from CODEX_HOOK_EVENTS, never written out: a
 * hardcoded number silently becomes a lie the next time the list changes.
 */

import { CODEX_HOOK_EVENTS, HOOKS_BACKUP_SUFFIX } from './constants.js';

const HOOKS_FILE = '~/.codex/hooks.json';

/** WHY we ask + WHAT we write.
 *
 *  Names hooks.json specifically, because the reassuring part is what we do NOT
 *  touch: Codex also accepts hooks inline in config.toml, and a user who has
 *  model/provider/approval settings there deserves to know we leave that file
 *  alone. */
export const CONSENT_FACT_WHAT =
  `To bring your agents to life in real time, Pixel Agents adds hooks for ` +
  `${CODEX_HOOK_EVENTS.length} Codex events to ${HOOKS_FILE}. ` +
  `Your config.toml is not touched, existing hooks are kept, and a one-time backup ` +
  `is saved as hooks.json${HOOKS_BACKUP_SUFFIX}.`;

/** WHAT data moves, and where it stops.
 *
 *  Same honesty constraint as the Claude copy: `--host 0.0.0.0` binds the server
 *  to every interface, so this states the default and names the one thing that
 *  changes it rather than promising something the software can be asked to break. */
export const CONSENT_FACT_DATA =
  'Codex will send those events - including tool names and tool inputs - to a Pixel Agents ' +
  'server on this machine. Everything stays local - the server listens only on 127.0.0.1 - unless ' +
  'you explicitly start it with --host to expose it on your network.';

/** WHAT we deliberately do NOT do.
 *
 *  Codex-specific and worth stating plainly: its PreToolUse hook is allowed to
 *  deny a tool call outright and PermissionRequest can pre-approve one. A user
 *  who has read the Codex docs has every reason to ask whether we use that
 *  power. We do not, and the hook script emits no decision field at all. */
export const CONSENT_FACT_PASSIVE =
  'These hooks only watch. Codex lets a hook block a tool call or auto-approve a permission ' +
  'prompt; Pixel Agents does neither - it never returns a decision, so Codex behaves exactly ' +
  'the same whether or not the office is running.';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'You can remove the hooks at any time from Settings → Instant Detection (Hooks).';

/** Headline for the first-run gate. Carries NO disclosure facts by design. */
export const CONSENT_INSTALL_HEADLINE = 'One more thing: Codex hooks!';

/** The disclosure facts, in order, as one block. The IntroBubble splits on the
 *  blank lines and renders every paragraph on the decision surface itself. */
export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_PASSIVE,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');
