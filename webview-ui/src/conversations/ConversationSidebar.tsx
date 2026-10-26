import type { TabStatus } from '../components/AgentCard.js';
import { Button } from '../components/ui/Button.js';
import { CONVERSATION_SIDEBAR_WIDTH_PX, SIDE_PANEL_CONTENT_SHIFT_PX } from '../constants.js';
import { useSlidePanel } from '../hooks/useSlidePanel.js';
import { ConversationList } from './ConversationList.js';

/**
 * Left-docked home of the recent conversations (ConversationList) on the
 * desktop (shown and hidden by the button above the zoom buttons), with Settings pinned at its foot (the phone's menu,
 * docked). Pressing a conversation resumes it: the agent comes back as that
 * character, in its old seat when that is free. Standalone only: resuming
 * needs a terminal. The phone has MobileMenu.
 *
 * Opening stretches the panel out (a little past its width, settling back)
 * with its contents sliding in behind; closing fades them and snaps it shut.
 * Shut, it is unmounted once the close has played, so the list stops polling.
 */
interface ConversationSidebarProps {
  open: boolean;
  /** A past conversation pressed: resume it. */
  onResume: (sessionId: string, directoryPath: string) => void;
  /** A running conversation pressed: go to its agent, as its card would. */
  onOpenAgent: (agentId: number) => void;
  statusFor: (agentId: number) => TabStatus | null;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
}

export function ConversationSidebar({
  open,
  onResume,
  onOpenAgent,
  statusFor,
  isSettingsOpen,
  onToggleSettings,
}: ConversationSidebarProps) {
  const { rendered, shown, panelTransition, contentTransition, onPanelTransitionEnd } =
    useSlidePanel(open, { initiallyOpen: open });

  if (!rendered) return null;

  return (
    // The outer box animates its width and clips; the panel inside keeps its
    // own, pinned to the right edge, so it slides out from behind the left.
    // The overshoot shows as a little more of the panel's background.
    <div
      className="h-full shrink-0 flex justify-end overflow-hidden bg-bg border-r-2 border-border"
      style={{ width: shown ? CONVERSATION_SIDEBAR_WIDTH_PX : 0, transition: panelTransition }}
      onTransitionEnd={onPanelTransitionEnd}
    >
      <aside
        aria-label="Recent conversations"
        data-testid="conversation-sidebar"
        className="h-full shrink-0 flex flex-col"
        style={{
          width: CONVERSATION_SIDEBAR_WIDTH_PX - 2,
          transform: shown ? 'none' : `translateX(-${SIDE_PANEL_CONTENT_SHIFT_PX}px)`,
          opacity: shown ? 1 : 0,
          transition: contentTransition,
        }}
      >
        <ConversationList
          open
          onResume={onResume}
          onOpenAgent={onOpenAgent}
          statusFor={statusFor}
        />
        <div className="p-8 border-t-2 border-border">
          <Button
            size="md"
            icon="settings"
            // Flat until hovered (or open), its icon and label to the left.
            variant={isSettingsOpen ? 'active' : 'ghost'}
            className={`w-full text-left ${isSettingsOpen ? '' : 'text-text! hover:bg-btn-hover'}`}
            onClick={onToggleSettings}
          >
            Settings
          </Button>
        </div>
      </aside>
    </div>
  );
}
