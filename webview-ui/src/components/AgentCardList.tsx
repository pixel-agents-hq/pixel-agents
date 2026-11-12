import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo } from 'react';

import { CARD_SCROLL_INTO_VIEW_MARGIN_PX } from '../constants.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';
import { type Card, cardVariant, closeMode } from './cardBar.js';
import { PcShellCard } from './PcShellCard.js';
import type { CardAxis } from './useCardReorder.js';
import { useCardReorder } from './useCardReorder.js';

interface AgentCardListProps {
  /** The cards, in the shared order (useExtensionMessages' cards): agents'
   *  (AgentCard) and PC shells' (PcShellCard), by kind. */
  cards: Card[];
  /** A row (phone) or a column (desktop). */
  axis: CardAxis;
  /** The scroller's own classes and style: everything that differs per shell. */
  className: string;
  style?: CSSProperties;
  /** Persist a dragged order; absent where reordering is off (read-only office). */
  onReorder?: (order: number[]) => void;
  /** A touch tap on a card, with its touchend (see useCardReorder). */
  onTouchTap?: (agentId: number, e: TouchEvent) => void;
  /** The agent whose terminal pane is showing: accent border. */
  activeAgentId: number | null;
  /** The agent whose character is selected in the office: tinted. */
  focusedAgentId: number | null;
  /** Show the × only on the active card (phone), else on hover (cardBar.ts `closeMode`). */
  closeOnlyWhenActive?: boolean;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  onSelect: (card: Card) => void;
  onClose: (card: Card) => void;
  /** Drawn after the cards, in the same scroller (the desktop terminal's hide ribbon). */
  trailing?: ReactNode;
}

/**
 * The agent cards themselves, for both shells: the same cards in the same
 * (server-owned) order with the same reorder and the same highlight rules.
 * The phone lays them out as a row in its bottom bar, the desktop as a column
 * along the office's right edge; that layout is all the two wrappers add.
 */
export function AgentCardList({
  cards,
  axis,
  className,
  style,
  onReorder,
  onTouchTap,
  activeAgentId,
  focusedAgentId,
  closeOnlyWhenActive = false,
  getAppearance,
  statusFor,
  onSelect,
  onClose,
  trailing,
}: AgentCardListProps) {
  const ids = useMemo(() => cards.map((card) => card.id), [cards]);
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const reorder = useCardReorder({
    ids,
    axis,
    enabled: onReorder !== undefined,
    onCommit: (order) => onReorder?.(order),
    onTouchTap,
  });
  const { container, cardElement } = reorder;

  // Selecting a character on the canvas focuses an agent whose card may sit
  // outside the scroller: bring it fully into view.
  useEffect(() => {
    if (focusedAgentId === null) return;
    const card = cardElement(focusedAgentId);
    if (container && card) scrollIntoBar(container, card, axis);
  }, [focusedAgentId, axis, container, cardElement]);

  if (cards.length === 0) return null;

  return (
    <div ref={reorder.containerRef} className={className} style={style}>
      {reorder.displayIds.map((agentId) => {
        const card = byId.get(agentId);
        if (!card) return null;
        const variant = cardVariant(agentId, {
          activeId: activeAgentId,
          focusedId: focusedAgentId,
        });
        const close = closeMode(variant, closeOnlyWhenActive);
        const lifted = reorder.draggingId === agentId;
        return (
          <div
            key={agentId}
            ref={reorder.cardRef(agentId)}
            onTouchStart={reorder.onTouchStart(agentId)}
            onMouseDown={reorder.onMouseDown(agentId)}
            className={`shrink-0 flex items-stretch transition-transform ${
              lifted ? `relative z-10 opacity-70 ${LIFT[axis]}` : ''
            }`}
          >
            {card.kind === 'pcShell' ? (
              <PcShellCard
                shell={card.shell}
                variant={variant}
                close={close}
                onSelect={() => onSelect(card)}
                onClose={() => onClose(card)}
              />
            ) : (
              <AgentCard
                agentId={agentId}
                variant={variant}
                appearance={getAppearance(agentId)}
                status={statusFor(agentId)}
                close={close}
                onSelect={() => onSelect(card)}
                onClose={() => onClose(card)}
              />
            )}
          </div>
        );
      })}
      {trailing}
    </div>
  );
}

/** A lifted card steps out of the bar, toward the office. */
const LIFT: Record<CardAxis, string> = { x: '-translate-y-4', y: '-translate-x-4' };

/** Scroll the bar just enough to show the whole card, plus a margin. */
function scrollIntoBar(scroller: HTMLElement, card: HTMLElement, axis: CardAxis): void {
  const bar = scroller.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  const [start, end, barStart, barEnd] =
    axis === 'x'
      ? [rect.left, rect.right, bar.left, bar.right]
      : [rect.top, rect.bottom, bar.top, bar.bottom];
  const before = barStart + CARD_SCROLL_INTO_VIEW_MARGIN_PX - start;
  const after = end - (barEnd - CARD_SCROLL_INTO_VIEW_MARGIN_PX);
  const delta = before > 0 ? -before : after > 0 ? after : 0;
  if (delta === 0) return;
  scroller.scrollBy(
    axis === 'x' ? { left: delta, behavior: 'smooth' } : { top: delta, behavior: 'smooth' },
  );
}
