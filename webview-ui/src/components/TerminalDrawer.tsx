import type { MouseEvent as ReactMouseEvent } from 'react';

import { TERMINAL_DRAWER_RESIZE_HANDLE_PX } from '../constants.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCardBar } from './AgentCardBar.js';
import { TerminalPaneStack } from './TerminalPaneStack.js';
import { Button } from './ui/Button.js';

interface TerminalDrawerProps {
  /** Agent ids with a live PTY, in open order. */
  agentIds: number[];
  /** The pane showing (useTerminalDrawer's resolution); its card is the active tab. */
  shownAgentId: number | null;
  onSelectAgent: (agentId: number) => void;
  onCloseAgent: (agentId: number) => void;
  isOpen: boolean;
  /** Close the panel (the ">" in its top-right corner). Reopening happens in App:
   *  selecting an agent — by card or by character — shows its terminal. */
  onClosePanel: () => void;
  /** Open width in px (user-resizable). Ignored while collapsed. */
  widthPx: number;
  /** Mousedown on the left-edge drag handle; App owns the resize gesture. */
  onResizeStart: (e: ReactMouseEvent) => void;
  /** Look up an agent's character appearance for its tab mug shot. */
  getAppearance: (agentId: number) => AgentAppearance;
  /** An agent's tab status dot (null until first activity). */
  statusFor: (agentId: number) => TabStatus | null;
  onStatusChange: (agentId: number, status: TerminalConnectionStatus) => void;
}

/**
 * Right-docked panel hosting one xterm tab per launched agent.
 *
 * Standalone only — App gates rendering on terminalAvailable, which the server
 * only ever reports over the WebSocket transport. VS Code keeps using its own
 * terminal panel.
 *
 * The agent-card bar (AgentCardBar, shared with VS Code) is drawn on top of
 * the office space at its right edge at all times; the terminal panel opens to
 * the bar's right. Here the cards double as tabs — clicking one selects that
 * agent's pane — so the panel itself is pure terminal with no chrome of its own
 * beyond the resize handle and a floating close button.
 */
export function TerminalDrawer({
  agentIds,
  shownAgentId,
  onSelectAgent,
  onCloseAgent,
  isOpen,
  onClosePanel,
  widthPx,
  onResizeStart,
  getAppearance,
  statusFor,
  onStatusChange,
}: TerminalDrawerProps) {
  if (agentIds.length === 0) return null;

  return (
    <div className="h-full shrink-0 flex">
      {/* The cards are the panel's tabs — clicking one selects that agent's
          pane (App also reopens the panel if it's closed). */}
      <AgentCardBar
        agentIds={agentIds}
        activeAgentId={shownAgentId}
        getAppearance={getAppearance}
        statusFor={statusFor}
        onSelect={onSelectAgent}
        onClose={onCloseAgent}
      />

      {/* Terminal panel — opens to the right of the card bar. display:none
          (not unmount) while closed: the panes stay mounted so xterm buffers
          and sockets survive; unmounting would drop the scrollback and force a
          reconnect on every toggle. TerminalPane skips fit() at zero size, and
          the ResizeObserver re-fits on reopen. */}
      <div
        className={`relative h-full flex-col bg-bg border-l-2 border-border ${isOpen ? 'flex' : 'hidden'}`}
        style={{ width: widthPx }}
      >
        {/* Drag handle over the left edge. App owns the gesture so it can
            resize the office region in lockstep. */}
        <div
          className="absolute top-0 left-0 bottom-0 z-40 cursor-col-resize hover:bg-accent"
          style={{ width: TERMINAL_DRAWER_RESIZE_HANDLE_PX }}
          onMouseDown={onResizeStart}
          title="Drag to resize"
        />

        {/* Close the panel. Floats over the pane's top-right corner so the
            panel needs no header bar of its own — ghost keeps it invisible
            over terminal content until hovered. */}
        <div className="absolute top-4 right-4 z-50">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClosePanel}
            className="hover:bg-btn-hover"
            title="Close terminal"
          >
            {'>'}
          </Button>
        </div>

        <div className="relative flex-1 min-h-0 p-4">
          <TerminalPaneStack
            agentIds={agentIds}
            shownAgentId={shownAgentId}
            onStatusChange={onStatusChange}
            paneClassName="inset-4"
          />
        </div>
      </div>
    </div>
  );
}
