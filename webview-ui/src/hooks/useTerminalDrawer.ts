import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentActivity, AgentAppearance, TabStatus } from '../components/AgentCard.js';
import {
  TERMINAL_DRAWER_DEFAULT_WIDTH_PX,
  TERMINAL_DRAWER_MAX_WIDTH_RATIO,
  TERMINAL_DRAWER_MIN_WIDTH_PX,
  TERMINAL_SIDEBAR_WIDTH_PX,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import { answersLaunch } from './launchLatch.js';

/** A character not (yet) in the office — the mug shot falls back to palette 0. */
const DEFAULT_APPEARANCE: AgentAppearance = { palette: 0, repeat: 0 };

interface TerminalDrawerInputs {
  /** Agent ids with a live server-side PTY, in open order (control plane). */
  terminalAgentIds: number[];
  getOfficeState: () => OfficeState;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  agentSeenActivity: Record<number, boolean>;
}

export interface TerminalDrawerController {
  activeAgentId: number | null;
  /** The pane actually showing: the active agent's, or the first terminal
   *  when the active agent has no PTY (an external session's character was
   *  clicked). null only when there are no terminals. Both shells and the
   *  mobile key bar read this one resolution. */
  shownAgentId: number | null;
  isOpen: boolean;
  widthPx: number;
  /** The newest terminal the drawer saw appear (launch answered, or a reload
   *  re-announcing live sessions) — it became the active tab. `seq` makes
   *  every appearance a distinct value for effects to key on. */
  lastOpened: { agentId: number; seq: number } | null;
  /** `lastOpened` when it answered a launch this client made (`expectLaunch`
   *  armed it): the one "this terminal opened because we launched it" fact.
   *  A reload re-announcing live sessions never sets it. */
  lastLaunched: { agentId: number; seq: number } | null;
  /** A launch (or resume) was just sent: the next terminal to open within
   *  LAUNCH_ANSWER_TIMEOUT_MS answers it. Every open disarms it, whether or
   *  not it was armed, and so does the timeout (a failed spawn opens none). */
  expectLaunch: () => void;
  /** Show an agent's terminal if it has one; no-op otherwise. The office's
   *  character click routes here: standalone has no editor panel to raise, so
   *  "focus the agent" means "open its tab", mirroring VS Code's terminalRef.show(). */
  reveal: (agentId: number) => void;
  /** Card click: open the tab AND select + follow the character, so the card
   *  and the office stay in sync. */
  select: (agentId: number) => void;
  close: () => void;
  onResizeStart: (e: ReactMouseEvent) => void;
  getAppearance: (agentId: number) => AgentAppearance;
  /** Card status dot: 'disconnected' (red) for a terminal whose socket
   *  dropped, otherwise the agent's activity; null before its first activity. */
  statusFor: (agentId: number) => TabStatus | null;
  /** Each TerminalPane reports its socket state here, and null once it
   *  unmounts (no pane, nothing to flag). */
  onStatusChange: (agentId: number, status: TerminalConnectionStatus | null) => void;
}

/**
 * The drawer width that fits a viewport: the office keeps at least the card
 * bar's width (the cards overlay its right edge, and they are the only way to
 * switch agents), so on a narrow screen the minimum gives way to that.
 */
export function clampDrawerWidth(preferredPx: number, viewportPx: number): number {
  const maxPx = Math.min(
    viewportPx * TERMINAL_DRAWER_MAX_WIDTH_RATIO,
    viewportPx - TERMINAL_SIDEBAR_WIDTH_PX,
  );
  return Math.max(0, Math.min(maxPx, Math.max(TERMINAL_DRAWER_MIN_WIDTH_PX, preferredPx)));
}

/**
 * All state and derivations behind the standalone terminal panes, on both
 * shells: which tab is active (and which pane that resolves to), whether the
 * desktop panel is open, its width and drag-resize gesture, each pane's socket
 * state, and the per-agent lookups the cards render from. App only composes it.
 */
export function useTerminalDrawer({
  terminalAgentIds,
  getOfficeState,
  agentTools,
  agentStatuses,
  agentSeenActivity,
}: TerminalDrawerInputs): TerminalDrawerController {
  const [activeAgentId, setActiveAgentId] = useState<number | null>(null);
  const [lastOpened, setLastOpened] = useState<{ agentId: number; seq: number } | null>(null);
  const [lastLaunched, setLastLaunched] = useState<{ agentId: number; seq: number } | null>(null);
  // When the pending launch was sent (null = none): it expires, see answersLaunch.
  const launchArmedAtRef = useRef<number | null>(null);
  const expectLaunch = useCallback(() => {
    launchArmedAtRef.current = Date.now();
  }, []);
  const [isOpen, setIsOpen] = useState(false);
  // The width the user asked for; what renders is that clamped to the
  // viewport, re-derived on every window resize so a window that narrows
  // while the drawer is open never pushes the office (and its cards) out.
  const [preferredWidthPx, setPreferredWidthPx] = useState(TERMINAL_DRAWER_DEFAULT_WIDTH_PX);
  const [viewportPx, setViewportPx] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportPx(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const widthPx = clampDrawerWidth(preferredWidthPx, viewportPx);
  const [connStatuses, setConnStatuses] = useState<Record<number, TerminalConnectionStatus>>({});

  const shownAgentId =
    activeAgentId !== null && terminalAgentIds.includes(activeAgentId)
      ? activeAgentId
      : (terminalAgentIds[0] ?? null);

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
    const newest = added[added.length - 1];
    setActiveAgentId(newest);
    setIsOpen(true);
    setLastOpened((prev) => ({ agentId: newest, seq: (prev?.seq ?? 0) + 1 }));
    if (answersLaunch(launchArmedAtRef.current, Date.now())) {
      setLastLaunched((prev) => ({ agentId: newest, seq: (prev?.seq ?? 0) + 1 }));
    }
    launchArmedAtRef.current = null;
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
      getOfficeState().selectAndFollow(agentId);
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
      const onMove = (ev: MouseEvent) => {
        // Dragging left (smaller clientX) widens the panel.
        const next = startWidth + (startX - ev.clientX);
        setPreferredWidthPx(clampDrawerWidth(next, window.innerWidth));
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
  // reads the same palette/repeat the office assigned that character.
  const getAppearance = useCallback(
    (id: number): AgentAppearance => {
      const ch = getOfficeState().characters.get(id);
      return ch ? { palette: ch.palette, repeat: ch.repeat } : DEFAULT_APPEARANCE;
    },
    [getOfficeState],
  );

  // Activity for the tab status dot (green idle / blue working / yellow needs
  // attention). null until the agent's first activity, so the dot stays empty.
  // Yellow is a permission prompt only: Claude Code's idle_prompt (a finished
  // turn left unanswered for a minute) is still green, or every idle agent
  // would turn yellow a minute after it finished.
  const getActivity = useCallback(
    (id: number): AgentActivity | null => {
      if (!agentSeenActivity[id]) return null;
      const tools = agentTools[id];
      if (tools?.some((t) => t.permissionWait && !t.done)) return 'attention';
      if (tools?.some((t) => !t.done)) return 'working';
      if (agentStatuses[id] === 'waiting') return 'idle';
      return 'working';
    },
    [agentSeenActivity, agentTools, agentStatuses],
  );

  const onStatusChange = useCallback((agentId: number, status: TerminalConnectionStatus | null) => {
    setConnStatuses((prev) => {
      if (status === null) {
        if (!(agentId in prev)) return prev;
        const rest = { ...prev };
        delete rest[agentId];
        return rest;
      }
      return prev[agentId] === status ? prev : { ...prev, [agentId]: status };
    });
  }, []);

  // Broken connection (red) wins over activity, for agents that have a pane.
  const statusFor = useCallback(
    (id: number): TabStatus | null => {
      const conn = connStatuses[id];
      if (terminalAgentIds.includes(id) && (conn === 'closed' || conn === 'reconnecting')) {
        return 'disconnected';
      }
      return getActivity(id);
    },
    [connStatuses, terminalAgentIds, getActivity],
  );

  return {
    activeAgentId,
    shownAgentId,
    lastOpened,
    lastLaunched,
    expectLaunch,
    isOpen,
    widthPx,
    reveal,
    select,
    close,
    onResizeStart,
    getAppearance,
    statusFor,
    onStatusChange,
  };
}
