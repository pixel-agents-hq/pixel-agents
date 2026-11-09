import type { Ref } from 'react';

import { MOBILE_TERMINAL_FONT_SIZE_PX } from '../constants.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import type { TerminalInputHandle } from './TerminalPane.js';
import { TerminalPaneStack } from './TerminalPaneStack.js';

interface MobileTerminalPageProps {
  /** Agent ids with a live PTY, in open order. */
  agentIds: number[];
  /** The pane to show (useTerminalDrawer's resolution). */
  shownAgentId: number | null;
  onStatusChange: (agentId: number, status: TerminalConnectionStatus) => void;
  /** Input into the shown pane, for the key bar. */
  inputRef: Ref<TerminalInputHandle>;
}

/**
 * The mobile shell's terminal page — the full-screen pane the office slides
 * away to reveal. One TerminalPane per launched agent, all mounted (buffers
 * and sockets survive switches, same as the desktop drawer), only the shown
 * one visible.
 *
 * autoFocus is off: on a phone, focusing xterm summons the software keyboard
 * over half the viewport, so the keyboard should only appear when the user
 * taps the terminal to type. The page always has layout (it sits off-screen
 * in the sliding track, not display:none), so xterm can open and fit before
 * it is ever revealed.
 */
export function MobileTerminalPage({
  agentIds,
  shownAgentId,
  onStatusChange,
  inputRef,
}: MobileTerminalPageProps) {
  return (
    <div className="relative w-full h-full bg-bg-dark">
      {agentIds.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 px-16 text-center">
          <span className="text-lg text-text">No agent terminals yet</span>
          <span className="text-sm text-text-muted">Tap + in the bar below to launch one</span>
        </div>
      )}
      <TerminalPaneStack
        agentIds={agentIds}
        shownAgentId={shownAgentId}
        onStatusChange={onStatusChange}
        paneClassName="left-4 right-4 bottom-4 mobile-safe-pane-top"
        fontSizePx={MOBILE_TERMINAL_FONT_SIZE_PX}
        autoFocus={false}
        inputRef={inputRef}
      />
    </div>
  );
}
