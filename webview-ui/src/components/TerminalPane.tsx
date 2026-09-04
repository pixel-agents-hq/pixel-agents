import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';

import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from '../constants.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import { TerminalConnection } from '../terminal/terminalClient.js';

interface TerminalPaneProps {
  agentId: number;
  /** Hidden panes stay mounted so their xterm buffer and socket survive tab
   *  switches — unmounting would drop the scrollback and force a reconnect. */
  isActive: boolean;
  onStatusChange?: (agentId: number, status: TerminalConnectionStatus) => void;
}

/**
 * One xterm.js instance bound to one agent's PTY.
 *
 * xterm is imperative and owns its own DOM, so it lives outside React state and
 * is driven entirely through refs — the same pattern OfficeCanvas uses for the
 * game loop.
 */
export function TerminalPane({ agentId, isActive, onStatusChange }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Keep the latest callback reachable without making it an effect dependency:
  // a caller passing an inline arrow would otherwise tear down the terminal and
  // reconnect the socket on every parent render.
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE_PX,
      theme: { ...TERMINAL_THEME },
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
        term.focus();
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
      observer.disconnect();
      connection.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId]);

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
      if (termRef.current?.element) termRef.current.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isActive]);

  return (
    <div
      ref={hostRef}
      className="w-full h-full"
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
