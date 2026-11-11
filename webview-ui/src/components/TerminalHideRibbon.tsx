import type { CSSProperties } from 'react';

import {
  AGENT_CARD_HEIGHT_PX,
  AGENT_CARD_WIDTH_PX,
  TERMINAL_HIDE_RIBBON_REST_RATIO,
  TERMINAL_SIDEBAR_WIDTH_PX,
} from '../constants.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface TerminalHideRibbonProps {
  /** The terminal panel is open: the ribbon shows (it fades with the panel). */
  shown: boolean;
  onHide: () => void;
}

/**
 * Hides the desktop terminal panel: the card bar's last item, right below the
 * cards, like one more card. Pushed to the bar's right edge, which is the
 * panel's left border, with the panel's background and no right border of its
 * own, so the border runs past it unbroken and it reads as a ribbon coming
 * from behind the terminal. At rest it is faded and shorter than a card;
 * hovered, it stretches out to the cards' left edge.
 */
export function TerminalHideRibbon({ shown, onHide }: TerminalHideRibbonProps) {
  const style = {
    height: AGENT_CARD_HEIGHT_PX,
    '--ribbon-rest': `${AGENT_CARD_WIDTH_PX * TERMINAL_HIDE_RIBBON_REST_RATIO}px`,
    // From the bar's right edge to the cards' left edge (a card is centred).
    '--ribbon-full': `${(TERMINAL_SIDEBAR_WIDTH_PX + AGENT_CARD_WIDTH_PX) / 2}px`,
  } as CSSProperties;
  return (
    <div
      className={`self-end shrink-0 transition-opacity duration-200 ${
        shown ? 'pointer-events-auto' : 'opacity-0'
      }`}
    >
      <button
        type="button"
        onClick={onHide}
        title="Hide terminal"
        aria-label="Hide terminal"
        tabIndex={shown ? undefined : -1}
        className="flex items-center justify-center bg-bg text-text-muted hover:text-text border-2 border-r-0 border-border rounded-none cursor-pointer p-0 opacity-60 hover:opacity-100 w-(--ribbon-rest) hover:w-(--ribbon-full) transition-[opacity,width] duration-200 ease-out"
        style={style}
      >
        <PixelIcon name="hide" />
      </button>
    </div>
  );
}
