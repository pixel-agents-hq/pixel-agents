import type { ReactNode } from 'react';

import { TERMINAL_SIDEBAR_WIDTH_PX } from '../constants.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCardList } from './AgentCardList.js';

interface AgentCardBarProps {
  /** Agents to show, top to bottom (the shared card order). */
  agentIds: number[];
  /** The agent whose terminal pane is showing (standalone). Its card gets the
   *  accent border. */
  activeAgentId?: number | null;
  /** The agent whose character is selected in the office. Its card gets the
   *  active background; `activeAgentId` wins when both name the same agent. */
  focusedAgentId?: number | null;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  onSelect: (agentId: number) => void;
  onClose: (agentId: number) => void;
  /** Persist a dragged order; absent in a read-only office. */
  onReorder?: (order: number[]) => void;
  /** Drawn right below the cards (the terminal's hide ribbon). */
  trailing?: ReactNode;
}

/**
 * The column of agent cards along the office's right edge — the desktop
 * wrapping of AgentCardList, shared by both desktop hosts. The phone shows
 * the same cards, in the same order, as a row (MobileAgentBar).
 *
 * Transparent and borderless, drawn on top of the office space: the negative
 * margin exactly cancels the column's width, so it takes no layout room and
 * overlays the office's right edge as a flex sibling of the office region.
 * Pointer events pass through the empty parts so the office stays clickable
 * underneath; only the cards are interactive. Drag a card to reorder.
 *
 * In standalone the cards double as the terminal panel's tabs (the panel
 * opens to the bar's right). In VS Code a card click raises that agent's
 * editor terminal via focusAgent.
 */
export function AgentCardBar({
  agentIds,
  activeAgentId = null,
  focusedAgentId = null,
  getAppearance,
  statusFor,
  onSelect,
  onClose,
  onReorder,
  trailing,
}: AgentCardBarProps) {
  return (
    <AgentCardList
      agentIds={agentIds}
      axis="y"
      className="relative z-30 h-full shrink-0 flex flex-col items-center gap-4 pt-4 overflow-y-auto pointer-events-none"
      style={{ width: TERMINAL_SIDEBAR_WIDTH_PX, marginLeft: -TERMINAL_SIDEBAR_WIDTH_PX }}
      onReorder={onReorder}
      activeAgentId={activeAgentId}
      focusedAgentId={focusedAgentId}
      getAppearance={getAppearance}
      statusFor={statusFor}
      onSelect={onSelect}
      onClose={onClose}
      trailing={trailing}
    />
  );
}
