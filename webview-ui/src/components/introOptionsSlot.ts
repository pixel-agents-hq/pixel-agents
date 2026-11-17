import { createContext } from 'react';

/** Where a step's `inline` options go: the foot of the dialog box (IntroDialog provides it). */
export const IntroOptionsSlot = createContext<HTMLElement | null>(null);

/** Under the dialog box, centred in the space between it and the office's foot:
 *  where a step's error is said (IntroDialog provides it). */
export const IntroBelowSlot = createContext<HTMLElement | null>(null);
