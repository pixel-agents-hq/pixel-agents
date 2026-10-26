import { AGENT_CARD_HEIGHT_PX, ROSTER_ARROW_WIDTH_PX } from '../constants.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { useRosterLaunch } from '../hooks/useRosterLaunch.js';
import { isTypingInTerminal } from '../terminal/terminalDom.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCardList } from './AgentCardList.js';
import { PhoneCharacterPicker } from './CharacterPicker.js';
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
  /** Launch into a Directory picked from the + card's drawer, wearing
   *  `palette` when the launch started from the roster. */
  onLaunchDirectory: (directory: Directory, palette?: number) => void;
  /** Directories offered by the launch drawer (tap on the + card). */
  directories: Directory[];
  /** Drawer's pinned `+ Directory` row — opens the Directory modal empty. */
  onAddDirectory: () => void;
  /** Pencil on a user-defined row — opens the modal pre-filled. */
  onEditDirectory: (directory: Directory) => void;
  /** Opens the Characters view. Absent hides the roster arrow (a read-only
   *  office). */
  onOpenCharacters?: () => void;
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
  onOpenCharacters,
  canLaunch,
  launchUnavailableReason,
  getAppearance,
  statusFor,
  onReorder,
}: MobileAgentBarProps) {
  // The + card's drawer and the roster beside it: a pick opens the drawer for
  // that character. A plain press of + never launches: it opens the plain
  // drawer (dropping any pick), and the launch happens from a Directory row
  // (the mobile counterpart of desktop's + click). A press anywhere outside
  // the launch card closes the drawer; Escape doesn't.
  const menus = useRosterLaunch({
    canLaunch,
    onOpenCharacters,
    escapeClosesDrawer: false,
  });
  const { closeDrawer } = menus;

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
    <div className="relative shrink-0 bg-bg border-t-2 border-border touch-pan-x">
      <PhoneCharacterPicker
        isOpen={menus.isRosterOpen}
        containerRef={menus.rosterRef}
        onPick={menus.pick}
        onEdit={menus.edit}
        onNew={menus.addNew}
      />
      <div className="flex items-stretch gap-6 px-8 py-6">
        {/* Launch card pinned on the left; only the agent cards scroll.
            A tap opens the launch drawer above it — so the wrapper is the
            positioning context and the outside-press boundary. */}
        <div ref={menus.launchRef} className="relative shrink-0 flex">
          {/* The + card and, right of it, the roster's arrow: one card, two
              buttons, as tall as the bar's cards (sized, not stretched: a
              stretched aspect-ratio box never widens its parent). + is
              square; the arrow a narrow tab beside it. It points up while the roster is
              shut and turns down while it is open; a tap toggles it. */}
          <div className="flex shrink-0">
            <button
              onClick={canLaunch ? menus.openDrawer : undefined}
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
            {onOpenCharacters && (
              <button
                ref={menus.buttonRef}
                type="button"
                onClick={menus.toggleRoster}
                aria-label="Roster"
                aria-expanded={menus.isRosterOpen}
                title={menus.isRosterOpen ? 'Hide roster' : 'Roster'}
                // Enabled even when nothing can launch: a pick then edits.
                style={{ width: ROSTER_ARROW_WIDTH_PX, height: AGENT_CARD_HEIGHT_PX }}
                className={`flex items-center justify-center border-2 border-l-bg/40 rounded-none select-none cursor-pointer ${
                  canLaunch
                    ? 'bg-accent border-accent text-white active:bg-accent-bright'
                    : 'bg-btn-bg border-border text-text-muted'
                }`}
              >
                <span
                  className={`flex transition-transform duration-200 ${menus.isRosterOpen ? '' : 'rotate-180'}`}
                >
                  <PixelIcon name="down" scale={1} />
                </span>
              </button>
            )}
          </div>
          <LaunchDrawer
            isOpen={menus.isDrawerOpen}
            directories={directories}
            pick={menus.pendingPick}
            onSelect={(directory, palette) => {
              closeDrawer();
              onLaunchDirectory(directory, palette);
            }}
            onAddDirectory={() => {
              closeDrawer();
              onAddDirectory();
            }}
            onEditDirectory={(directory) => {
              closeDrawer();
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
