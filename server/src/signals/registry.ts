import type { SignalsHub } from './signalsHub.js';

/**
 * The registered SignalsHub, looked up by the hook handler, the transcript
 * parser and the connect-time resend (the same pattern as the progress tracker),
 * so none of them needs it threaded through a constructor. Callers pass their
 * store; the hub ignores stores it doesn't track (tests' stray stores).
 */
let hub: SignalsHub | null = null;

export function setSignalsHub(next: SignalsHub | null): void {
  hub = next;
}

export function getSignalsHub(): SignalsHub | null {
  return hub;
}
