import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentActivity, AgentAppearance } from '../components/AgentCard.js';
import {
  TERMINAL_DRAWER_DEFAULT_WIDTH_PX,
  TERMINAL_DRAWER_MAX_WIDTH_RATIO,
  TERMINAL_DRAWER_MIN_WIDTH_PX,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';

interface TerminalDrawerInputs {
  /** Agent ids with a live server-side PTY, in open order (control plane). */
  terminalAgentIds: number[];
  getOfficeState: () => OfficeState;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  agentAwaitingInput: Record<number, boolean>;
  agentSeenActivity: Record<number, boolean>;
}

export interface TerminalDrawerController {
  activeAgentId: number | null;
  isOpen: boolean;
  widthPx: number;
  /** Show an agent's terminal if it has one; no-op otherwise. The office's
   *  character click routes here: standalone has no editor panel to raise, so
   *  "focus the agent" means "open its tab", mirroring VS Code's terminalRef.show(). */
  reveal: (agentId: number) => void;
  /** Card click: open the tab AND select + follow the character, so the card
   *  and the office stay in sync. */
  select: (agentId: number) => void;
  close: () => void;
  onResizeStart: (e: ReactMouseEvent) => void;
  getAppearance: (agentId: number) => AgentAppearance | null;
  getActivity: (agentId: number) => AgentActivity | null;
}

/**
 * All state and derivations behind the standalone terminal drawer: which tab is
 * active, whether the panel is open, its width and drag-resize gesture, and the
 * per-agent lookups the cards render from. App only composes it.
 */
export function useTerminalDrawer({
  terminalAgentIds,
  getOfficeState,
  agentTools,
  agentStatuses,
  agentAwaitingInput,
  agentSeenActivity,
}: TerminalDrawerInputs): TerminalDrawerController {
  const [activeAgentId, setActiveAgentId] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [widthPx, setWidthPx] = useState(TERMINAL_DRAWER_DEFAULT_WIDTH_PX);

  // Reveal a newly-opened terminal. Launching is async — the toolbar sends
  // launchAgent and the server answers with terminalSessionOpened once the PTY
  // is up — so "open the drawer on launch" is expressed as "open it when a
  // terminal we hadn't seen appears". This also restores the drawer after a
  // reload, when webviewReady re-announces the live sessions.
  const knownIdsRef = useRef<number[]>([]);
  useEffect(() => {
    const added = terminalAgentIds.filter((id) => !knownIdsRef.current.includes(id));
    knownIdsRef.current = terminalAgentIds;
    if (added.length === 0) return;
    setActiveAgentId(added[added.length - 1]);
    setIsOpen(true);
  }, [terminalAgentIds]);

  const reveal = useCallback(
    (agentId: number) => {
      if (!terminalAgentIds.includes(agentId)) return;
      setActiveAgentId(agentId);
      setIsOpen(true);
    },
    [terminalAgentIds],
  );

  const select = useCallback(
    (agentId: number) => {
      setActiveAgentId(agentId);
      setIsOpen(true);
      const os = getOfficeState();
      if (os.characters.has(agentId)) {
        os.selectedAgentId = agentId;
        os.cameraFollowId = agentId;
      }
    },
    [getOfficeState],
  );

  const close = useCallback(() => setIsOpen(false), []);

  // Drag the panel's left edge to resize. The office region is flex-1 beside it,
  // so it reflows to fill whatever width is left — the canvas ResizeObserver
  // repaints and re-centres the camera on the smaller region automatically.
  const onResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthPx;
      const maxWidth = window.innerWidth * TERMINAL_DRAWER_MAX_WIDTH_RATIO;
      const onMove = (ev: MouseEvent) => {
        // Dragging left (smaller clientX) widens the panel.
        const next = startWidth + (startX - ev.clientX);
        setWidthPx(Math.max(TERMINAL_DRAWER_MIN_WIDTH_PX, Math.min(maxWidth, next)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
      };
      // Suppress text selection while dragging over the terminal/office.
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [widthPx],
  );

  // A terminal tab shows the agent's character (front-facing mug shot), so it
  // reads the same palette/hueShift the office assigned that character.
  const getAppearance = useCallback(
    (id: number): AgentAppearance | null => {
      const ch = getOfficeState().characters.get(id);
      return ch ? { palette: ch.palette, hueShift: ch.hueShift } : null;
    },
    [getOfficeState],
  );

  // Activity for the tab status dot (green idle / blue working / yellow needs
  // attention). null until the agent's first activity, so the dot stays empty.
  // Connection-broken (red) is layered on top by the drawer itself.
  const getActivity = useCallback(
    (id: number): AgentActivity | null => {
      if (!agentSeenActivity[id]) return null;
      const tools = agentTools[id];
      if (tools?.some((t) => t.permissionWait && !t.done)) return 'attention';
      if (tools?.some((t) => !t.done)) return 'working';
      if (agentAwaitingInput[id]) return 'attention';
      if (agentStatuses[id] === 'waiting') return 'idle';
      return 'working';
    },
    [agentSeenActivity, agentTools, agentStatuses, agentAwaitingInput],
  );

  return {
    activeAgentId,
    isOpen,
    widthPx,
    reveal,
    select,
    close,
    onResizeStart,
    getAppearance,
    getActivity,
  };
}
