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
  INTRO_FAREWELL_LINGER_MS,
  INTRO_SPEAKER_HEIGHT_PX,
  INTRO_SPEAKER_MUG_ZOOM,
} from '../constants.js';
import type { ConsentChoice } from '../hooks/introTourState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { useCliSignIn } from '../signIn/useCliSignIn.js';
import { TutorialAsk } from '../tutorial/TutorialAsk.js';
import { tutorialOffered } from '../tutorial/tutorialOffer.js';
import { useUsageBridge } from '../usage/useUsageBridge.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { type IntroChoiceId, type IntroChoiceOption, IntroChoices } from './IntroChoices.js';
import { dialogLetterBudget, dialogMessages, introCameraTarget } from './introDialogRules.js';
import { IntroDiscordOption, IntroOption, IntroOptions, IntroPanel } from './IntroOptions.js';
import { IntroBelowSlot, IntroOptionsSlot } from './introOptionsSlot.js';
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
  /** Every way the tour ends: Let's Go, the tutorial's start, or, for the
   *  tutorial's ask alone, Not Now and Escape (the first-run tour has no
   *  close of its own). Sends NOTHING by
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
  /** Settings → Replay the Intro: what is on now, the choices' boxes as they
   *  start (a first run starts them all off). The usage bars box is offered
   *  whether or not the bars are on, and unticking it turns them off. */
  replay?: Record<IntroChoiceId, boolean>;
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
 * step's controls are its menu, above the dialog and shown once the step's
 * last message is out: its options stacked in one box at the right edge
 * (IntroOptions), or, where the step shows something over the dialog (the
 * choices' cards in a row, the sign-in's code bar), in the dialog box under
 * the words. Back is the box's own, at its foot: the message
 * before, then the step before.
 * The menus that know what to say (IntroSignIn, TutorialAsk) hand their lines
 * up through `say`. Mounting spawns the greeter; EVERY close path — Let's Go, the tutorial's start, or a hooksStatus that moots an unanswered ask — unmounts
 * this component, and the unmount despawns the greeter, so the two can never
 * disagree.
 *
 * Fail-closed by construction: only the choices step's Continue sends anything. The tour has no close of its own (no x, no Escape), and a reload sends nothing, so an unanswered ask
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
  replay,
}: IntroDialogProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  // The foot of the dialog box, where a step's inline options are drawn.
  const [optionsSlot, setOptionsSlot] = useState<HTMLDivElement | null>(null);
  // Under the dialog box: where a step's error is said.
  const [belowSlot, setBelowSlot] = useState<HTMLDivElement | null>(null);
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
    if (offerUsage === null && usageBridge) setOfferUsage(!usageBridge.installed || !!replay);
  }, [offerUsage, usageBridge, replay]);
  // The tutorial, offered on the closing step while the server can start one —
  // and kept once its start is sent (the start makes it unavailable).
  const [tutorialStartSent, setTutorialStartSent] = useState(false);
  const offerTutorial = tutorialOffered(tutorial.status) || tutorialStartSent;
  // A start under way: the dialog goes at once on the yes (the greeter walks
  // to its seat on its own; this component stays mounted, since the greeter
  // lives with it), and comes back only to say a start was refused.
  const [startSeq, setStartSeq] = useState<number | null>(null);
  const startUnderWay = startSeq !== null && (tutorial.rejected?.seq ?? 0) === startSeq;
  const startTutorial = (): void => {
    setTutorialStartSent(true);
    setStartSeq(tutorial.rejected?.seq ?? 0);
    tutorial.onStart(palette);
  };
  // Let's Go was pressed: the greeter says goodbye, then the tour ends.
  const [farewell, setFarewell] = useState(false);
  // The closing step's Discord invite was read on from: the tutorial's ask is up.
  const [invited, setInvited] = useState(false);
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
    // Not for an account with no plan limits (an API account): its bars would stay empty.
    ...(hooksAsk && offerUsage && usageBridge && signIn.status?.planLimits !== false
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
  const [choices, setChoices] = useState<Record<IntroChoiceId, boolean>>(
    replay ?? { usage: false, hooks: false, mcp: false },
  );
  // Continue was pressed and its answers have not all settled: the step holds.
  const [applying, setApplying] = useState(false);
  // The usage bars this tour turned on (a revision turns only those back off).
  // (A replay owns the bars that were on: unticking them there means off.)
  const usageByTour = useRef(replay?.usage === true);
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

  // The first-run tour cannot be closed: it ends on Let's Go (or the
  // tutorial's start). Only the tutorial's ask opened from Settings, which
  // has Not Now, also closes on Escape.
  const closable = !hooksAsk && !mcpAsk;
  useEffect(() => {
    if (escapeSuppressed || !closable) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, escapeSuppressed, closable]);

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
              coveredHeight:
                INTRO_DIALOG_BOTTOM_PX + INTRO_DIALOG_CAMERA_BOX_PX + INTRO_SPEAKER_HEIGHT_PX,
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

  // The closing step's second part: the invite read, the tutorial's ask up.
  const asking = step === 'closing' && invited && offerTutorial && !!tutorial.status;

  const titles: Record<StepId, string> = {
    welcome: 'Welcome to Pixel Agents!',
    claudeCode: 'First, get Claude Code',
    signIn: 'Sign in to Claude Code',
    choices: 'Pick what to turn on',
    closing: installFailed ? "Hooks couldn't be installed" : "You're all set!",
    tutorial: tutorial.status?.headline ?? '',
  };
  // The greeter's lines for the step, each cut to the box below.
  const lines: readonly string[] = farewell
    ? ['Enjoy your new office!']
    : step === 'welcome'
      ? [
          `Hi, I'm ${greeterName}. Welcome to Pixel Agents!`,
          'In this office, your AI agents become tiny pixel characters.',
          "They type at their desks while they work, wander off when they're done, and speak up when they need you.",
        ]
      : step === 'claudeCode'
        ? [
            "We currently only support Claude Code, and I couldn't find it installed on this computer. Install it with this command, then press Continue.",
          ]
        : step === 'choices'
          ? ['Pick what to turn on. You can change any of these later in Settings.']
          : step === 'closing' && !asking
            ? [
                ...(installFailed
                  ? [
                      "I'm sorry, for some reason hooks couldn't be installed.",
                      'The office will watch your sessions the slower way instead. Everything still works, and you can retry any time from Settings!',
                    ]
                  : ["You're all set!"]),
                'Questions, ideas, or pixel art to show off? Come hang out in our Discord.',
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
  // A message gone back to is shown whole, until the user reads on.
  const [shownWhole, setShownWhole] = useState(false);
  const [typed, setTyped] = useState({ text: '', letters: 0 });
  if (typed.text !== text) {
    setTyped({ text, letters: landLast || shownWhole || instant ? text.length : 0 });
  }
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

  // Back, at the box's foot: the message before this one, shown
  // whole; from a step's first, the step before, on its last (where its menu
  // is). A sign-in step that has nothing left to ask is passed over. Not
  // offered while something sent is still settling.
  const before = stepIndex - 1;
  const stepBefore =
    steps[
      before === steps.indexOf('signIn') && signIn.status?.signedIn === true ? before - 1 : before
    ];
  const canGoBack =
    (page > 0 || asking || stepBefore !== undefined) &&
    !applying &&
    !tutorialStartSent &&
    !leavingInstall &&
    !farewell;
  const back = (): void => {
    setShownWhole(true);
    if (page > 0) setPlace({ key: speechKey, page: page - 1 });
    else if (asking) {
      // From the tutorial's ask: the invite, where its menu is.
      setBackTo(step);
      setInvited(false);
    } else if (stepBefore) {
      setBackTo(stepBefore);
      setStep(stepBefore);
    }
  };
  const forward = (): void => {
    setStep(steps[Math.min(steps.length - 1, stepIndex + 1)]);
  };

  // Every step but the welcome ends on a menu; the welcome's last message
  // goes on to the next step, and so does the sign-in's once it is signed in
  // ("On we go!").
  const hasMenu =
    step !== 'welcome' && !farewell && !(step === 'signIn' && signIn.status?.signedIn === true);
  const menuShown = hasMenu && messages.length > 0 && page === last && !typing;
  const canAdvance = typing || page < last || !hasMenu;
  const advance = (): void => {
    setBackTo(null);
    setShownWhole(false);
    if (typing) setTyped({ text, letters: text.length });
    else if (page < last) setPlace({ key: speechKey, page: page + 1 });
    else if (farewell) onClose();
    else if (!hasMenu && !awaitingSignIn) forward();
  };
  // The goodbye ends the tour by itself a moment after it is out.
  const farewellSaid = farewell && !typing && text !== '' && page === last;
  useEffect(() => {
    if (!farewellSaid) return;
    const id = setTimeout(onClose, INTRO_FAREWELL_LINGER_MS);
    return () => clearTimeout(id);
  }, [farewellSaid, onClose]);
  // Enter and Space advance like a press on the box, unless a control (or a
  // terminal) has the keyboard, or something is open over the dialog.
  const advanceRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    advanceRef.current = canAdvance && !startUnderWay ? advance : null;
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

  const discord = <IntroDiscordOption href={DISCORD_INVITE_URL} />;

  return (
    <div
      ref={stackRef}
      role="dialog"
      aria-label={titles[step]}
      // Nothing in the Intro is selected by a press (a click on the box goes on,
      // and double clicks would select the words); the install command keeps
      // its select-all, and fields their own selection.
      className="absolute flex flex-col items-end select-none"
      style={{
        left: '50%',
        transform: 'translateX(-50%)',
        display: startUnderWay ? 'none' : undefined,
        bottom: INTRO_DIALOG_BOTTOM_PX,
        width: boxWidth,
        maxHeight: `calc(100% - ${INTRO_DIALOG_BOTTOM_PX + INTRO_DIALOG_EDGE_MARGIN_PX}px)`,
        gap: INTRO_DIALOG_MENU_GAP_PX,
        zIndex: INTRO_DIALOG_Z_INDEX,
      }}
    >
      {/* The step's menu: mounted with the step (the sign-in asks the server,
          the tutorial's ask follows its run) and shown once the greeter has
          said the step's last message. Its options are a stack at the right
          edge (IntroOptions); the rest are panels above it. */}
      {step !== 'welcome' && (
        // Clear of the speaker over the box's top left while the menu holds a
        // panel (one spans the dialog's width); a stack of options alone, at
        // the right edge, sits right on the box (index.css .intro-menu-wrap).
        <div
          hidden={!menuShown}
          data-testid="intro-menu"
          className="intro-menu-wrap self-stretch min-h-0"
          style={{ ['--intro-speaker-h' as string]: `${INTRO_SPEAKER_HEIGHT_PX}px` }}
        >
          <IntroBelowSlot value={belowSlot}>
            <IntroOptionsSlot value={optionsSlot}>
              <div className="intro-menu" style={{ gap: INTRO_DIALOG_MENU_GAP_PX }}>
                {step === 'claudeCode' && (
                  <>
                    <IntroPanel>
                      <div className="text-sm bg-btn-bg border-2 border-border py-4 px-8 mb-8 select-all">
                        {CLAUDE_CODE_INSTALL_COMMAND}
                      </div>
                      <p className="text-sm m-0">
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
                    </IntroPanel>
                    <IntroOptions inline>
                      <IntroOption
                        kind="primary"
                        forward
                        disabled={awaitingSignIn}
                        onClick={leaveInstallStep}
                      >
                        Continue
                      </IntroOption>
                    </IntroOptions>
                  </>
                )}

                {step === 'signIn' && (
                  <IntroSignIn signIn={signIn} say={say} onContinue={forward} />
                )}

                {step === 'choices' && (
                  <IntroChoices
                    options={options}
                    values={choices}
                    onToggle={(id) => setChoices((c) => ({ ...c, [id]: !c[id] }))}
                    pending={applying}
                    warnAllOff={hooksAsk !== null}
                    onContinue={applyChoices}
                  />
                )}

                {/* The closing step ends on the Discord invite, a message of its
                  own; where the tutorial is offered, its ask follows. */}
                {step === 'closing' &&
                  (asking && tutorial.status ? (
                    <TutorialAsk
                      status={tutorial.status}
                      rejected={tutorial.rejected}
                      say={say}
                      onDecline={() => setFarewell(true)}
                      onClose={onClose}
                      onStart={startTutorial}
                    />
                  ) : (
                    <>
                      {/* The invite itself over the box, in the accent; the way
                          on in the box, as on the choices step. */}
                      <IntroOptions data-testid="intro-invite-menu">{discord}</IntroOptions>
                      <IntroOptions inline data-testid="intro-invite">
                        {offerTutorial ? (
                          <IntroOption
                            kind="primary"
                            forward
                            onClick={() => {
                              setBackTo(null);
                              setShownWhole(false);
                              setInvited(true);
                            }}
                          >
                            Continue
                          </IntroOption>
                        ) : (
                          <IntroOption kind="primary" forward onClick={() => setFarewell(true)}>
                            Let&apos;s Go
                          </IntroOption>
                        )}
                      </IntroOptions>
                    </>
                  ))}

                {step === 'tutorial' && tutorial.status && (
                  <TutorialAsk
                    status={tutorial.status}
                    rejected={tutorial.rejected}
                    say={say}
                    onDecline={onClose}
                    onClose={onClose}
                    onStart={startTutorial}
                  />
                )}
              </div>
            </IntroOptionsSlot>
          </IntroBelowSlot>
        </div>
      )}

      {/* The dialog box: the greeter's message, typed out. The untyped rest
          keeps its space, so the box never grows while a message types. */}
      <div
        data-testid="intro-dialog"
        className={`intro-dialog-box relative w-full shrink-0 pt-8 pb-6 px-14 ${canAdvance ? 'cursor-pointer' : ''}`}
        onClick={canAdvance ? advance : undefined}
      >
        {/* Who speaks, as a game's dialog names them: the greeter's face and
            name standing on the box's top border, at its left. */}
        <div
          data-testid="intro-dialog-name"
          className="intro-dialog-speaker"
          onClick={(e) => e.stopPropagation()}
        >
          <CharacterMugShot palette={palette} repeat={0} zoom={INTRO_SPEAKER_MUG_ZOOM} />
          <span className="intro-dialog-name">{greeterName}</span>
        </div>
        <p className="intro-dialog-text m-0" aria-live="polite" aria-label={text}>
          <span aria-hidden>
            {text.slice(0, letters)}
            <span className="invisible">{text.slice(letters)}</span>
          </span>
        </p>
        {/* The box's foot, always there so the box keeps its height: Back on
            the left, and on the right the step's options where its menu puts
            them in the box (IntroOptions `inline`), else the Next arrow. */}
        <div className="intro-dialog-foot">
          {canGoBack ? (
            <Button
              variant="ghost"
              size="sm"
              icon="prev"
              iconScale={1}
              className="h-40! py-0! pl-0! [&_svg]:translate-y-px"
              onClick={(e) => {
                // Back goes back; a press anywhere else on the box goes on.
                e.stopPropagation();
                back();
              }}
            >
              Back
            </Button>
          ) : (
            <span />
          )}
          <div
            ref={setOptionsSlot}
            hidden={!menuShown}
            className="intro-options-inline"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
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

      {/* Under the dialog box, in the space between it and the office's foot. */}
      <div
        ref={setBelowSlot}
        className="absolute top-full inset-x-0 flex items-center justify-center px-12 pointer-events-none"
        style={{ height: INTRO_DIALOG_BOTTOM_PX }}
      />
    </div>
  );
}
