import { useEffect, useRef, useState } from 'react';

import type {
  HooksConsentRequest,
  OfficeMcpChoice,
  OfficeMcpConsentRequest,
  TutorialStatus,
} from '../../../core/src/messages.js';
import { DISCORD_INVITE_URL } from '../changelogData.js';
import { useCast } from '../characters/castStore.js';
import { greeterPalette } from '../characters/profiles.js';
import {
  CLAUDE_CODE_INSTALL_COMMAND,
  CLAUDE_CODE_URL,
  INTRO_BUBBLE_EDGE_MARGIN_PX,
  INTRO_BUBBLE_MAX_WIDTH_PX,
  INTRO_BUBBLE_Z_INDEX,
} from '../constants.js';
import type { ConsentChoice } from '../hooks/introTourState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { useCliSignIn } from '../signIn/useCliSignIn.js';
import { TutorialAsk } from '../tutorial/TutorialAsk.js';
import { tutorialOffered } from '../tutorial/tutorialOffer.js';
import { useUsageBridge } from '../usage/useUsageBridge.js';
import { DiscordIcon } from './ChangelogModal.js';
import { computeIntroBubbleGeometry } from './introBubbleGeometry.js';
import { type IntroChoiceId, type IntroChoiceOption, IntroChoices } from './IntroChoices.js';
import { IntroSignIn } from './IntroSignIn.js';
import { Button } from './ui/Button.js';

interface IntroBubbleProps {
  officeState: OfficeState;
  /** Server-provided copy for the consent step (hooksConsentRequest). Rendered
   *  verbatim so that step shows the exact terms being approved — the webview
   *  keeps no copy of its own to drift out of sync with the server's
   *  disclosure. The other steps' copy is the webview's own: it carries no
   *  terms, only orientation. Null = no hooks ask: an office whose user
   *  finished the Intro before the Pixel Office MCP step existed sees that
   *  step alone. */
  hooksAsk: HooksConsentRequest | null;
  /** The Pixel Office MCP ask's server copy (officeMcpConsentRequest), or
   *  null when this office is not asked. Shares the consent step with hooks. */
  mcpAsk: OfficeMcpConsentRequest | null;
  /** The Pixel Office MCP answer, sent at once with the hooks one (Back
   *  re-opens the step and a revised answer replaces it). */
  onMcpChoice: (choice: OfficeMcpChoice) => void;
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
  /** The tutorial the Intro may offer at its end (tutorialStatus), the last
   *  refusal of a start, and the start itself (the caller sends startTutorial
   *  wearing the greeter's look). Without hooks and MCP asks the Intro is the
   *  tutorial step alone (Settings → Play the tutorial). */
  tutorial: {
    status: TutorialStatus | undefined;
    rejected: { reason: string; seq: number } | null;
    onStart: (palette: number) => void;
  };
}

type StepId = 'welcome' | 'claudeCode' | 'signIn' | 'choices' | 'closing' | 'tutorial';

/** Each box's name in the choices step (the server writes the line and the terms). */
const CHOICE_LABELS: Record<IntroChoiceId, string> = {
  usage: 'Usage bars',
  hooks: 'Live updates',
  mcp: 'Agents that use the office',
};

/**
 * The Intro: the first-run tour the greeter character "speaks",
 * shared by both surfaces (the VS Code webview and the standalone browser
 * render this same component off the same server message).
 *
 * Steps: welcome ("Hi, I'm <greeter>") → get Claude Code (only when the
 * server found no CLI) → sign in to Claude Code (only when the CLI is there
 * and reports no login: IntroSignIn, which the choices wait for) → choices → all set, which offers the tutorial where
 * the server can start one (its ask, one paragraph, on the same step). The
 * choices step (IntroChoices) holds one box per thing to turn on, all off to
 * start: usage bars (only where the bridge can be installed and is not yet),
 * live updates (the hooks ask) and the Pixel Office MCP (where the server
 * offers it and it is unanswered), each a line with its terms behind "Read
 * more". Continue sends every answer at once — `hooksConsentResponse`
 * install | never, `officeMcpConsentResponse` allow | decline, the usage
 * bridge on (or back off, on a revision) — and holds until they settle.
 * Without a hooks ask (the user finished the Intro before the MCP ask
 * existed) the tour is the choices step with the MCP box alone, then all set;
 * without either, the tutorial's ask alone (Settings → Play the Tutorial).
 * Copy for every ask arrives from the server. Back from the closing step re-opens the consent
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
 * Fail-closed by construction: only the choices step's Continue sends anything. The X and Escape close without sending, so an unanswered ask
 * changes nothing and reappears on the next open. Clicks on the office around
 * the bubble are deliberately inert — the consent step is a decision surface,
 * and a stray click must not read as an answer.
 */
