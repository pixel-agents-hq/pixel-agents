import { useCallback, useEffect, useRef, useState } from 'react';

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
  INTRO_DIALOG_BOTTOM_PX,
  INTRO_DIALOG_CAMERA_BOX_PX,
  INTRO_DIALOG_EDGE_MARGIN_PX,
  INTRO_DIALOG_MAX_WIDTH_PX,
  INTRO_DIALOG_MENU_GAP_PX,
  INTRO_DIALOG_TYPE_MS,
  INTRO_DIALOG_Z_INDEX,
} from '../constants.js';
import type { ConsentChoice } from '../hooks/introTourState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { useCliSignIn } from '../signIn/useCliSignIn.js';
import { TutorialAsk } from '../tutorial/TutorialAsk.js';
import { tutorialOffered } from '../tutorial/tutorialOffer.js';
import { useUsageBridge } from '../usage/useUsageBridge.js';
import { DiscordIcon } from './ChangelogModal.js';
import { type IntroChoiceId, type IntroChoiceOption, IntroChoices } from './IntroChoices.js';
import { dialogLetterBudget, dialogMessages, introCameraTarget } from './introDialogRules.js';
import { IntroSignIn } from './IntroSignIn.js';
import { Button } from './ui/Button.js';

interface IntroDialogProps {
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
   *  (stacked ABOVE this dialog) or the layout editor's multi-stage Esc
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
 * Diegetic, in the manner of a game's dialog: a greeter character (char_0)
 * stands in the middle of the office, the camera sits on that spot from the
 * first frame and stays there whatever the dialog shows (a manual pan takes
 * it back; see OfficeState.cancelGreeterCamera), and its words appear in a box along the
 * office's foot, typed out letter by letter, one short message at a time
 * (introDialogRules.ts cuts them to the box's width). A press on the box, its
 * arrow, Enter or Space finishes the typing, then shows the next message. A
 * step's controls (its boxes, the sign-in, the buttons) are its menu: a
 * second box above the dialog, shown once the step's last message is out.
 * The menus that know what to say (IntroSignIn, TutorialAsk) hand their lines
 * up through `say`. Mounting spawns the greeter; EVERY close path — the X,
 * Escape, Let's Go, or a hooksStatus that moots an unanswered ask — unmounts
 * this component, and the unmount despawns the greeter, so the two can never
 * disagree.
 *
 * Fail-closed by construction: only the choices step's Continue sends anything. The X and Escape close without sending, so an unanswered ask
 * changes nothing and reappears on the next open. Clicks on the office around
 * the dialog are deliberately inert — the consent step is a decision surface,
 * and a stray click must not read as an answer.
 */
export function IntroDialog({
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
}: IntroDialogProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  // The office's width (the messages are cut to the box's) and whether the
  // greeter has finished appearing, both read off the frame tick below.
  const [officeWidth, setOfficeWidth] = useState(0);
  const [greeterReady, setGreeterReady] = useState(false);
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

  // Per-frame tick: feed the camera target. It is one fixed point (the spot
  // the greeter appears on, over the dialog box at its plain height), so the
  // camera is there before the greeter shows and never moves with a menu or
  // with the greeter's walk to a seat; ignored after a manual pan
  // (cancelGreeterCamera).
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const ch = officeState.greeterAnchor();
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        setOfficeWidth(rect.width);
        const home = officeState.greeterHome;
        if (ch && home) {
          officeState.setGreeterCameraTarget(
            introCameraTarget({
              layout: officeState.getLayout(),
              containerRect: rect,
              zoom,
              pan: panRef.current,
              dpr: window.devicePixelRatio || 1,
              greeter: home,
              coveredHeight: INTRO_DIALOG_BOTTOM_PX + INTRO_DIALOG_CAMERA_BOX_PX,
            }),
          );
        }
      }
      // Let the materialization effect finish before the greeter "speaks".
      setGreeterReady(!ch || ch.matrixEffect !== 'spawn');
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

  // What the step's menu has the greeter say (IntroSignIn, TutorialAsk).
  const [menuSpeech, setMenuSpeech] = useState<{ step: StepId; lines: readonly string[] } | null>(
    null,
  );
  const say = useCallback((lines: readonly string[]) => setMenuSpeech({ step, lines }), [step]);
  const spoken = menuSpeech?.step === step ? menuSpeech.lines : [];

  const titles: Record<StepId, string> = {
    welcome: 'Welcome to Pixel Agents!',
    claudeCode: 'First, get Claude Code',
    signIn: 'Sign in to Claude Code',
    choices: 'Pick what to turn on',
    closing: installFailed ? "Hooks couldn't be installed" : "You're all set!",
    tutorial: tutorial.status?.headline ?? '',
  };
  // The greeter's lines for the step, each cut to the box below.
  const lines: readonly string[] =
    step === 'welcome'
      ? [
          `Hi, I'm ${greeterName}. Welcome to Pixel Agents!`,
          'In this office, your AI agents become tiny pixel characters.',
          "They type at their desks while they work, wander off when they're done, and speak up when they need you.",
        ]
      : step === 'claudeCode'
        ? [
            "First, get Claude Code: the office brings your Claude Code sessions to life, but I couldn't find it on this computer.",
            'Install it with this command, then press Continue.',
          ]
        : step === 'choices'
          ? ['Pick what to turn on. You can change any of these later in Settings.']
          : step === 'closing'
            ? [
                ...(installFailed
                  ? [
                      "Hooks couldn't be installed: something went wrong writing to your Claude Code settings.",
                      'The office will watch your sessions the slower way instead. Everything still works, and you can retry any time from Settings.',
                    ]
                  : ["You're all set!"]),
                ...(offerTutorial
                  ? spoken
                  : [
                      'Enjoy your new office! Questions, ideas, or pixel art to show off? Come hang out in our Discord.',
                    ]),
              ]
            : spoken;

  const boxWidth = Math.max(
    0,
    Math.min(INTRO_DIALOG_MAX_WIDTH_PX, officeWidth - 2 * INTRO_DIALOG_EDGE_MARGIN_PX),
  );
  const messages = dialogMessages(lines, dialogLetterBudget(boxWidth));
  const last = Math.max(0, messages.length - 1);

  // Which message is up. A step's lines (or the step) changing starts over at
  // the first; a step arrived at by Back opens on its last, where its menu
  // is, with nothing typed out again (until the user moves on from there).
  const speechKey = `${step}\n${lines.join('\n')}`;
  const [backTo, setBackTo] = useState<StepId | null>(null);
  const landLast = backTo === step;
  const [place, setPlace] = useState({ key: '', page: 0 });
  if (place.key !== speechKey) {
    setPlace({ key: speechKey, page: landLast ? Number.MAX_SAFE_INTEGER : 0 });
  }
  const page = Math.min(place.key === speechKey ? place.page : 0, last);
  const text = messages[page] ?? '';

  // The message types out, unless the user asked for less motion.
  const [instant] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const [typed, setTyped] = useState({ text: '', letters: 0 });
  if (typed.text !== text) setTyped({ text, letters: landLast || instant ? text.length : 0 });
  const letters = typed.text === text ? typed.letters : 0;
  const typing = letters < text.length;
  useEffect(() => {
    if (!typing || !greeterReady) return;
    const id = setTimeout(
      () => setTyped((t) => (t.text === text ? { text, letters: t.letters + 1 } : t)),
      INTRO_DIALOG_TYPE_MS,
    );
    return () => clearTimeout(id);
  }, [typing, letters, text, greeterReady]);

  const back = (): void => {
    const to = steps[Math.max(0, stepIndex - 1)];
    setBackTo(to);
    setStep(to);
  };
  const forward = (): void => {
    setStep(steps[Math.min(steps.length - 1, stepIndex + 1)]);
  };

  // Every step but the welcome ends on a menu; the welcome's last message
  // goes on to the next step.
  const hasMenu = step !== 'welcome';
  const menuShown = hasMenu && messages.length > 0 && page === last && !typing;
  const canAdvance = typing || page < last || !hasMenu;
  const advance = (): void => {
    setBackTo(null);
    if (typing) setTyped({ text, letters: text.length });
    else if (page < last) setPlace({ key: speechKey, page: page + 1 });
    else if (!hasMenu && !awaitingSignIn) forward();
  };
  // Enter and Space advance like a press on the box, unless a control (or a
  // terminal) has the keyboard, or something is open over the dialog.
  const advanceRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    advanceRef.current = canAdvance ? advance : null;
  });
  useEffect(() => {
    if (escapeSuppressed) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, button, a, [contenteditable], .xterm')
      ) {
        return;
      }
      if (!advanceRef.current) return;
      e.preventDefault();
      advanceRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [escapeSuppressed]);

  if (!greeterReady || boxWidth === 0) return null;

  return (
    <div
      ref={stackRef}
      role="dialog"
      aria-label={titles[step]}
      className="absolute flex flex-col items-end"
      style={{
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: INTRO_DIALOG_BOTTOM_PX,
        width: boxWidth,
        maxHeight: `calc(100% - ${INTRO_DIALOG_BOTTOM_PX + INTRO_DIALOG_EDGE_MARGIN_PX}px)`,
        gap: INTRO_DIALOG_MENU_GAP_PX,
        zIndex: INTRO_DIALOG_Z_INDEX,
      }}
    >
      {/* The step's menu: mounted with the step (the sign-in asks the server,
          the tutorial's ask follows its run) and shown once the greeter has
          said the step's last message. */}
      {hasMenu && (
        <div
          hidden={!menuShown}
          data-testid="intro-menu"
          className="intro-dialog-box max-w-full min-h-0 overflow-y-auto py-8 px-12 leading-[1.4]"
        >
          {step === 'claudeCode' && (
            <>
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
              <div className="flex items-center justify-between gap-6 mt-10 flex-wrap">
                {stepIndex === 0 ? (
                  <span />
                ) : (
                  <Button variant="ghost" size="sm" onClick={back}>
                    Back
                  </Button>
                )}
                <Button
                  variant={awaitingSignIn ? 'disabled' : 'default'}
                  size="sm"
                  disabled={awaitingSignIn}
                  onClick={leaveInstallStep}
                >
                  Continue
                </Button>
              </div>
            </>
          )}

          {step === 'signIn' && (
            <IntroSignIn
              signIn={signIn}
              say={say}
              onBack={stepIndex > 0 ? back : undefined}
              onContinue={forward}
            />
          )}

          {step === 'choices' && (
            <IntroChoices
              options={options}
              values={choices}
              onToggle={(id) => setChoices((c) => ({ ...c, [id]: !c[id] }))}
              pending={applying}
              warnAllOff={hooksAsk !== null}
              onBack={stepIndex > 0 ? back : undefined}
              onContinue={applyChoices}
            />
          )}

          {step === 'closing' && (
            <>
              <p className="text-base m-0 mb-10">
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
              {/* The tutorial's ask closes the Intro's last step, with its own buttons. */}
              {offerTutorial && tutorial.status ? (
                <TutorialAsk
                  status={tutorial.status}
                  rejected={tutorial.rejected}
                  embedded
                  say={say}
                  onBack={back}
                  onClose={onClose}
                  onStart={startTutorial}
                />
              ) : (
                <div className="flex items-center justify-between gap-6 mt-10 flex-wrap">
                  {stepIndex === 0 ? (
                    <span />
                  ) : (
                    <Button variant="ghost" size="sm" onClick={back}>
                      Back
                    </Button>
                  )}
                  <Button variant="accent" size="sm" onClick={onClose}>
                    Let's Go
                  </Button>
                </div>
              )}
            </>
          )}

          {step === 'tutorial' && tutorial.status && (
            <TutorialAsk
              status={tutorial.status}
              rejected={tutorial.rejected}
              embedded={false}
              say={say}
              onClose={onClose}
              onStart={startTutorial}
            />
          )}
        </div>
      )}

      {/* The dialog box: the greeter's message, typed out. The untyped rest
          keeps its space, so the box never grows while a message types. */}
      <div
        data-testid="intro-dialog"
        className={`intro-dialog-box relative w-full shrink-0 py-8 pl-14 pr-30 ${canAdvance ? 'cursor-pointer' : ''}`}
        onClick={canAdvance ? advance : undefined}
      >
        {/* Same close control as the Settings/changelog modals (ui/Modal.tsx):
            ghost icon button, plain lowercase x. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          className="absolute top-2 right-2"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          x
        </Button>
        <p className="intro-dialog-text m-0" aria-live="polite" aria-label={text}>
          <span aria-hidden>
            {text.slice(0, letters)}
            <span className="invisible">{text.slice(letters)}</span>
          </span>
        </p>
        {canAdvance && (
          <button
            type="button"
            aria-label="Next"
            className={`intro-dialog-next ${typing ? 'is-typing' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              advance();
            }}
          />
        )}
      </div>
    </div>
  );
}
