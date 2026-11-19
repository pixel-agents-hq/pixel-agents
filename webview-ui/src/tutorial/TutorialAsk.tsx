import { useEffect, useReducer, useRef } from 'react';

import type { TutorialStatus } from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { reduceTutorialOffer, TUTORIAL_OFFER_START } from './tutorialOffer.js';

interface TutorialAskProps {
  status: TutorialStatus;
  /** The last refusal of a start (tutorialStore), numbered. */
  rejected: { reason: string; seq: number } | null;
  /** Inside the Intro's closing step: the headline is a subheading under its
   *  title, and the way out reads "Let's Go". Alone (Settings → Play the
   *  Tutorial) the headline is the bubble's title and the way out "Not Now". */
  embedded: boolean;
  /** Back to the Intro's previous step; absent when there is none. */
  onBack?: () => void;
  /** Every way out: Let's Go / Not Now, Close, and a started run. */
  onClose: () => void;
  /** The yes: the caller sends startTutorial (and readies the terminal to open). */
  onStart: () => void;
}

/**
 * The tutorial's ask, one step: the server's copy (it starts a Claude Code
 * session), Show Me Around, then the wait for the Guide's run — rendered
 * inside the Intro's bubble (IntroBubble supplies the frame, the close x and
 * the step dots). The flow is tutorialOffer.ts.
 */
export function TutorialAsk({
  status,
  rejected,
  embedded,
  onBack,
  onClose,
  onStart,
}: TutorialAskProps) {
  const [state, dispatch] = useReducer(reduceTutorialOffer, TUTORIAL_OFFER_START);

  const running = status.run !== undefined;
  useEffect(() => dispatch({ kind: 'status', running }), [running]);
  // A refusal counts only once it is newer than the one on record when this step opened.
  const seenSeq = useRef(rejected?.seq ?? 0);
  useEffect(() => {
    if (rejected && rejected.seq > seenSeq.current) {
      seenSeq.current = rejected.seq;
      dispatch({ kind: 'rejected', reason: rejected.reason });
    }
  }, [rejected]);
  useEffect(() => {
    if (state.step === 'started') onClose();
  }, [state.step, onClose]);

  // Opened from Settings while the server can't start one (the MCP off, no
  // terminal): say why instead of an ask that could only fail.
  const blocked = state.step === 'ask' && !status.available;
  const starting = state.step === 'starting';
  const failed = state.step === 'failed';
  const title = failed ? "The tour couldn't start" : status.headline;

  return (
    <>
      <div
        className={
          embedded ? 'text-base mb-4 text-accent-bright' : 'text-xl mb-8 text-accent-bright pr-20'
        }
      >
        {title}
      </div>

      {blocked ? (
        <p className="text-sm m-0 mb-8" data-testid="tutorial-unavailable">
          {status.unavailableReason ?? "The tutorial can't start here right now."}
        </p>
      ) : failed ? (
        <p className="text-sm m-0 mb-8 text-status-error">{state.reason}</p>
      ) : (
        <p className="text-sm m-0 mb-8" data-testid="tutorial-offer">
          {status.disclosure}
        </p>
      )}

      <div className="flex items-center justify-between gap-6 mt-10 flex-wrap">
        {onBack && !starting ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={failed ? () => dispatch({ kind: 'retry' }) : onBack}
          >
            Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center justify-end gap-6 flex-wrap">
          {blocked || failed ? (
            <Button variant="default" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button
                variant={starting ? 'disabled' : 'default'}
                size="sm"
                disabled={starting}
                onClick={onClose}
              >
                {embedded ? "Let's Go" : 'Not Now'}
              </Button>
              <Button
                variant={starting ? 'disabled' : 'accent'}
                size="sm"
                disabled={starting}
                onClick={() => {
                  dispatch({ kind: 'confirm' });
                  onStart();
                }}
              >
                {starting ? 'Taking a Seat...' : 'Show Me Around'}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
