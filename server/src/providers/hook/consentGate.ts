/**
 * The first-run hooks consent POLICY: when to ask, and what an answer means. Provider-agnostic — the provider
 * contributes only its id and disclosure copy, and the storage is keyed per provider. Written once rather than once
 * per surface: a duplicated gate drifts silently, and a settings file in the user's home directory is on the other
 * side of it. The full rule, with its rejected alternatives, is docs/adr/0001.
 */

import type { HooksConsentRequest } from '../../../../core/src/messages.js';
import type { HookProvider } from '../../../../core/src/provider.js';

/** Inputs to the ask-or-not decision, as each surface already knows them. */
export interface ConsentGateState {
  /** Are any of this provider's hook commands on disk right now
   *  (areHooksInstalled)? */
  installed: boolean;
  /** The provider's persisted hooks preference. Defaults true, so it is only
   *  false after an explicit decline or a Settings toggle-off. */
  hooksEnabled: boolean;
  /** Has this provider's ask been durably answered (config.json
   *  hooksConsent[providerId] holds 'granted' or 'declined')? */
  consentAnswered: boolean;
  /** May this client's answer actually be acted on? Embedded webviews are
   *  privileged by construction; a standalone connection must have proved the
   *  server token. Showing the dialog to a client whose answer would be
   *  ignored is a lie, so it gates the ASK and not just the response. */
  privileged: boolean;
}

/**
 * The `hooksConsentRequest` for one provider's `webviewReady` handshake, or null when this client must not be asked.
 * Each condition is a reason the ask would be WRONG, not merely redundant: nothing to approve, already answered
 * durably, a preference turned off, or a client whose answer would be dropped. All four are checked in their own
 * right, so a hand-edited config cannot resurrect a retired ask.
 */
export function hooksConsentRequest(
  state: ConsentGateState,
  provider: Pick<HookProvider, 'id' | 'consentDisclosure'>,
): HooksConsentRequest | null {
  if (state.installed || state.consentAnswered || !state.hooksEnabled || !state.privileged) {
    return null;
  }
  const { headline, disclosure } = provider.consentDisclosure();
  return { type: 'hooksConsentRequest', providerId: provider.id, headline, disclosure };
}

/** What the server should DO about an answer. The Intro lets the user walk BACK from the closing step and re-answer,
 *  so a choice is an absolute statement of desired state, not a one-shot event: a decline maps to whichever action
 *  UNDOES what the earlier answer left (hooks on disk, a recorded grant, or a decline's own hooks-off). Rationale and
 *  rejected alternatives: docs/adr/0001; consentExecutor.ts performs each arm. */
export type ConsentAction =
  'install' | 'persistOff' | 'disable' | 'revert' | 'revertDecline' | 'none';

/** What an earlier answer may have left behind, as the surface reads it when
 *  the next answer arrives. */
export interface ConsentRevisionState {
  /** Are any of this provider's hook commands on disk right now
   *  (areHooksInstalled)? Callers that cannot read it pass false — the file is
   *  then never touched on a guess. */
  installed: boolean;
  /** The provider's durable consent record — a TRI-STATE, not a boolean, because each value is a different thing to
   *  undo. `granted` can exist with nothing on disk (install records the grant BEFORE it writes, and the write can
   *  fail; keying the revert off `installed` stranded exactly that user), and `declined` carries the provenance that
   *  the persisted hooks-off was the ANSWER's own write, which a revised "not now" takes back with it. */
  consent: 'granted' | 'declined' | 'unanswered';
}

/**
 * Fail-closed on exact matches: only literal `'install'` approves and only literal `'never'` declines durably.
 * `'notNow'`, a dismissal that sends nothing, a truncated payload and any crafted value fall through to the no-write
 * actions. `unknown` is the honest type for `choice` — this runs on a wire message, and narrowing it is the point.
 */
export function consentActionFor(choice: unknown, state: ConsentRevisionState): ConsentAction {
  if (choice === 'install') return 'install';
  if (choice === 'never') return state.installed ? 'disable' : 'persistOff';
  if (choice === 'notNow') {
    if (state.consent === 'declined') return 'revertDecline';
    if (state.installed || state.consent === 'granted') return 'revert';
    return 'none';
  }
  return 'none';
}
