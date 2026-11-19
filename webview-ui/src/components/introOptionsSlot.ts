import { createContext } from 'react';

/** Where a step's `inline` options go: the foot of the dialog box (IntroDialog provides it). */
export const IntroOptionsSlot = createContext<HTMLElement | null>(null);
