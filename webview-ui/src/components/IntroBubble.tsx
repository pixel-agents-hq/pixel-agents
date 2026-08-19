import { useEffect, useRef, useState } from 'react';

import { DISCORD_INVITE_URL } from '../changelogData.js';
import {
  CLAUDE_CODE_INSTALL_COMMAND,
  CLAUDE_CODE_URL,
  INTRO_BUBBLE_EDGE_MARGIN_PX,
  INTRO_BUBBLE_MAX_WIDTH_PX,
  INTRO_BUBBLE_Z_INDEX,
} from '../constants.js';
import type { ConsentChoice } from '../hooks/introTourState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { DiscordIcon } from './ChangelogModal.js';
import { computeIntroBubbleGeometry } from './introBubbleGeometry.js';
import { Button } from './ui/Button.js';

interface IntroBubbleProps {
  officeState: OfficeState;
  /** Server-provided copy for the consent step (hooksConsentRequest). Rendered
   *  verbatim so that step shows the exact terms being approved — the webview
   *  keeps no copy of its own to drift out of sync with the server's
   *  disclosure. The other steps' copy is the webview's own: it carries no
   *  terms, only orientation. */
  headline: string;
  disclosure: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** The closing step's verdict: the install this tour asked for FAILED. The
   *  tour must not congratulate a user whose install failed. Owned by
   *  useIntroTour, which sees `hooksStatus` arrive and knows what this tour
   *  sent. */
  installFailed: boolean;
  /** An install was sent and no verdict has arrived: the consent step HOLDS —
   *  buttons disabled, Install reading "Installing..." — and only advances to
   *  the closing step when the verdict lands (see `choose`). Advancing on the
   *  click was tried twice: the success title flashed the wrong verdict when
   *  the install failed, and a neutral "Installing hooks..." title still
   *  flashed on every success. Holding means the closing step only ever
   *  renders WITH its verdict. */
  installPending: boolean;
  /** A consent-step button click: sends the choice to the server and the tour
   *  moves on. Does NOT close the tour — the caller must keep this component
   *  mounted after a choice so the closing step can show. */
  onChoice: (choice: ConsentChoice) => void;
  /** Every way the tour ends: the X, Escape, or Let's Go. Sends NOTHING by
   *  itself — an unanswered consent step changes nothing and the whole Intro
   *  returns the next time the office is opened. */
  onClose: () => void;
  /** True while another surface owns Escape — an open Settings/changelog modal
   *  (stacked ABOVE this bubble) or the layout editor's multi-stage Esc
   *  ladder. Escape aborts the tour only when the tour is topmost; without
   *  this gate it silently aborted UNDER an open modal. */
  escapeSuppressed: boolean;
}

const STEP_COUNT = 4;
const WELCOME_STEP = 0;
const CLAUDE_CODE_STEP = 1;
const CONSENT_STEP = 2;
const CLOSING_STEP = 3;

/**
 * The Intro: the four-step first-run tour the greeter character "speaks",
 * shared by both surfaces (the VS Code webview and the standalone browser
 * render this same component off the same server message).
 *
 * Steps: welcome → Claude Code → hooks consent → all set. The consent step is
 * the same first-run ask as before, now wrapped in a tour; its copy still
 * arrives from the server and its buttons still send `hooksConsentResponse`
 * the moment they are clicked. Back from the closing step re-opens the consent
 * step for a genuine change of mind — the server treats a revised answer as an
 * absolute statement and undoes a landed install when the revision asks for
 * that (consentGate's disable/revert actions).
 *
 * Diegetic: a greeter character (char_0) stands near the office's bottom-left
 * corner and this component is its speech bubble, anchored up-right of its
 * head like ToolOverlay anchors above agents. Mounting spawns the greeter;
 * EVERY close path — the X, Escape, Let's Go, or a hooksStatus that moots an
 * unanswered ask — unmounts this component, and the unmount despawns the
 * greeter, so the two can never disagree. While mounted it feeds
 * officeState.greeterCameraTarget so the camera drifts to center character +
 * bubble together (a manual pan cancels that; see
 * OfficeState.cancelGreeterCamera).
 *
 * All geometry — bubble position, tail, camera target — comes from
 * computeIntroBubbleGeometry, a pure per-frame function of the measured
 * frame; this component only measures and renders.
 *
 * Fail-closed by construction: only the three consent-step buttons send
 * anything. The X and Escape close without sending, so an unanswered ask
 * changes nothing and reappears on the next open. Clicks on the office around
 * the bubble are deliberately inert — the consent step is a decision surface,
 * and a stray click must not read as an answer.
 */
