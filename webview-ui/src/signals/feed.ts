/**
 * Feeds the transport's server messages into the signal store, from module load
 * on, so the connect-time snapshot (sent right after webviewReady) is never
 * missed. Imported by the signal components; one subscription for the app.
 */

import { transport } from '../transport/index.js';
import { signalStore } from './signalStore.js';

transport.onMessage((msg) => {
  signalStore.apply(msg as unknown as Record<string, unknown>);
});

/** Ask the server for one agent's timeline (allowed for read-only offices). */
export function requestTimeline(id: number): void {
  transport.send({ type: 'requestTimeline', id });
}
