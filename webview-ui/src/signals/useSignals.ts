import './feed.js';

import { useSyncExternalStore } from 'react';

import { type SignalsSnapshot, signalStore } from './signalStore.js';

/** The current signals; re-renders on every change. */
export function useSignals(): SignalsSnapshot {
  return useSyncExternalStore(signalStore.subscribe, signalStore.getSnapshot);
}
