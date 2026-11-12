import { useEffect, useReducer, useRef } from 'react';

import type { TutorialStatus } from '../../../core/src/messages.js';
import { type Say, useSay } from '../components/introSpeech.js';
import { Button } from '../components/ui/Button.js';
import { reduceTutorialOffer, TUTORIAL_OFFER_START } from './tutorialOffer.js';

interface TutorialAskProps {
  status: TutorialStatus;
  /** The last refusal of a start (tutorialStore), numbered. */
  rejected: { reason: string; seq: number } | null;
  /** Inside the Intro's closing step the way out reads "Let's Go"; alone
   *  (Settings → Play the Tutorial) "Not Now". */
  embedded: boolean;
  /** What the greeter says: the headline, then the server's copy. */
  say: Say;
  /** Back to the Intro's previous step; absent when there is none. */
  onBack?: () => void;
  /** Every way out: Let's Go / Not Now, Close, and a started run. */
  onClose: () => void;
  /** The yes: the caller sends startTutorial (and readies the terminal to open). */
  onStart: () => void;
}

/**
 * The tutorial's ask, one step: the server's copy (it starts a Claude Code
 * session), spoken by the greeter in the Intro's dialog (`say`), and this, its
 * menu: Show Me Around, then the wait for the Guide's run. IntroDialog
 * supplies the boxes and the close x. The flow is tutorialOffer.ts.
 */
export function TutorialAsk({
  status,
  rejected,
  embedded,
  say,
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
  useSay(
    say,
    failed
      ? ["The tour couldn't start."]
      : blocked
        ? [status.headline]
        : [status.headline, status.disclosure],
  );

  return (
    <>
      {blocked ? (
        <p className="text-sm m-0 mb-8" data-testid="tutorial-unavailable">
          {status.unavailableReason ?? "The tutorial can't start here right now."}
        </p>
      ) : failed ? (
        <p className="text-sm m-0 mb-8 text-status-error">{state.reason}</p>
      ) : null}

      <div
        className="flex items-center justify-between gap-6 mt-4 flex-wrap"
        data-testid={blocked || failed ? undefined : 'tutorial-offer'}
      >
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
