/**
 * The Intro tour's wire-facing state machine, as a pure reducer.
 *
 * This is the half of the tour most likely to be wrong in a way no one
 * notices in review: which asks survive being mooted, when a hooksStatus
 * arrival is a verdict on THIS tour's install and when it is noise, what a
 * revised choice resets. None of it needs React or a DOM to verify, so it
 * lives here (Node-runner testable, like introBubbleGeometry) and
 * useIntroTour only wires it to React and the transport.
 */

import type { HooksConsentRequest } from '../../../core/src/messages.js';

/** What the consent step can answer. Only these exact values mean anything to
 *  the server; everything else falls through to its write-nothing path. */
export type ConsentChoice = 'install' | 'notNow' | 'never';

export interface IntroTourState {
  /**
   * The ask the tour renders from — a SNAPSHOT of the server's request, not a
   * live view. A consent-step choice makes the server answer with hooksStatus,
   * which moots the live request — but the tour must keep going to its
   * closing step, so an ANSWERED tour holds its snapshot when the request
   * goes null. An unanswered tour follows the request back to null: that null
   * means another surface or tab installed while this ask was open, and a
   * stale approval must not linger.
   */
  intro: HooksConsentRequest | null;
  /** The consent answer this tour sent, if any. */
  sentChoice: ConsentChoice | null;
  /** Armed by an install choice: the NEXT hooksStatus arrival is its verdict. */
  awaitingOutcome: boolean;
  /** The closing step's verdict: the install this tour asked for failed. */
  installFailed: boolean;
}

export const INTRO_TOUR_IDLE: IntroTourState = {
  intro: null,
  sentChoice: null,
  awaitingOutcome: false,
  installFailed: false,
};

export type IntroTourEvent =
  /** The server's live consent request changed (arrived, or was mooted). */
  | { kind: 'requestChanged'; request: HooksConsentRequest | null }
  /** A hooksStatus ARRIVED — the event, not the value. A failed install re-reports the `false` already held, so the
   *  value alone cannot tell "still pending" from "failed"; only the arrival settles the verdict. Carries its
   *  provider: a status about a DIFFERENT provider is never a verdict on this tour's install. */
  | { kind: 'statusArrived'; providerId: string; installed: boolean }
  /** A consent-step button sent its choice to the server. */
  | { kind: 'choiceSent'; choice: ConsentChoice }
  /** The tour closed (the X, Escape, Let's Go) — back to idle, so the next
   *  request starts a fresh tour with no verdict left over. */
  | { kind: 'closed' };

export function reduceIntroTour(state: IntroTourState, event: IntroTourEvent): IntroTourState {
  switch (event.kind) {
    case 'requestChanged':
      if (event.request) {
        // A request for a DIFFERENT provider is a fresh ask, not an update. While THIS tour is unanswered the new ask
        // replaces it as a CLEAN tour: choice, armed wait and verdict belong to the previous provider, and an
        // inherited awaitingOutcome would read the new provider's first status as a verdict on an install it never
        // sent. While ANSWERED, hold the snapshot — the caller re-delivers the deferred ask once this tour closes.
        if (state.intro !== null && state.intro.providerId !== event.request.providerId) {
          if (state.sentChoice !== null) return state;
          return { ...INTRO_TOUR_IDLE, intro: event.request };
        }
        // Same-reference repeat: a no-op returns the same state, so the
        // driver's re-delivery dispatches can never re-render in a loop.
        if (state.intro === event.request) return state;
        return { ...state, intro: event.request };
      }
      // Mooted. Only an UNANSWERED tour vanishes with the request (see
      // `intro`); an answered one is already past the ask.
      if (state.sentChoice !== null || state.intro === null) return state;
      return { ...state, intro: null };

    case 'statusArrived':
      // Only an armed wait reads a status as its verdict; every other arrival (the handshake's initial report, a
      // Settings toggle in another tab, another provider's install) is about someone else's write. The provider comes
      // from the snapshot request — this tour's install was sent for exactly that one.
      if (!state.awaitingOutcome) return state;
      if (state.intro !== null && event.providerId !== state.intro.providerId) return state;
      return { ...state, awaitingOutcome: false, installFailed: !event.installed };

    case 'choiceSent':
      // Only an install has an outcome the closing step reports. A decline
      // must not arm the wait: the status it may trigger is not a verdict on
      // an install, and an armed wait would misread an unrelated status
      // later. Either way a revised choice clears the earlier verdict.
      return {
        ...state,
        sentChoice: event.choice,
        awaitingOutcome: event.choice === 'install',
        installFailed: false,
      };

    case 'closed':
      return INTRO_TOUR_IDLE;
  }
}
