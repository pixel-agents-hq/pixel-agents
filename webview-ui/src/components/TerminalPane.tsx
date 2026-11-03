import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';

import {
  MOBILE_PASTE_PROMPT,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from '../constants.js';
import { readClipboardText } from '../terminal/clipboard.js';
import { attachClipboardInput } from '../terminal/clipboardInput.js';
import { terminalLinkProvider } from '../terminal/linkProvider.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import { TerminalConnection } from '../terminal/terminalClient.js';
import { isTypingInTerminal } from '../terminal/terminalDom.js';
import { terminalLinkOpener } from '../terminal/terminalLinks.js';
import { attachTouchInput } from '../terminal/touchInput.js';

interface TerminalPaneProps {
  agentId: number;
  /** Whether this pane is the one shown (hidden ones are display:none). */
  isActive: boolean;
  onStatusChange?: (agentId: number, status: TerminalConnectionStatus | null) => void;
  /** Override the terminal font size (mobile uses a smaller face for columns). */
  fontSizePx?: number;
  /** Focus xterm when the pane opens/activates. Mobile passes false: focusing
   *  raises the software keyboard over half the screen on every view switch —
   *  there, tapping the terminal itself is what summons the keyboard. */
  autoFocus?: boolean;
  /** Hands the caller this pane's input handle (null on teardown) — how the
   *  mobile key bar injects keys the software keyboard doesn't have. */
  onRegisterInput?: (agentId: number, handle: TerminalInputHandle | null) => void;
}

/** Ways to feed input into a pane's PTY from outside the terminal itself. */
export interface TerminalInputHandle {
  /** Write raw bytes (key sequences) straight to the PTY. */
  send: (data: string) => void;
  /** Columns in the terminal's line (the arrow trackpad's full sweep). */
  cols: () => number;
}

/**
 * One xterm.js instance bound to one agent's PTY.
 *
 * xterm is imperative and owns its own DOM, so it lives outside React state and
 * is driven entirely through refs — the same pattern OfficeCanvas uses for the
 * game loop.
 */
export function TerminalPane({
  agentId,
  isActive,
  onStatusChange,
  fontSizePx = TERMINAL_FONT_SIZE_PX,
  autoFocus = true,
  onRegisterInput,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Keep the latest callback reachable without making it an effect dependency:
  // a caller passing an inline arrow would otherwise tear down the terminal and
  // reconnect the socket on every parent render.
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const registerInputRef = useRef(onRegisterInput);
  registerInputRef.current = onRegisterInput;
  // Read only when the terminal first opens — as a dependency, flipping it
  // would dispose the terminal and reconnect the socket for nothing.
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const openLink = terminalLinkOpener(window.open.bind(window));
    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: fontSizePx,
      theme: { ...TERMINAL_THEME },
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: true,
      // OSC 8 hyperlinks. Without this xterm's built-in activator opens any
      // scheme behind a confirm(); see terminalLinkOpener.
      linkHandler: { activate: openLink },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Plain URLs printed as text (most of what an agent prints) become
    // clickable, whole even where Claude Code broke one across rows: the
    // same lookup a tap uses (terminalLinks.ts).
    term.registerLinkProvider(terminalLinkProvider(term, openLink));
    termRef.current = term;
    fitRef.current = fit;

    const connection = new TerminalConnection(agentId, {
      onOutput: (data) => term.write(data),
      onReplay: (data, cols, rows) => {
        // Reproduce the server's screen exactly: size the terminal to the
        // geometry the snapshot was serialized at, then write it after an
        // in-band full reset (RIS). RIS rather than term.reset() so the clear
        // is ordered within xterm's async write queue and works before open();
        // resize-first so the snapshot lays out at its own geometry. The fit
        // then reconciles with the actual container — if that's a real change,
        // the PTY gets a SIGWINCH and the TUI repaints itself.
        term.resize(cols, rows);
        term.write(`\x1bc${data}`);
        scheduleFit();
      },
      onExit: (exitCode) => {
        term.write(`\r\n\x1b[90m[process exited with code ${String(exitCode)}]\x1b[0m\r\n`);
      },
      onStatusChange: (status) => statusRef.current?.(agentId, status),
    });
    void connection.connect();

    term.onData((data) => connection.write(data));
    // Keyboard copy (verbatim; Alt+C = copy as text) and paste, OSC 52 writes.
    const detachClipboard = attachClipboardInput(term, {
      isActive: () => isActiveRef.current,
    });
    registerInputRef.current?.(agentId, {
      send: (data) => connection.write(data),
      cols: () => term.cols,
    });

    // Touch: scroll + flick, tap to focus / open a URL, long-press selection
    // with handles and a copy pill, or Paste in the input area (see
    // touchGesture.ts for the why).
    const detachTouch = attachTouchInput(term, host, {
      openLink,
      fallbackRowHeightPx: fontSizePx,
      // Read inside the pill's click, which keeps the user activation iOS
      // requires; Safari may still show its paste callout the first time. A
      // no-op when that is dismissed (or the plain-http prompt) or the
      // clipboard is empty. Pasted through xterm, not written to the PTY:
      // xterm wraps it in bracketed-paste markers when the running app has
      // turned that mode on — Claude Code has, and without the markers a
      // multiline paste would submit at its first newline.
      onPaste: () => {
        void readClipboardText(MOBILE_PASTE_PROMPT).then((text) => {
          if (text) term.paste(text);
        });
      },
    });

    // Debounced: ResizeObserver fires per frame during a drag, and every resize
    // is a syscall on the PTY plus a full TUI repaint.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let verifyFrame: number | null = null;
    const applyFit = () => {
      // A hidden pane has zero dimensions; fit() would compute a nonsense size
      // and resize the PTY to it.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      // Deferred open: xterm measures its cell grid the moment open() runs,
      // and this pane mounts inside a display:none panel (App only flips the
      // drawer open in an effect that runs after ours). Measuring while
      // hidden records garbage cell metrics that poison the first visible
      // fit() — the terminal squeezed into a ~10-column strip until the user
      // jiggles the container. Opening on the first fit that sees real
      // dimensions measures against real layout instead. Output that arrived
      // before open (the scrollback replay) is buffered by xterm and flushed
      // here.
      if (!term.element) {
        term.open(host);
        if (autoFocusRef.current) term.focus();
      }
      try {
        fit.fit();
        connection.resize(term.cols, term.rows);
      } catch {
        // fit() throws if the element is mid-teardown; the next tick recovers.
      }
      // Self-heal: one frame later, if the grid no longer matches what the
      // host's dimensions call for (metrics re-measured, layout shifted under
      // us), fit again rather than waiting for a user resize. Converges: fit()
      // applies exactly the proposal, so a stable layout passes this check on
      // the next pass and stops rescheduling.
      if (verifyFrame !== null) cancelAnimationFrame(verifyFrame);
      verifyFrame = requestAnimationFrame(() => {
        verifyFrame = null;
        const proposed = fit.proposeDimensions();
        if (proposed && (proposed.cols !== term.cols || proposed.rows !== term.rows)) {
          applyFit();
        }
      });
    };
    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyFit, TERMINAL_RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    applyFit();

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      if (verifyFrame !== null) cancelAnimationFrame(verifyFrame);
      detachTouch();
      detachClipboard();
      observer.disconnect();
      registerInputRef.current?.(agentId, null);
      // dispose() reports nothing, so a pane torn down mid-reconnect would
      // otherwise leave its card flagged red.
      statusRef.current?.(agentId, null);
      connection.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId, fontSizePx]);

  // Becoming visible: the pane had no dimensions while hidden, so re-fit and
  // focus now that it does.
  useEffect(() => {
    if (!isActive) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Not laid out yet; the ResizeObserver will catch up.
      }
      // The terminal opens lazily on its first visible fit (see the mount
      // effect), so it may not be attached yet — that first fit also focuses.
      //
      // Beyond autoFocus: if the user was typing in ANOTHER pane's terminal
      // when this one became active (mobile: card tap while the keyboard is
      // up), steal the focus. Moving focus input-to-input keeps the iOS
      // keyboard open, where blur-then-nothing would dismiss it.
      const active = document.activeElement;
      const typingInOtherTerminal =
        isTypingInTerminal(active) && !hostRef.current?.contains(active);
      if ((autoFocus || typingInOtherTerminal) && termRef.current?.element) {
        termRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, autoFocus]);

  return (
    // touch-none: no native pan may ever start on the terminal — with the iOS
    // keyboard up a vertical drag pans the whole page (overflow:hidden does
    // not apply to viewport panning), and once Safari claims the gesture the
    // touchmove preventDefault (touchGesture.ts) arrives too late. All touch
    // scrolling here is synthesized into wheel events instead.
    <div
      ref={hostRef}
      className="relative overflow-hidden w-full h-full touch-none"
      style={
        {
          display: isActive ? '' : 'none',
          // Consumed by the `.xterm, .xterm *` rule in index.css to beat the
          // global `* { font-pixel }` base rule. Fed from the same constant
          // xterm measures its cell grid with, so CSS can't drift from metrics.
          '--font-terminal': TERMINAL_FONT_FAMILY,
        } as CSSProperties
      }
    />
  );
}
