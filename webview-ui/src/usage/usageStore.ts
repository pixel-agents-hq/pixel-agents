/**
 * The usage meter's client state (usageModel.ts reduces it), outside React so
 * the server room display and the Settings toggle read it without props. Fed
 * from the transport at module load, like the signal store, so the connect
 * snapshot is never missed.
 */

import { useSyncExternalStore } from 'react';

import { transport } from '../transport/index.js';
import type { UsageMeterClientState } from './usageModel.js';
import { INITIAL_USAGE_STATE, isUsageMessage, reduceUsageMessage } from './usageModel.js';

let state: UsageMeterClientState = INITIAL_USAGE_STATE;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState(): UsageMeterClientState {
  return state;
}

transport.onMessage((msg) => {
  if (!isUsageMessage(msg)) return;
  state = reduceUsageMessage(state, msg);
  for (const l of listeners) l();
});

export function useUsageMeter(): UsageMeterClientState {
  return useSyncExternalStore(subscribe, getState);
}

/** Install or remove the meter's status line. No optimistic update: the
 *  server answers with the actual state (it refuses a status line of the
 *  user's own). */
export function setUsageMeterEnabled(enabled: boolean): void {
  transport.send({ type: 'setUsageMeterEnabled', enabled });
}
