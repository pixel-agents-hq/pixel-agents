import type { ReactNode } from 'react';
import { useCallback, useRef } from 'react';

import { MobileAgentBar } from '../components/MobileAgentBar.js';
import { MobileKeyBar } from '../components/MobileKeyBar.js';
import { MobileTerminalPage } from '../components/MobileTerminalPage.js';
import type { TerminalInputHandle } from '../components/TerminalPane.js';
import { Button } from '../components/ui/Button.js';
import type { TerminalDrawerController } from '../hooks/useTerminalDrawer.js';
import { TRACK_TRANSITION, trackTransform, useEdgeSwipe } from './useEdgeSwipe.js';
import type { MobileShellController } from './useMobileShell.js';

interface MobileShellProps {
  /** The office region App builds for both shells. */
  office: ReactNode;
  shell: MobileShellController;
  drawer: TerminalDrawerController;
  /** Every top-level office agent, for the card bar. */
  agentIds: number[];
  terminalAgentIds: number[];
  focusedAgentId: number | null;
  terminalAvailable: boolean;
  terminalUnavailableReason: string | null;
  onCloseAgent: (agentId: number) => void;
  /** The software keyboard is up (App clamps the shell to the visual viewport). */
  keyboardOpen: boolean;
}

/**
 * The phone layout: office and terminal as full-screen pages in a sliding
 * track, the agent cards in a bottom scroller, and the accessory key bar
 * above the software keyboard. Crossing the breakpoint (rotation, window
 * resize) remounts the terminal panes; their sockets reconnect and the
 * server replays the current screen.
 */
export function MobileShell({
  office,
  shell,
  drawer,
  agentIds,
  terminalAgentIds,
  focusedAgentId,
  terminalAvailable,
  terminalUnavailableReason,
  onCloseAgent,
  keyboardOpen,
}: MobileShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  useEdgeSwipe(
    shellRef,
    trackRef,
    shell.view === 'terminal' ? 'office' : terminalAvailable ? 'terminal' : null,
    shell.toggleView,
  );

  const inputRef = useRef<TerminalInputHandle>(null);
  const handleKey = useCallback((sequence: string) => inputRef.current?.send(sequence), []);
  const handlePaste = useCallback(() => {
    // Silently a no-op when the user dismisses Safari's paste-permission
    // callout or the clipboard is empty.
    navigator.clipboard.readText().then(
      (text) => {
        if (text) inputRef.current?.paste(text);
      },
      () => undefined,
    );
  }, []);

  return (
    <>
      {/* touch-none: drags on the track (canvas margins, safe-area strip,
          terminal padding) must never start an iOS page pan — with the
          keyboard up Safari pans the layout viewport on any vertical drag
          it gets to claim, making the whole app jump. The canvas and the
          terminal panes run their own touch handling; the card bar below
          is a sibling, so its horizontal scroll is unaffected. */}
      <div ref={shellRef} className="relative flex-1 min-h-0 overflow-hidden touch-none">
        {/* Sliding track: office and terminal side by side at 200% width;
            selecting a terminal slides one viewport-width left. Both pages
            keep real layout at all times (never display:none), so the
            canvas ResizeObserver and xterm's fit always see dimensions. */}
        <div
          ref={trackRef}
          className="absolute top-0 bottom-0 left-0 flex w-[200%]"
          style={{ transform: trackTransform(shell.view), transition: TRACK_TRANSITION }}
        >
          <div className="w-1/2 h-full relative overflow-hidden">{office}</div>
          <div className="w-1/2 h-full">
            <MobileTerminalPage
              agentIds={terminalAgentIds}
              shownAgentId={drawer.shownAgentId}
              onStatusChange={drawer.onStatusChange}
              inputRef={inputRef}
            />
          </div>
        </div>

        {/* View toggle — pinned outside the track so it never slides. */}
        {terminalAvailable && (
          <div className="absolute mobile-safe-top right-8 z-40">
            <Button
              size="sm"
              className="border-border! shadow-pixel"
              onClick={shell.toggleView}
              title={shell.view === 'office' ? 'Show terminal' : 'Show office'}
            >
              {shell.view === 'office' ? '>_' : 'Office'}
            </Button>
          </div>
        )}
      </div>

      <MobileAgentBar
        agentIds={agentIds}
        focusedAgentId={focusedAgentId}
        // The accent border marks the showing pane, so it only exists on the
        // terminal page; the focused character keeps its tint on both.
        activeAgentId={shell.view === 'terminal' ? drawer.activeAgentId : null}
        onSelectAgent={shell.selectCard}
        onCloseAgent={onCloseAgent}
        onLaunch={shell.launch}
        canLaunch={terminalAvailable}
        launchUnavailableReason={terminalUnavailableReason}
        getAppearance={drawer.getAppearance}
        statusFor={drawer.statusFor}
      />

      {/* Accessory keys for the TUI, only while the software keyboard is up —
          the last flex child, so it sits directly above the keyboard. */}
      {shell.view === 'terminal' && keyboardOpen && (
        <MobileKeyBar onKey={handleKey} onPaste={handlePaste} />
      )}
    </>
  );
}
