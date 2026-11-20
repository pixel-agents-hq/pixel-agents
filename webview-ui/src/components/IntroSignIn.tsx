import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { CliSignInControls } from '../signIn/useCliSignIn.js';
import { IntroOption, IntroOptionLink, IntroOptions } from './IntroOptions.js';
import { IntroBelowSlot } from './introOptionsSlot.js';
import { type Say, useSay } from './introSpeech.js';
import { Button } from './ui/Button.js';

interface IntroSignInProps {
  signIn: CliSignInControls;
  /** What the greeter says for the state the sign-in is in. */
  say: Say;
  /** Signed in without a sign-in of this step's: on to the next step. */
  onContinue: () => void;
}

/**
 * The Intro's sign-in step: Claude Code has no login on this machine, and the
 * choices wait until it has one. One button starts it. Where the office is
 * open on the host, the CLI opens the sign-in page itself and finishes when
 * the user authorizes; anywhere else this opens the page in a new tab and the
 * user pastes back the code it ends on. The server reports each turn
 * (cliSignInStatus); nothing here decides that the CLI is signed in. The
 * greeter speaks the state (`say`); this is the step's menu: the options, and
 * over them the code bar while a sign-in waits for its code.
 */
export function IntroSignIn({ signIn, say, onContinue }: IntroSignInProps) {
  const { status, pending, onHost, check, start, submitCode } = signIn;
  const below = useContext(IntroBelowSlot);
  const [code, setCode] = useState('');
  // A sign-in was started from this step (its end moves the tour on).
  const [started, setStarted] = useState(false);
  // The tab opened on the click, waiting for the page's address.
  const tab = useRef<Window | null>(null);

  // Ask on arrival: the CLI may have been installed or signed in since the Intro opened.
  useEffect(() => {
    check();
  }, [check]);

  const url = status?.signedIn ? undefined : status?.signInUrl;
  useEffect(() => {
    if (!url || !tab.current) return;
    if (!tab.current.closed) tab.current.location.href = url;
    tab.current = null;
  }, [url]);

  // Signed in by a sign-in started here: the greeter says so and the user
  // reads on (IntroDialog shows no menu then). Signed in any other way (Check
  // Again found a login made in a terminal): on with the tour, once, unsaid.
  const signedIn = status?.signedIn === true;
  const movedOn = useRef(false);
  useEffect(() => {
    if (!signedIn || started || movedOn.current) return;
    movedOn.current = true;
    onContinue();
  }, [signedIn, started, onContinue]);

  const begin = (account: 'subscription' | 'api'): void => {
    setStarted(true);
    setCode('');
    if (!onHost) {
      // Opened on the click itself (a tab opened later, when the address
      // arrives, is a blocked pop-up) and cut off from this page.
      tab.current = window.open('', '_blank');
      if (tab.current) tab.current.opener = null;
    }
    start(account);
  };
  const submit = (): void => {
    const trimmed = code.trim();
    if (trimmed) submitCode(trimmed);
  };

  const starting = started && pending && !url;
  useSay(
    say,
    status === undefined
      ? ['Checking whether Claude Code is signed in...']
      : signedIn
        ? started
          ? ['Claude Code is signed in. On we go!']
          : []
        : url
          ? [
              status.openedOnHost
                ? "I opened Claude's sign-in page in your browser. Press Authorize there and I'll take it from here."
                : "Press authorize on Claude's sign-in page, then paste the code it gives you here.",
            ]
          : [
              "It seems this computer isn't signed in to Claude Code yet. Sign in and I'll show you the rest!",
            ],
  );
  return (
    <>
      {status === undefined || signedIn ? null : url ? (
        // The code bar: the dialog's width, the field and the button that goes
        // on, bare on the office (no box of its own).
        <div className="flex w-full items-center gap-6">
          <input
            type="text"
            value={code}
            aria-label="Sign-in code"
            placeholder="Paste the code from the sign-in page"
            autoComplete="off"
            spellCheck={false}
            data-testid="intro-sign-in-code"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            className="flex-1 min-w-0 text-sm py-2 px-4 bg-bg-dark border-2 border-border rounded-none text-text"
          />
          <Button
            variant={pending || !code.trim() ? 'disabled' : 'accent'}
            size="sm"
            disabled={pending || !code.trim()}
            onClick={submit}
          >
            {pending ? 'Checking...' : 'Finish'}
          </Button>
        </div>
      ) : (
        status.error &&
        !pending &&
        below &&
        // Under the dialog box, centred in the space below it: the options stay on the box.
        createPortal(
          <p
            className="text-sm m-0 text-center text-status-error"
            data-testid="intro-sign-in-error"
            role="alert"
          >
            {status.error}
          </p>,
          below,
        )
      )}

      <IntroOptions inline={!!url} data-testid="intro-sign-in" data-signed-in={signedIn}>
        {url ? (
          <>
            <IntroOptionLink href={url} data-testid="intro-sign-in-link">
              Open Sign-In Page
            </IntroOptionLink>
            <IntroOption disabled={pending} onClick={() => begin('subscription')}>
              Start Over
            </IntroOption>
          </>
        ) : (
          <>
            <IntroOption
              kind="primary"
              disabled={status === undefined || starting}
              data-testid="intro-sign-in-start"
              onClick={() => begin('subscription')}
            >
              {starting ? 'Starting...' : 'Sign In'}
            </IntroOption>
            <IntroOption disabled={status === undefined || pending} onClick={() => begin('api')}>
              Use API Account
            </IntroOption>
            <IntroOption disabled={status === undefined || pending} onClick={check}>
              Check Again
            </IntroOption>
          </>
        )}
      </IntroOptions>
    </>
  );
}
