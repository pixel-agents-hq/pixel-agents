/**
 * The Intro's tutorial ask as a pure reducer: one step (the server's copy: it
 * starts a Claude Code session), then the wait for the server to say the
 * Guide's run started — or why it didn't. Nothing is sent until `confirm`; the
 * caller sends `startTutorial` on it and closes the Intro once the state
 * reaches `started`.
 */

export type TutorialOfferStep = 'ask' | 'starting' | 'started' | 'failed';

export interface TutorialOfferState {
  step: TutorialOfferStep;
  /** Why the start failed (`failed`), in the server's words. */
  reason: string | null;
}

export const TUTORIAL_OFFER_START: TutorialOfferState = { step: 'ask', reason: null };

export type TutorialOfferEvent =
  /** "Yes, please!": the yes. The caller sends startTutorial. */
  | { kind: 'confirm' }
  /** Back from a failure to the ask. */
  | { kind: 'retry' }
  /** A tutorialStatus arrived: whether a run is under way. */
  | { kind: 'status'; running: boolean }
  /** This office's start was refused. */
  | { kind: 'rejected'; reason: string };

export function reduceTutorialOffer(
  state: TutorialOfferState,
  event: TutorialOfferEvent,
): TutorialOfferState {
  switch (event.kind) {
    case 'confirm':
      return state.step === 'ask' ? { step: 'starting', reason: null } : state;
    case 'retry':
      return state.step === 'failed' ? TUTORIAL_OFFER_START : state;
    case 'status':
      // Only a start under way is settled by a run appearing.
      return state.step === 'starting' && event.running ? { step: 'started', reason: null } : state;
    case 'rejected':
      return state.step === 'starting' ? { step: 'failed', reason: event.reason } : state;
  }
}

/** Whether the Intro offers the tutorial now: the server can start one and none runs. */
export function tutorialOffered(
  status: { available: boolean; run?: unknown } | undefined,
): boolean {
  return status?.available === true && status.run === undefined;
}
