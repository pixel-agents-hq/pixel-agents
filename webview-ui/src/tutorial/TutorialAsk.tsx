import { useEffect, useReducer, useRef } from 'react';

import type { TutorialStatus } from '../../../core/src/messages.js';
import { IntroOption, IntroOptions, IntroPanel } from '../components/IntroOptions.js';
import { type Say, useSay } from '../components/introSpeech.js';
import { reduceTutorialOffer, TUTORIAL_OFFER_START } from './tutorialOffer.js';

interface TutorialAskProps {
  status: TutorialStatus;
  /** The last refusal of a start (tutorialStore), numbered. */
  rejected: { reason: string; seq: number } | null;
  /** What the greeter says: the server's headline. */
  say: Say;
  /** The no: No, thanks (in the Intro's closing step and alone, Settings → Play the Tutorial). */
  onDecline: () => void;
  /** Close, and a started run. */
  onClose: () => void;
  /** The yes: the caller sends startTutorial (and readies the terminal to open). */
  onStart: () => void;
}

/**
 * The tutorial's ask, one step: the server's headline, spoken by the greeter in the Intro's dialog (`say`), and this, its
 * menu: Yes, please!, then the wait for the Guide's run. IntroDialog
 * supplies the boxes and the close x. The flow is tutorialOffer.ts.
 */
export function TutorialAsk({
  status,
  rejected,
  say,
  onDecline,
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
      ? ["Sorry, I can't show you around just now! Try Settings → Play the Tutorial later."]
      : [status.headline],
  );

  return (
    <>
      {blocked ? (
        <IntroPanel>
          <p className="text-sm m-0" data-testid="tutorial-unavailable">
            {status.unavailableReason ?? "The tutorial can't start here right now."}
          </p>
        </IntroPanel>
      ) : failed ? (
        <IntroPanel>
          <p className="text-sm m-0 text-status-error">{state.reason}</p>
        </IntroPanel>
      ) : null}

      <IntroOptions data-testid={blocked || failed ? undefined : 'tutorial-offer'}>
        {blocked || failed ? (
          <>
            {failed && (
              <IntroOption kind="primary" onClick={() => dispatch({ kind: 'retry' })}>
                Try Again
              </IntroOption>
            )}
            <IntroOption onClick={onClose}>Close</IntroOption>
          </>
        ) : (
          <>
            <IntroOption
              kind="primary"
              disabled={starting}
              onClick={() => {
                dispatch({ kind: 'confirm' });
                onStart();
              }}
            >
              {starting ? 'Taking a Seat...' : 'Yes, please!'}
            </IntroOption>
            <IntroOption disabled={starting} onClick={onDecline}>
              No, thanks
            </IntroOption>
          </>
        )}
      </IntroOptions>
    </>
  );
}