export function IntroBubble({
  officeState,
  hooksAsk,
  mcpAsk,
  onMcpChoice,
  containerRef,
  zoom,
  panRef,
  installFailed,
  installPending,
  onChoice,
  onClose,
  escapeSuppressed,
  tutorial,
}: IntroBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [chosenStep, setStep] = useState<StepId>(
    hooksAsk ? 'welcome' : mcpAsk ? 'choices' : 'tutorial',
  );

  // The usage bridge's install state (usageBridgeStatus), undefined until the
  // server says — and forever on a host that has none. Decides whether the
  // choices offer the usage bars box. Its install is pending until a NEWER
  // status arrives (the server answers every request, success or not).
  const usage = useUsageBridge();
  const usageBridge = usage.status;
  const usagePending = usage.pending;

  // The usage bars box, decided ONCE from the first usageBridgeStatus: offered
  // when the bridge can be installed and isn't yet, and then kept for the whole
  // tour (installing it from the step must not make the box vanish under Back).
  // The status can land after the tour mounts (VS Code sends it after the hooks
  // ask); the user is still on an earlier step then.
  const [offerUsage, setOfferUsage] = useState<boolean | null>(null);
  useEffect(() => {
    if (offerUsage === null && usageBridge) setOfferUsage(!usageBridge.installed);
  }, [offerUsage, usageBridge]);
  // The tutorial, offered on the closing step while the server can start one —
  // and kept once its start is sent (the start makes it unavailable).
  const [tutorialStartSent, setTutorialStartSent] = useState(false);
  const offerTutorial = tutorialOffered(tutorial.status) || tutorialStartSent;
  const startTutorial = (): void => {
    setTutorialStartSent(true);
    tutorial.onStart(palette);
  };
  // The sign-in step: asked of the server as the tour opens, and part of the
  // tour from the first answer that says the CLI holds no login (kept once
  // shown, so Back finds it).
  const signIn = useCliSignIn(hooksAsk?.providerId);
  const checkSignIn = signIn.check;
  useEffect(() => {
    if (hooksAsk) checkSignIn();
  }, [hooksAsk, checkSignIn]);
  // Signed out for certain: a CLI that is there and reports no login. A missing
  // CLI has nothing to sign in (the install step covers it, and asks again).
  const signedOut =
    hooksAsk !== null && signIn.status?.signedIn === false && !signIn.status.cliMissing;
  // Continue was pressed on the install step and its fresh answer has not come.
  const [leavingInstall, setLeavingInstall] = useState(false);
  const signInShownRef = useRef(false);
  if (signedOut) signInShownRef.current = true;
  const signInShown = signInShownRef.current;
  const steps: StepId[] = hooksAsk
    ? [
        'welcome',
        ...(hooksAsk.cliInstalled ? [] : (['claudeCode'] as const)),
        ...(signInShown ? (['signIn'] as const) : []),
        'choices',
        'closing',
      ]
    : mcpAsk
      ? ['choices', 'closing']
      : ['tutorial'];

  // The choices step's boxes (all off to start; kept across Back, so a revision starts from them).
  const options: IntroChoiceOption[] = [
    ...(hooksAsk && offerUsage && usageBridge
      ? [
          {
            id: 'usage' as const,
            summary: usageBridge.summary,
            disclosure: usageBridge.disclosure,
            error: usageBridge.error,
          },
        ]
      : []),
    ...(hooksAsk
      ? [{ id: 'hooks' as const, summary: hooksAsk.summary, disclosure: hooksAsk.disclosure }]
      : []),
    ...(mcpAsk
      ? [{ id: 'mcp' as const, summary: mcpAsk.summary, disclosure: mcpAsk.disclosure }]
      : []),
  ].map((o) => ({ ...o, label: CHOICE_LABELS[o.id] }));
  const [choices, setChoices] = useState<Record<IntroChoiceId, boolean>>({
    usage: false,
    hooks: false,
    mcp: false,
  });
  // Continue was pressed and its answers have not all settled: the step holds.
  const [applying, setApplying] = useState(false);
  // The usage bars this tour turned on (a revision turns only those back off).
  const usageByTour = useRef(false);
  const applyChoices = (): void => {
    setApplying(true);
    if (hooksAsk) onChoice(choices.hooks ? 'install' : 'never');
    if (mcpAsk) onMcpChoice(choices.mcp ? 'allow' : 'decline');
    if (options.some((o) => o.id === 'usage')) {
      if (choices.usage && !usageBridge?.installed) {
        usageByTour.current = true;
        usage.setEnabled(true);
      } else if (!choices.usage && usageBridge?.installed && usageByTour.current) {
        usageByTour.current = false;
        usage.setEnabled(false);
      }
    }
  };
  // A step the tour no longer has (an ask mooted under it) falls back to the first.
  const wanted = steps.includes(chosenStep) ? chosenStep : steps[0];
  // The choices never open over a CLI that reports no login: back to the sign-in.
  const step = signedOut && steps.indexOf(wanted) > steps.indexOf('signIn') ? 'signIn' : wanted;
  const stepIndex = steps.indexOf(step);

  // Leaving for the choices waits for the server's word on the sign-in: its
  // first answer, and a fresh one after the install step (the CLI may be
  // there now). The answer decides whether the sign-in step comes first.
  const awaitingSignIn =
    hooksAsk !== null && (signIn.status === undefined || signIn.pending || leavingInstall);
  const leaveInstallStep = (): void => {
    setLeavingInstall(true);
    signIn.check();
  };
  const signInPending = signIn.pending;
  useEffect(() => {
    if (!leavingInstall || signInPending) return;
    setLeavingInstall(false);
    setStep(steps[Math.min(steps.length - 1, stepIndex + 1)]);
    // Runs on the answer's arrival; `steps` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leavingInstall, signInPending]);

  // The greeter lives exactly as long as this component, wearing Byte (by id: see greeterPalette).
  useEffect(() => {
    officeState.spawnGreeter();
    return () => officeState.despawnGreeter();
  }, [officeState]);
  // Dressed after the spawn above (effects run in order), and again whenever
  // the cast arrives or changes while the Intro is up.
  const cast = useCast();
  const palette = greeterPalette(cast.profiles);
  const greeterName = cast.profiles[palette]?.name ?? 'Byte';
  useEffect(() => {
    officeState.setGreeterPalette(palette);
  }, [officeState, palette]);

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
      const ch = officeState.greeterAnchor();
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

  // Every answer settled: on to the closing step — unless the usage bars were
  // asked for and didn't install, so the step stays to say why.
  const choicesPending = installPending || usagePending;
  useEffect(() => {
    if (!applying || choicesPending) return;
    setApplying(false);
    const usageFailed = choices.usage && usageByTour.current && !usageBridge?.installed;
    if (!usageFailed) setStep('closing');
  }, [applying, choicesPending, choices.usage, usageBridge]);

  const el = containerRef.current;
  if (!el) return null;

  // The greeter, or the tutorial's agent that took its place (it sat for the Guide).
  const greeter = officeState.greeterAnchor();
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

  const back = (): void => setStep(steps[Math.max(0, stepIndex - 1)]);
  const forward = (): void => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)]);
  const titles: Record<StepId, string> = {
    welcome: 'Welcome to Pixel Agents!',
    claudeCode: 'First, get Claude Code',
    signIn: 'Sign in to Claude Code',
    choices: 'Pick what to turn on',
    closing: installFailed ? "Hooks couldn't be installed" : "You're all set!",
    tutorial: tutorial.status?.headline ?? '',
  };

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

        {/* Step dots: the tour's "1 of 5", drawn as pixels rather than prose. */}
        <div className="flex gap-4 mb-8" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
          {steps.map((id) => (
            <div
              key={id}
              aria-hidden
              className={`w-6 h-6 ${id === step ? 'bg-accent' : 'bg-btn-bg'}`}
            />
          ))}
        </div>

        {step === 'tutorial' && tutorial.status ? (
          <TutorialAsk
            status={tutorial.status}
            rejected={tutorial.rejected}
            embedded={false}
            onClose={onClose}
            onStart={startTutorial}
          />
        ) : (
          <>
            <div className="text-xl mb-8 text-accent-bright pr-20">{titles[step]}</div>

            {step === 'welcome' && (
              <p className="text-sm m-0 mb-8">
                Hi, I&apos;m {greeterName}. In this office, your AI agents become tiny pixel
                characters: they type at their desks while they work, wander off when they&apos;re
                done, and speak up when they need you.
              </p>
            )}

            {step === 'claudeCode' && (
              <>
                <p className="text-sm m-0 mb-8">
                  The office brings your Claude Code sessions to life, but I couldn&apos;t find
                  Claude Code on this computer. Install it first:
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

            {step === 'closing' && (
              <>
                {hooksAsk && installFailed ? (
                  <p className="text-sm m-0 mb-8">
                    Something went wrong writing to your Claude Code settings, so the office will
                    watch your sessions the slower way instead. No worries, everything still works
                    and you can retry activating them any time from Settings.
                  </p>
                ) : null}
                {!offerTutorial && (
                  <p className="text-sm m-0 mb-8">
                    Enjoy your new office! Questions, ideas, or pixel art to show off? Come hang out
                    in our Discord.
                  </p>
                )}
                <p
                  className={`text-base m-0 ${offerTutorial ? 'mb-10' : 'text-center mt-12 mb-12'}`}
                >
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

            {/* The tutorial's ask closes the Intro's last step, with its own buttons. */}
            {step === 'closing' && offerTutorial && tutorial.status ? (
              <TutorialAsk
                status={tutorial.status}
                rejected={tutorial.rejected}
                embedded
                onBack={back}
                onClose={onClose}
                onStart={startTutorial}
              />
            ) : step === 'signIn' ? (
              <IntroSignIn
                signIn={signIn}
                onBack={stepIndex > 0 ? back : undefined}
                onContinue={forward}
              />
            ) : step === 'choices' ? (
              <IntroChoices
                options={options}
                values={choices}
                onToggle={(id) => setChoices((c) => ({ ...c, [id]: !c[id] }))}
                pending={applying}
                warnAllOff={hooksAsk !== null}
                onBack={stepIndex > 0 ? back : undefined}
                onContinue={applyChoices}
              />
            ) : (
              <div className="flex items-center justify-between gap-6 mt-10 flex-wrap">
                {/* Left slot: Back everywhere it can go back; a spacer on the opening
              step keeps the right-side buttons in place. */}
                {stepIndex === 0 ? (
                  <span />
                ) : (
                  <Button variant="ghost" size="sm" onClick={back}>
                    Back
                  </Button>
                )}

                {step === 'closing' ? (
                  <Button variant="accent" size="sm" onClick={onClose}>
                    Let's Go
                  </Button>
                ) : (
                  <Button
                    variant={awaitingSignIn ? 'disabled' : 'default'}
                    size="sm"
                    disabled={awaitingSignIn}
                    onClick={step === 'claudeCode' ? leaveInstallStep : forward}
                  >
                    Continue
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
