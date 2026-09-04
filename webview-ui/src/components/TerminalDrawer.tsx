import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useState } from 'react';

import { TERMINAL_DRAWER_RESIZE_HANDLE_PX, TERMINAL_SIDEBAR_WIDTH_PX } from '../constants.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import type { AgentActivity, AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';
import { TerminalPane } from './TerminalPane.js';
import { Button } from './ui/Button.js';

interface TerminalDrawerProps {
  /** Agent ids with a live PTY, in open order. */
  agentIds: number[];
  activeAgentId: number | null;
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
  getAppearance: (agentId: number) => AgentAppearance | null;
  /** Look up an agent's activity for its tab status dot (null until first activity). */
  getActivity: (agentId: number) => AgentActivity | null;
}

/**
 * Right-docked panel hosting one xterm tab per launched agent.
 *
 * Standalone only — App gates rendering on terminalAvailable, which the server
 * only ever reports over the WebSocket transport. VS Code keeps using its own
 * terminal panel.
 *
 * A transparent, borderless bar of agent cards is drawn on top of the office
 * space at its right edge at all times; the terminal panel opens to the bar's
 * right. The cards double as tabs — clicking one selects that agent's pane —
 * so the panel itself is pure terminal with no chrome of its own beyond the
 * resize handle and a floating close button.
 */
export function TerminalDrawer({
  agentIds,
  activeAgentId,
  onSelectAgent,
  onCloseAgent,
  isOpen,
  onClosePanel,
  widthPx,
  onResizeStart,
  getAppearance,
  getActivity,
}: TerminalDrawerProps) {
  // Terminal socket status per agent, for the "connection broken" (red) dot.
  const [connStatuses, setConnStatuses] = useState<Record<number, TerminalConnectionStatus>>({});
  const handleStatusChange = useCallback((agentId: number, status: TerminalConnectionStatus) => {
    setConnStatuses((prev) => (prev[agentId] === status ? prev : { ...prev, [agentId]: status }));
  }, []);

  if (agentIds.length === 0) return null;

  // Fall back to the first tab when the active agent has no terminal (e.g. the
  // user clicked an externally-detected character, which has no PTY).
  const activeId =
    activeAgentId !== null && agentIds.includes(activeAgentId) ? activeAgentId : agentIds[0];

  // null = no activity yet → empty square. Broken connection (red) wins.
  const statusFor = (agentId: number): TabStatus | null => {
    const conn = connStatuses[agentId];
    return conn === 'closed' || conn === 'reconnecting' ? 'disconnected' : getActivity(agentId);
  };

  return (
    <div className="h-full shrink-0 flex">
      {/* Always-visible card bar: transparent and borderless, drawn on top of
          the office space — the negative margin exactly cancels its width, so
          it takes no layout room and overlays the office's right edge (just
          left of the terminal panel when that is open). Pointer events pass
          through the empty parts so the office stays clickable underneath;
          only the toggle and the cards are interactive. The cards are the
          panel's tabs — clicking one selects that agent's pane (App also
          reopens the panel if it's closed). */}
      <div
        className="relative z-30 h-full shrink-0 flex flex-col items-center gap-4 pt-4 overflow-y-auto pointer-events-none"
        style={{ width: TERMINAL_SIDEBAR_WIDTH_PX, marginLeft: -TERMINAL_SIDEBAR_WIDTH_PX }}
      >
        {agentIds.map((agentId) => (
          <AgentCard
            key={agentId}
            agentId={agentId}
            variant={agentId === activeId ? 'active' : 'default'}
            appearance={getAppearance(agentId) ?? { palette: 0, hueShift: 0 }}
            status={statusFor(agentId)}
            onSelect={onSelectAgent}
            onClose={onCloseAgent}
          />
        ))}
      </div>

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

        {/* Panes: all mounted, only the active one shown. Inactive wrappers
            must not hit-test — they are full-size transparent overlays in DOM
            order, so a later tab's empty wrapper would swallow clicks (text
            selection, focus) meant for an earlier active pane. */}
        <div className="relative flex-1 min-h-0 p-4">
          {agentIds.map((agentId) => (
            <div
              key={agentId}
              className={`absolute inset-4 ${agentId === activeId ? '' : 'pointer-events-none'}`}
            >
              <TerminalPane
                agentId={agentId}
                isActive={agentId === activeId}
                onStatusChange={handleStatusChange}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
