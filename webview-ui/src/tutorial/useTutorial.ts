import { useSyncExternalStore } from 'react';

import { transport } from '../transport/index.js';
import { subscribeTutorial, type TutorialEntry, tutorialEntry } from './tutorialStore.js';

export interface TutorialControls extends TutorialEntry {
  /** The permission step's yes, once the greeter sat: launch the Guide wearing `palette`, in `seatId`. */
  start: (palette: number, seatId?: string) => void;
  skip: (questId: string) => void;
  /** End the run; the server closes the Guide's session. */
  quit: () => void;
}

/** The tutorial's state and the messages that move it (tutorialStore.ts). */
export function useTutorial(): TutorialControls {
  const entry = useSyncExternalStore(subscribeTutorial, tutorialEntry);
  return {
    ...entry,
    start: (palette, seatId) =>
      transport.send({ type: 'startTutorial', palette, ...(seatId ? { seatId } : {}) }),
    skip: (questId) => transport.send({ type: 'skipTutorialQuest', questId }),
    quit: () => transport.send({ type: 'quitTutorial' }),
  };
}
