import { useEffect, useRef, useState } from 'react';

import { AGENT_CARD_HEIGHT_PX } from '../constants.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { isTypingInTerminal } from '../terminal/terminalDom.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCardList } from './AgentCardList.js';
import { LaunchDrawer } from './LaunchDrawer.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface MobileAgentBarProps {
  /** Every main agent (launched and external), in the shared card order. */
  agentIds: number[];
  /** Agent whose character is selected in the office (bg highlight, no border). */
  focusedAgentId: number | null;
  /** Agent whose terminal pane is showing — accent border and the only
   *  visible ×. App passes null on the office page, where no pane shows. */
  activeAgentId: number | null;
  onSelectAgent: (agentId: number) => void;
  onCloseAgent: (agentId: number) => void;
  /** Launch into a Directory picked from the + card's drawer. */
  onLaunchDirectory: (directory: Directory) => void;
  /** Directories offered by the launch drawer (tap on the + card). */
  directories: Directory[];
  /** Drawer's pinned `+ Directory` row — opens the Directory modal empty. */
  onAddDirectory: () => void;
  /** Pencil on a user-defined row — opens the modal pre-filled. */
  onEditDirectory: (directory: Directory) => void;
  /** False when the server has no working PTY — the + card shows disabled. */
  canLaunch: boolean;
  launchUnavailableReason: string | null;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  /** Persist a dragged order; absent in a read-only office. */
  onReorder?: (order: number[]) => void;
}

/**
 * Bottom bar of the mobile shell: every agent as a horizontally scrollable
 * card, plus a launch card pinned on the left. Visible under both the office
 * and the terminal pages, so it doubles as the terminal switcher.
 *
 * The cards are the phone wrapping of AgentCardList: the same cards, in the
 * same server-owned order, as the desktop column (AgentCardBar). App decides
 * what a tap means per agent (open terminal vs. select in office).
 * Press-and-hold a card to reorder (useCardReorder).
 */
export function MobileAgentBar({
  agentIds,
  focusedAgentId,
  activeAgentId,
  onSelectAgent,
  onCloseAgent,
  onLaunchDirectory,
  directories,
  onAddDirectory,
  onEditDirectory,
  canLaunch,
  launchUnavailableReason,
  getAppearance,
  statusFor,
  onReorder,
}: MobileAgentBarProps) {
  const [isLaunchDrawerOpen, setIsLaunchDrawerOpen] = useState(false);

  const launchRef = useRef<HTMLDivElement>(null);

  // ── Launch card: a tap opens the launch drawer ──────────
  // A plain press never launches: it opens the drawer, and the launch happens
  // from a Directory row (the mobile counterpart of desktop's + Agent click).
  const handleLaunchClick = () => {
    setIsLaunchDrawerOpen(true);
  };

  // Close the drawer on a press anywhere outside the launch card.
  useEffect(() => {
    if (!isLaunchDrawerOpen) return;
    const handlePress = (e: PointerEvent) => {
      if (launchRef.current && !launchRef.current.contains(e.target as Node)) {
        setIsLaunchDrawerOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePress);
    return () => document.removeEventListener('pointerdown', handlePress);
  }, [isLaunchDrawerOpen]);

  // A tap while typing in a terminal: its default would blur the input and
  // dismiss the iOS keyboard, so swallow it and select the card ourselves.
  // The old input keeps focus for now; the newly-activated pane steals it on
  // activation (TerminalPane), and focus moving input-to-input keeps the
  // keyboard open. Taps on the card's × keep their normal click path.
  const keepKeyboardOnTap = (agentId: number, e: TouchEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (isTypingInTerminal(document.activeElement) && target && !target.closest('button')) {
      e.preventDefault();
      onSelectAgent(agentId);
    }
  };

  return (
    // No safe-area padding: the cards keep the same 6px below as above. The
    // home indicator floats over the bar's bottom edge, but taps still land —
    // iOS only claims the swipe gesture there. touch-pan-x: the bar scrolls
    // horizontally only; a vertical drag must not pan the page (iOS pans the
    // layout viewport while the keyboard is up).
    <div className="shrink-0 bg-bg border-t-2 border-border touch-pan-x">
      <div className="flex items-stretch gap-6 px-8 py-6">
        {/* Launch card pinned on the left; only the agent cards scroll.
            A tap opens the launch drawer above it — so the wrapper is the
            positioning context and the outside-press boundary. */}
        <div ref={launchRef} className="relative shrink-0 flex">
          {/* The + card: a square as tall as the bar's cards (sized, not
              stretched: a stretched aspect-ratio box never widens its parent). */}
          <div className="flex shrink-0">
            <button
              onClick={canLaunch ? handleLaunchClick : undefined}
              // A long press must not open the OS callout menu over the drawer.
              onContextMenu={(e) => e.preventDefault()}
              disabled={!canLaunch}
              title={
                canLaunch ? 'Launch agent' : (launchUnavailableReason ?? 'Terminal unavailable')
              }
              style={{ width: AGENT_CARD_HEIGHT_PX, height: AGENT_CARD_HEIGHT_PX }}
              className={`flex items-center justify-center border-2 rounded-none select-none ${
                canLaunch
                  ? 'bg-accent border-accent text-white cursor-pointer active:bg-accent-bright'
                  : 'bg-btn-bg border-border text-text-muted cursor-default opacity-(--btn-disabled-opacity)'
              }`}
            >
              <PixelIcon name="plus" />
            </button>
          </div>
          <LaunchDrawer
            isOpen={isLaunchDrawerOpen}
            directories={directories}
            onSelect={(directory) => {
              setIsLaunchDrawerOpen(false);
              onLaunchDirectory(directory);
            }}
            onAddDirectory={() => {
              setIsLaunchDrawerOpen(false);
              onAddDirectory();
            }}
            onEditDirectory={(directory) => {
              setIsLaunchDrawerOpen(false);
              onEditDirectory(directory);
            }}
          />
        </div>
        <AgentCardList
          agentIds={agentIds}
          axis="x"
          className="flex items-stretch gap-6 overflow-x-auto no-scrollbar flex-1 min-w-0"
          onReorder={onReorder}
          onTouchTap={keepKeyboardOnTap}
          activeAgentId={activeAgentId}
          focusedAgentId={focusedAgentId}
          closeOnlyWhenActive
          getAppearance={getAppearance}
          statusFor={statusFor}
          onSelect={onSelectAgent}
          onClose={onCloseAgent}
        />
      </div>
    </div>
  );
}