export function IntroBubble({
  officeState,
  headline,
  disclosure,
  containerRef,
  zoom,
  panRef,
  installFailed,
  installPending,
  onChoice,
  onClose,
  escapeSuppressed,
}: IntroBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [step, setStep] = useState(WELCOME_STEP);

  // The greeter lives exactly as long as this component.
  useEffect(() => {
    officeState.spawnGreeter();
    return () => officeState.despawnGreeter();
  }, [officeState]);

  useEffect(() => {
    if (escapeSuppressed) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, escapeSuppressed]);

  // Per-frame tick (same pattern as ToolOverlay): re-render — the greeter's
  // matrix effect, a pan, and the camera drift all move the anchor between
  // renders — and feed the camera target from the same geometry the render
  // uses, so the drift and the drawn bubble can never disagree. Ignored after
  // a manual pan (cancelGreeterCamera).
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const ch = officeState.greeter;
      const bubble = bubbleRef.current;
      const container = containerRef.current;
      if (ch && bubble && container && bubble.offsetWidth > 0) {
        officeState.setGreeterCameraTarget(
          computeIntroBubbleGeometry({
            layout: officeState.getLayout(),
            containerRect: container.getBoundingClientRect(),
            zoom,
            pan: panRef.current,
            dpr: window.devicePixelRatio || 1,
            greeter: ch,
            bubbleWidth: bubble.offsetWidth,
            bubbleHeight: bubble.offsetHeight,
          }).cameraTarget,
        );
      }
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [officeState, zoom, containerRef, panRef]);

  // The held install's verdict arrived (installPending fell): move on to the
  // closing step. Back is disabled while pending, so the fall can only ever
  // happen with the consent step on screen.
  const prevPendingRef = useRef(false);
  useEffect(() => {
    if (prevPendingRef.current && !installPending) setStep(CLOSING_STEP);
    prevPendingRef.current = installPending;
  }, [installPending]);

  const el = containerRef.current;
  if (!el) return null;

  const greeter = officeState.greeter;
  // Let the materialization effect finish before the greeter "speaks".
  if (greeter && greeter.matrixEffect === 'spawn') return null;

  const rect = el.getBoundingClientRect();
  const maxWidth = Math.min(
    INTRO_BUBBLE_MAX_WIDTH_PX,
    rect.width - 2 * INTRO_BUBBLE_EDGE_MARGIN_PX,
  );

  // Measurements come from the previous frame's node (the rAF tick re-renders
  // continuously); until the first measure, stay hidden.
  const bw = bubbleRef.current?.offsetWidth ?? 0;
  const bh = bubbleRef.current?.offsetHeight ?? 0;
  const measured = bw > 0 && bh > 0;

  let wrapperStyle: React.CSSProperties;
  let tailSquares: Array<{ x: number; y: number; size: number }> = [];
  if (greeter) {
    const geometry = computeIntroBubbleGeometry({
      layout: officeState.getLayout(),
      containerRect: rect,
      zoom,
      pan: panRef.current,
      dpr: window.devicePixelRatio || 1,
      greeter,
      bubbleWidth: bw,
      bubbleHeight: bh,
    });
    wrapperStyle = { left: geometry.left, top: geometry.top };
    tailSquares = geometry.tailSquares;
  } else {
    // Degenerate layout (no walkable tile for the greeter): the tour still must
    // be walkable, so fall back to a centered panel without the character.
    wrapperStyle = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  }

  const back = (): void => setStep((s) => Math.max(WELCOME_STEP, s - 1));
  const forward = (): void => setStep((s) => Math.min(CLOSING_STEP, s + 1));
  const choose = (choice: ConsentChoice): void => {
    onChoice(choice);
    // A decline has no outcome to wait on, so it advances immediately. An
    // install holds this step (buttons disabled via installPending) and
    // advances when its verdict arrives — the pending-fall effect above.
    if (choice !== 'install') setStep(CLOSING_STEP);
  };

  const titles = [
    'Welcome to Pixel Agents!',
    'Powered by Claude Code',
    headline,
    installFailed ? "Hooks couldn't be installed" : "You're all set!",
  ];

  return (
    <div
      className="absolute"
      style={{
        ...wrapperStyle,
        zIndex: INTRO_BUBBLE_Z_INDEX,
        visibility: measured || !greeter ? undefined : 'hidden',
      }}
    >
      {/* Tail squares render BEFORE the panel so the bubble paints over any
          overlap when the head sits right under (or behind) the panel. */}
      {tailSquares.map(({ x, y, size }, i) => (
        <div
          key={i}
          aria-hidden
          className="absolute"
          style={{
            left: x,
            top: y,
            width: size,
            height: size,
            background: 'var(--color-bg)',
            border: '2px solid var(--color-border)',
          }}
        />
      ))}
      <div
        ref={bubbleRef}
        role="dialog"
        aria-label={titles[step]}
        className="pixel-panel relative py-10 px-14 leading-[1.4]"
        style={{ maxWidth }}
      >
        {/* Same close control as the Settings/changelog modals (ui/Modal.tsx):
            ghost icon button, plain lowercase x. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          className="absolute top-4 right-4"
          onClick={onClose}
        >
          x
        </Button>

        {/* Step dots: the tour's "1 of 4", drawn as pixels rather than prose. */}
        <div className="flex gap-4 mb-8" aria-label={`Step ${step + 1} of ${STEP_COUNT}`}>
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <div
              key={i}
              aria-hidden
              className={`w-6 h-6 ${i === step ? 'bg-accent' : 'bg-btn-bg'}`}
            />
          ))}
        </div>

        <div className="text-xl mb-8 text-accent-bright pr-20">{titles[step]}</div>

        {step === WELCOME_STEP && (
          <p className="text-sm m-0 mb-8">
            In this office, your AI agents become tiny pixel characters: they type at their desks
            while they work, wander off when they're done, and speak up when they need you.
          </p>
        )}

        {step === CLAUDE_CODE_STEP && (
          <>
            <p className="text-sm m-0 mb-8">
              The office watches your Claude Code sessions and brings them to life in here. New to
              Claude Code? Download it first:
            </p>
            <div className="text-sm bg-btn-bg border-2 border-border py-4 px-8 mb-8 select-all">
              {CLAUDE_CODE_INSTALL_COMMAND}
            </div>
            <p className="text-sm m-0 mb-8">
              For more info, visit{' '}
              <a
                href={CLAUDE_CODE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-bright hover:text-accent no-underline"
              >
                claude.com/claude-code
              </a>
            </p>
          </>
        )}

        {step === CONSENT_STEP &&
          disclosure.split('\n\n').map((paragraph, i) => (
            <p key={i} className="text-sm m-0 mb-8">
              {paragraph}
            </p>
          ))}

        {step === CLOSING_STEP && (
          <>
            {installFailed ? (
              <p className="text-sm m-0 mb-8">
                Something went wrong writing to your Claude Code settings, so the office will watch
                your sessions the slower way instead. No worries, everything still works and you can
                retry activating them any time from Settings.
              </p>
            ) : null}
            <p className="text-sm m-0 mb-8">
              Enjoy your new office! Questions, ideas, or pixel art to show off? Come hang out in
              our Discord.
            </p>
            <p className="text-base text-center m-0 mt-12 mb-12">
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-8 text-accent-bright hover:text-accent no-underline"
              >
                <DiscordIcon />
                Join our Discord!
              </a>
            </p>
          </>
        )}

        <div className="flex items-center justify-between gap-6 mt-10 flex-wrap">
          {/* Left slot: Back everywhere it can go back; a spacer on the opening
              step keeps the right-side buttons in place. */}
          {step === WELCOME_STEP ? (
            <span />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={installPending}
              className={installPending ? 'opacity-[var(--btn-disabled-opacity)]' : ''}
              onClick={back}
            >
              Back
            </Button>
          )}

          {step === CONSENT_STEP ? (
            <div className="flex items-center justify-end gap-6 flex-wrap">
              <Button
                variant="ghost"
                size="sm"
                disabled={installPending}
                className={installPending ? 'opacity-[var(--btn-disabled-opacity)]' : ''}
                onClick={() => choose('never')}
              >
                Don't Ask Again
              </Button>
              <Button
                variant={installPending ? 'disabled' : 'default'}
                size="sm"
                disabled={installPending}
                onClick={() => choose('notNow')}
              >
                Not Now
              </Button>
              <Button
                variant={installPending ? 'disabled' : 'accent'}
                size="sm"
                disabled={installPending}
                onClick={() => choose('install')}
              >
                {installPending ? 'Installing...' : 'Install Hooks'}
              </Button>
            </div>
          ) : step === CLOSING_STEP ? (
            <Button variant="accent" size="sm" onClick={onClose}>
              Let's Go
            </Button>
          ) : (
            <Button variant="default" size="sm" onClick={forward}>
              Continue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
