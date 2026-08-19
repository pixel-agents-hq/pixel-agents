import { useCallback, useEffect, useReducer, useRef } from 'react';

import type { HooksConsentRequest } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import type { ConsentChoice } from './introTourState.js';
import { INTRO_TOUR_IDLE, reduceIntroTour } from './introTourState.js';

/**
 * Everything the App needs to run the Intro, off the wire state useExtensionMessages already tracks. The semantics —
 * which asks survive being mooted, when a hooksStatus is this tour's verdict — live in the pure reducer
 * (introTourState.ts); this only turns props into events and choices into sends. The verdict is driven by
 * `hooksStatusSeq` per provider, not `hooksInstalled`: a FAILED install re-reports the `false` already held, so only
 * the message's ARRIVAL says the server answered, and another provider's status never settles this tour.
 */
export function useIntroTour(args: {
  consentRequest: HooksConsentRequest | null;
  hooksInstalled: Record<string, boolean>;
  hooksStatusSeq: Record<string, number>;
  dismissConsentRequest: (providerId: string | null) => void;
}): {
  /** The ask to render, or null while no tour should be up. */
  intro: HooksConsentRequest | null;
  /** The closing step's verdict: the install this tour asked for failed. */
  installFailed: boolean;
  /** An install was sent and its verdict hasn't arrived yet: the consent step
   *  holds with its buttons disabled until this falls, so the closing step
   *  only ever renders with a verdict — never one it does not have. */
  installPending: boolean;
  /** A consent-step button click: sends the choice, arms the verdict wait. */
  onChoice: (choice: ConsentChoice) => void;
  /** Every way the tour ends. Sends NOTHING — an unanswered ask must return
   *  on the next open. */
  onClose: () => void;
} {
  const [state, dispatch] = useReducer(reduceIntroTour, INTRO_TOUR_IDLE);

  useEffect(() => {
    dispatch({ kind: 'requestChanged', request: args.consentRequest });
    // state.intro is a dependency for the DEFERRED-ask case: an answered tour holds its snapshot and ignores another
    // provider's request, so once it closes this effect must re-deliver the still-pending head even though the prop
    // never changed. The reducer is idempotent on repeats, so the extra dispatches are no-ops, not loops.
  }, [args.consentRequest, state.intro]);

  // Fan the per-provider seq map out into one statusArrived event per bumped
  // provider. The previous counts live in a ref: the dispatch must fire once
  // per ARRIVAL, and only for the provider whose seq moved.
  const prevSeqRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const [providerId, seq] of Object.entries(args.hooksStatusSeq)) {
      if (seq !== (prevSeqRef.current[providerId] ?? 0)) {
        dispatch({
          kind: 'statusArrived',
          providerId,
          installed: args.hooksInstalled[providerId] === true,
        });
      }
    }
    prevSeqRef.current = args.hooksStatusSeq;
    // hooksInstalled is read on the seq bump, deliberately not a dependency:
    // only the ARRIVAL of a hooksStatus may settle the verdict (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.hooksStatusSeq]);

  // The snapshot's provider is what a choice answers about — captured in a
  // ref so onChoice stays referentially stable across the per-frame renders.
  const providerIdRef = useRef<string | null>(null);
  providerIdRef.current = state.intro?.providerId ?? providerIdRef.current;

  const onChoice = useCallback((choice: ConsentChoice) => {
    const providerId = providerIdRef.current;
    if (!providerId) return; // no ask on screen: nothing to answer about
    dispatch({ kind: 'choiceSent', choice });
    transport.send({ type: 'hooksConsentResponse', providerId, choice });
  }, []);

  const { dismissConsentRequest } = args;
  const onClose = useCallback(() => {
    dispatch({ kind: 'closed' });
    // Dismiss the ask THIS tour was about (the snapshot's provider) so a
    // queued ask for another provider is never dropped in its place.
    dismissConsentRequest(providerIdRef.current);
  }, [dismissConsentRequest]);

  return {
    intro: state.intro,
    installFailed: state.installFailed,
    installPending: state.awaitingOutcome,
    onChoice,
    onClose,
  };
}
