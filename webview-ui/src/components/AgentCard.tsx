import { CARD_CONTEXT_BAR_HEIGHT_PX, CARD_MUGSHOT_CROP_TOP_ROW } from '../constants.js';
import { ContextBar } from '../office/ContextBar.js';
import { contextLeft, useAgentContextUsed } from '../office/contextGauge.js';
import type { CardVariant, CloseMode } from './cardBar.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { STATUS_DOT } from './statusDot.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

/** How a given agent's character looks, for the tab mug shot. */
export interface AgentAppearance {
  palette: number;
  repeat: number;
}

/** Agent activity reflected by the tab's status dot. */
export type AgentActivity = 'idle' | 'working' | 'attention';

/** Activity plus the drawer-owned "connection broken" state. */
export type TabStatus = AgentActivity | 'disconnected';

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
  const contextUsed = useAgentContextUsed(agentId);
  return (
    <div
      className={`group relative pointer-events-auto flex items-stretch gap-1 p-1 cursor-pointer border-2 shrink-0 ${CARD_VARIANT[variant]}`}
      onClick={() => onSelect(agentId)}
      title={`Agent ${agentId}`}
    >
      <CharacterMugShot
        palette={appearance.palette}
        repeat={appearance.repeat}
        cropTop={CARD_MUGSHOT_CROP_TOP_ROW}
      />
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
          {/* The × is drawn a pixel left of its grid's centre: nudged right,
              its centre lines up with the status dot's. */}
          <PixelIcon name="close" className="translate-x-1" />
        </Button>
        {/* Lifted clear of the context bar along the card's foot; with no
            status it keeps its place, invisible. */}
        <span
          className={`flex shrink-0 ${status ? STATUS_DOT[status] : 'invisible'}`}
          style={{ marginBottom: CARD_CONTEXT_BAR_HEIGHT_PX + 3 }}
        >
          <PixelIcon name="dot" scale={1} />
        </span>
      </div>
      {/* The agent's context left, along the card's whole foot (the same
          gauge as over its character); none before its first turn. */}
      {contextUsed !== null && (
        <ContextBar
          used={contextUsed}
          height={CARD_CONTEXT_BAR_HEIGHT_PX}
          className="absolute left-0 right-0 bottom-0 pointer-events-none"
          title={`${Math.round(contextLeft(contextUsed) * 100)}% context left`}
          testId="card-context-bar"
        />
      )}
    </div>
  );
}
