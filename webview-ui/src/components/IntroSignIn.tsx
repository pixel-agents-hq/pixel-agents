import { useEffect, useRef, useState } from 'react';

import type { CliSignInControls } from '../signIn/useCliSignIn.js';
import { type Say, useSay } from './introSpeech.js';
import { Button } from './ui/Button.js';

interface IntroSignInProps {
  signIn: CliSignInControls;
  /** What the greeter says for the state the sign-in is in. */
  say: Say;
  onBack?: () => void;
  /** Signed in: on to the next step. */
  onContinue: () => void;
}

const LINK_CLASS = 'text-accent-bright hover:text-accent no-underline';
const TEXT_BUTTON_CLASS =
  'p-0 bg-transparent border-0 text-sm text-accent hover:text-accent-bright cursor-pointer underline';

/**
 * The Intro's sign-in step: Claude Code has no login on this machine, and the
 * choices wait until it has one. One button starts it. Where the office is
 * open on the host, the CLI opens the sign-in page itself and finishes when
 * the user authorizes; anywhere else this opens the page in a new tab and the
 * user pastes back the code it ends on. The server reports each turn
 * (cliSignInStatus); nothing here decides that the CLI is signed in. The
 * greeter speaks the state (`say`); this is the step's menu.
 */
export function IntroSignIn({ signIn, say, onBack, onContinue }: IntroSignInProps) {
  const { status, pending, onHost, check, start, submitCode } = signIn;
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

  // The sign-in started here ended signed in: on with the tour, once.
  const signedIn = status?.signedIn === true;
  const movedOn = useRef(false);
  useEffect(() => {
    if (!signedIn || !started || movedOn.current) return;
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
        ? ['Claude Code is signed in. On we go!']
        : url
          ? [
              status.openedOnHost
                ? "I opened Claude's sign-in page in your browser. Press Authorize there and I'll take it from here."
                : "Press Authorize on Claude's sign-in page, then paste the code it gives you here.",
            ]
          : [
              "Sign in to Claude Code first: your agents work on your Claude account, and this computer isn't signed in yet.",
              "Sign in and I'll show you the rest.",
            ],
  );
  return (
    <div data-testid="intro-sign-in" data-signed-in={signedIn}>
      {status === undefined || signedIn ? null : url ? (
        <>
          <p className="text-sm m-0 mb-8 text-text-muted">
            {status.openedOnHost ? 'No page? ' : 'Lost the page? '}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
              data-testid="intro-sign-in-link"
            >
              Open the sign-in page
            </a>
            {status.openedOnHost ? ' and paste the code it gives you:' : '.'}
          </p>
          <div className="flex items-center gap-6 mb-8">
            <input
              type="text"
              value={code}
              aria-label="Sign-in code"
              placeholder="Paste the code"
              autoComplete="off"
              spellCheck={false}
              data-testid="intro-sign-in-code"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              className="flex-1 min-w-0 text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
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
        </>
      ) : (
        <>
          {status.error && !pending && (
            <p className="text-sm m-0 mb-8 text-status-error" data-testid="intro-sign-in-error">
              {status.error}
            </p>
          )}
          <p className="text-sm m-0 mb-8 text-text-muted">
            No subscription?{' '}
            <button
              type="button"
              className={TEXT_BUTTON_CLASS}
              disabled={pending}
              onClick={() => begin('api')}
            >
              Use an API account
            </button>
            . Signed in from a terminal?{' '}
            <button type="button" className={TEXT_BUTTON_CLASS} disabled={pending} onClick={check}>
              Check again
            </button>
            .
          </p>
        </>
      )}

      <div className="flex items-center justify-between gap-6 mt-4 flex-wrap">
        {onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        {signedIn ? (
          <Button variant="accent" size="sm" onClick={onContinue}>
            Continue
          </Button>
        ) : url ? (
          <Button
            variant="default"
            size="sm"
            disabled={pending}
            onClick={() => begin('subscription')}
          >
            Start Over
          </Button>
        ) : (
          <Button
            variant={status === undefined || starting ? 'disabled' : 'accent'}
            size="sm"
            disabled={status === undefined || starting}
            data-testid="intro-sign-in-start"
            onClick={() => begin('subscription')}
          >
            {starting ? 'Starting...' : 'Sign In'}
          </Button>
        )}
      </div>
    </div>
  );
}
