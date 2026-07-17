import { CharacterMugShot } from './CharacterMugShot.js';
import { Button } from './ui/Button.js';

/** How a given agent's character looks, for the tab mug shot. */
export interface AgentAppearance {
  palette: number;
  hueShift: number;
}

/** Agent activity reflected by the tab's status dot. */
export type AgentActivity = 'idle' | 'working' | 'attention';

/** Activity plus the drawer-owned "connection broken" state. */
export type TabStatus = AgentActivity | 'disconnected';

const STATUS_DOT: Record<TabStatus, string> = {
  idle: 'bg-status-success', // green — turn complete, nothing pending
  working: 'bg-accent-bright', // blue — actively running
  attention: 'bg-status-permission', // yellow — needs permission or input
  disconnected: 'bg-status-error', // red — terminal socket dropped
};

interface AgentCardProps {
  agentId: number;
  isActive: boolean;
  appearance: AgentAppearance;
  status: TabStatus | null;
  onSelect: (agentId: number) => void;
  onClose: (agentId: number) => void;
}

/** One agent's card in the terminal sidebar — mug shot beside a
 *  close-button/status-dot column. The cards double as the terminal panel's
 *  tabs: clicking one selects that agent's pane. */
export function AgentCard({
  agentId,
  isActive,
  appearance,
  status,
  onSelect,
  onClose,
}: AgentCardProps) {
  return (
    <div
      className={`pointer-events-auto flex items-stretch gap-1 p-1 cursor-pointer border-2 shrink-0 ${
        isActive ? 'bg-active-bg border-accent' : 'bg-btn-bg border-transparent hover:bg-btn-hover'
      }`}
      onClick={() => onSelect(agentId)}
      title={`Agent ${agentId}`}
    >
      <CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} />
      {/* Close on top, status dot at the bottom, both centred over the
          same column beside the mug shot. */}
      <div className="flex flex-col items-center justify-between shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            // Don't also select the tab we're about to remove.
            e.stopPropagation();
            onClose(agentId);
          }}
          title="Close agent"
          className="leading-none"
        >
          ×
        </Button>
        {/* 1px left: optically centres the solid square under the pixel-font ×
            glyph, which sits a hair left in its cell. mb (not pb) lifts it off
            the card's bottom edge: the span is a fixed-size empty box, so
            padding is invisible — only margin moves it. */}
        <span
          className={`size-6 shrink-0 relative -left-1 mb-2 ${status ? STATUS_DOT[status] : ''}`}
        />
      </div>
    </div>
  );
}
