import { useSyncExternalStore } from 'react';

import { officeRadio, type RadioState } from './musicEngine.js';

/** The office radio's state, re-rendering on every change. */
export function useOfficeRadio(): RadioState {
  return useSyncExternalStore(officeRadio.subscribe, officeRadio.getState);
}
