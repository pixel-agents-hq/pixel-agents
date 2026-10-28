import { WS_RECONNECT_DELAYS_MS } from '../constants.js';

/**
 * The ONE reconnect ladder for every socket the SPA opens -- the /ws control
 * transport and each agent's terminal socket. `attempt` is zero-based; the
 * last rung repeats forever, so a long outage keeps polling at the cap.
 */
export function reconnectDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), WS_RECONNECT_DELAYS_MS.length - 1);
  return WS_RECONNECT_DELAYS_MS[index];
}
