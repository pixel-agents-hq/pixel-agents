import { TERMINAL_SIDEBAR_WIDTH_PX } from '../constants.js';
import type { AgentAppearance, CardVariant, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';

interface AgentCardBarProps {
  /** Agents to show, top to bottom. */
  agentIds: number[];
  /** The agent whose terminal pane is showing (standalone). Its card gets the
   *  accent border. */
  activeAgentId?: number | null;
  /** The agent whose character is selected in the office. Its card gets the
   *  active background; `activeAgentId` wins when both name the same agent. */
  focusedAgentId?: number | null;
  getAppearance: (agentId: number) => AgentAppearance | null;
  statusFor: (agentId: number) => TabStatus | null;
  onSelect: (agentId: number) => void;
  onClose: (agentId: number) => void;
}

/**
 * The column of agent cards along the office's right edge — one mug shot and
 * status dot per agent — shared by both desktop hosts.
 *
 * Transparent and borderless, drawn on top of the office space: the negative
 * margin exactly cancels the column's width, so it takes no layout room and
 * overlays the office's right edge as a flex sibling of the office region.
 * Pointer events pass through the empty parts so the office stays clickable
 * underneath; only the cards are interactive.
 *
 * In standalone, TerminalDrawer owns the bar and the cards double as the
 * terminal panel's tabs (the panel opens to the bar's right). In VS Code the
 * bar stands alone and lists every agent in the office, external sessions
 * included; a card click raises that agent's editor terminal via focusAgent.
 */
export function AgentCardBar({
  agentIds,
  activeAgentId = null,
  focusedAgentId = null,
  getAppearance,
  statusFor,
  onSelect,
  onClose,
}: AgentCardBarProps) {
  if (agentIds.length === 0) return null;

  const variantFor = (agentId: number): CardVariant => {
    if (agentId === activeAgentId) return 'active';
    if (agentId === focusedAgentId) return 'focused';
    return 'default';
  };

  return (
    <div
      className="relative z-30 h-full shrink-0 flex flex-col items-center gap-4 pt-4 overflow-y-auto pointer-events-none"
      style={{ width: TERMINAL_SIDEBAR_WIDTH_PX, marginLeft: -TERMINAL_SIDEBAR_WIDTH_PX }}
    >
      {agentIds.map((agentId) => (
        <AgentCard
          key={agentId}
          agentId={agentId}
          variant={variantFor(agentId)}
          appearance={getAppearance(agentId) ?? { palette: 0, hueShift: 0 }}
          status={statusFor(agentId)}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
    </div>
  );
}
