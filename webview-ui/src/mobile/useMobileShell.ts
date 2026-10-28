import { useCallback, useEffect, useRef, useState } from 'react';

import type { Directory } from '../hooks/useExtensionMessages.js';
import type { TerminalDrawerController } from '../hooks/useTerminalDrawer.js';
import type { OfficeState } from '../office/engine/officeState.js';

export type MobileView = 'office' | 'terminal';

export interface MobileShellController {
  view: MobileView;
  /** Slide to the terminal page (the drawer decides which pane shows). */
  showTerminal: () => void;
  /** The >_ / Office button and the edge swipe. */
  toggleView: () => void;
  /** A tap on an agent card. */
  selectCard: (agentId: number) => void;
  /** A Directory picked from the + card's drawer: launch into it, then
   *  slide over once the new terminal appears. */
  launch: (directory: Directory) => void;
}

interface MobileShellInputs {
  getOfficeState: () => OfficeState;
  terminalAgentIds: number[];
  drawer: TerminalDrawerController;
  focusedAgentId: number | null;
  launchAgent: (directory: Directory) => void;
}

/**
 * The mobile shell's navigation rules: which page shows, and what a card tap,
 * the view toggle, and a launch do to it. Office and terminal pages share one
 * selection model with the desktop — the drawer still owns which pane is
 * active — this only adds the page.
 */
export function useMobileShell({
  getOfficeState,
  terminalAgentIds,
  drawer,
  focusedAgentId,
  launchAgent,
}: MobileShellInputs): MobileShellController {
  const [view, setView] = useState<MobileView>('office');
  const { reveal, lastOpened } = drawer;

  // Slide over only for launches made from the + card: the office is the
  // app's main screen, so a reload that re-announces live sessions must land
  // on the office, not whatever terminal happens to exist.
  const pendingLaunchRef = useRef(false);
  useEffect(() => {
    if (!lastOpened) return;
    if (pendingLaunchRef.current) setView('terminal');
    pendingLaunchRef.current = false;
  }, [lastOpened]);

  const launch = useCallback(
    (directory: Directory) => {
      pendingLaunchRef.current = true;
      launchAgent(directory);
    },
    [launchAgent],
  );

  const showTerminal = useCallback(() => setView('terminal'), []);

  // Entering the terminal view collapses the canvas focus into the terminal
  // selection: whoever is focused in the office is the agent whose terminal
  // shows (sub-agents resolve to their parent, which owns the pane). Card
  // taps, character double-taps, and launches already keep the two in sync —
  // this toggle was the one path that could land on a different agent's
  // terminal than the focused one.
  const toggleView = useCallback(() => {
    if (view === 'terminal') {
      setView('office');
      return;
    }
    if (focusedAgentId !== null) reveal(getOfficeState().terminalOwnerOf(focusedAgentId));
    setView('terminal');
  }, [view, focusedAgentId, reveal, getOfficeState]);

  // In terminal view the bar is a tab strip: one tap switches panes (agents
  // with no pane jump back to the office). In office view it mirrors the
  // character's two-step tap: the first tap focuses the character (camera
  // follow + status label), a repeat tap on the already-focused agent opens
  // its terminal.
  const selectCard = useCallback(
    (agentId: number) => {
      const os = getOfficeState();
      const hasTerminal = terminalAgentIds.includes(agentId);
      if (view === 'terminal') {
        os.selectAndFollow(agentId);
        if (hasTerminal) reveal(agentId);
        else setView('office');
        return;
      }
      if (os.selectedAgentId === agentId && hasTerminal) {
        reveal(agentId);
        setView('terminal');
        return;
      }
      os.selectAndFollow(agentId);
      // Pre-select the pane (and the card highlight) without leaving the office.
      reveal(agentId);
    },
    [getOfficeState, terminalAgentIds, view, reveal],
  );

  return { view, showTerminal, toggleView, selectCard, launch };
}
