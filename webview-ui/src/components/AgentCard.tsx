import type { CardVariant, CloseMode } from './cardBar.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

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

const CARD_VARIANT: Record<CardVariant, string> = {
  default: 'bg-btn-bg border-transparent hover:bg-btn-hover',
  focused: 'bg-active-bg border-transparent',
  active: 'bg-active-bg border-accent',
};

// `hover` fades with opacity rather than visibility, so the × stays a
// hit target (a pointer over it hovers the card anyway).
const CLOSE_MODE: Record<CloseMode, string> = {
  shown: '',
  hover: 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity',
  hidden: 'invisible',
};

interface AgentCardProps {
  agentId: number;
  variant: CardVariant;
  appearance: AgentAppearance;
  status: TabStatus | null;
  /** How the × shows. It is never removed (the card keeps its width so the
   *  bar doesn't reflow): `hover` (desktop) shows it while the card is
   *  hovered or the × has keyboard focus; `hidden` keeps it invisible — the
   *  phone shows it only on the active terminal tab, so a stray tap can't
   *  close an agent. */
  close?: CloseMode;
  onSelect: (agentId: number) => void;
  onClose: (agentId: number) => void;
}

/** One agent's card in the terminal sidebar — mug shot beside a
 *  close-button/status-dot column. The cards double as the terminal panel's
 *  tabs: clicking one selects that agent's pane. */
export function AgentCard({
  agentId,
  variant,
  appearance,
  status,
  close = 'shown',
  onSelect,
  onClose,
}: AgentCardProps) {
  return (
    <div
      className={`group pointer-events-auto flex items-stretch gap-1 p-1 cursor-pointer border-2 shrink-0 ${CARD_VARIANT[variant]}`}
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
          className={CLOSE_MODE[close]}
        >
          <PixelIcon name="close" />
        </Button>
        {/* mb lifts the round dot off the card's bottom edge; with no status
            it keeps its place, invisible. */}
        <span className={`flex shrink-0 mb-2 ${status ? STATUS_DOT[status] : 'invisible'}`}>
          <PixelIcon name="dot" scale={1} />
        </span>
      </div>
    </div>
  );
}
