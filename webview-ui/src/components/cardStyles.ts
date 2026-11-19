/** The card bar's shared looks, for an agent's card and a PC shell's alike. */

import type { CardVariant, CloseMode } from './cardBar.js';

/** The card's look per highlight tier (an agent's card and a PC shell's alike). */
export const CARD_VARIANT: Record<CardVariant, string> = {
  default: 'bg-btn-bg border-transparent hover:bg-btn-hover',
  focused: 'bg-active-bg border-transparent',
  active: 'bg-active-bg border-accent',
};

// `hover` fades with opacity rather than visibility, so the × stays a
// hit target (a pointer over it hovers the card anyway).
export const CLOSE_MODE: Record<CloseMode, string> = {
  shown: '',
  hover: 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity',
  hidden: 'invisible',
};
