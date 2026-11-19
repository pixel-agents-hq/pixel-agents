/**
 * What a click on interactive furniture does in this office, and what follows
 * this office's own PC shell opening (CONTEXT.md → Interactive Furniture): App
 * composes it, the canvas reports clicks into it, the Directory selector and
 * the Furniture label read its state.
 */

import { useCallback, useEffect, useState } from 'react';

import type { PieceClick } from '../../../core/src/furniture/pieceRules.js';
import type { DirectoryChoice } from './PcDirectorySelector.js';
import { openPcShell, pcShellEntry, usePcShells } from './pcShellStore.js';

interface PcShellPanelsInputs {
  /** This office runs its own terminals (standalone with a PTY): a shell has a pane here. */
  terminalAvailable: boolean;
  /** The browser runtime (standalone); false in VS Code, whose terminals the editor owns. */
  isBrowser: boolean;
  officeReadOnly: boolean;
  /** Open an agent's terminal as its card would (the agent working at a PC). */
  openAgent: (agentId: number) => void;
  /** Show a pane this office just opened (desktop: the drawer; phone: the terminal page). */
  showPane: (id: number) => void;
}

export interface PcShellPanels {
  /** A click on a piece can open something here: where this office runs
   *  terminals — its own (standalone) or the editor's (VS Code) — and may
   *  change things. Elsewhere a piece's label still shows, with nothing to click. */
  canOpenPanels: boolean;
  /** The Directory selector over a PC whose Area has several Directories, or null. */
  directoryChoice: DirectoryChoice | null;
  closeDirectoryChoice: () => void;
  chooseDirectory: (uid: string, directory: string) => void;
  /** A click on a piece, as core's rules resolved it. */
  onPieceClick: (click: PieceClick, uid: string) => void;
}

export function usePcShellPanels({
  terminalAvailable,
  isBrowser,
  officeReadOnly,
  openAgent,
  showPane,
}: PcShellPanelsInputs): PcShellPanels {
  const canOpenPanels = (terminalAvailable || !isBrowser) && !officeReadOnly;

  // A PC whose Area has several Directories asks where its new shell opens.
  const [directoryChoice, setDirectoryChoice] = useState<DirectoryChoice | null>(null);
  const closeDirectoryChoice = useCallback(() => setDirectoryChoice(null), []);
  const chooseDirectory = useCallback((uid: string, directory: string) => {
    setDirectoryChoice(null);
    openPcShell(uid, directory);
  }, []);

  // Its live shell, else the terminal of the agent working at it (as its card
  // would open it), else a new shell — at once in its one place (or home), or
  // through the Directory selector.
  const onPieceClick = useCallback(
    (click: PieceClick, uid: string) => {
      setDirectoryChoice(null);
      switch (click.kind) {
        case 'openPanel':
          openPcShell(uid);
          break;
        case 'newPanel':
          openPcShell(uid, click.place);
          break;
        case 'choosePlace':
          setDirectoryChoice({ uid, places: click.places });
          break;
        case 'agentTerminal':
          openAgent(click.agentId);
          break;
      }
    },
    [openAgent],
  );

  // The shell this office's open was answered with: shown as its card would
  // show it (the phone sliding to the terminal page) — only here, never in the
  // other offices that see it appear. Resolved from the store, which listed the
  // shell before it answered (the server announces, then answers).
  const { ready } = usePcShells();
  useEffect(() => {
    if (!ready || !terminalAvailable) return;
    if (!pcShellEntry().shells.some((shell) => shell.id === ready.id)) return;
    showPane(ready.id);
    // Keyed on the answer alone: a later breakpoint change must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return { canOpenPanels, directoryChoice, closeDirectoryChoice, chooseDirectory, onPieceClick };
}
