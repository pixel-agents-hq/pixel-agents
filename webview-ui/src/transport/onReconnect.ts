import type { MessageTransport } from './types.js';

/**
 * Run `cb` on every `connected` after the first: each reconnect. The first
 * connect (already up when this is called, or the first one reached) only
 * flushes what was queued before it, so it never calls back.
 * Returns the unsubscribe.
 */
export function onReconnect(transport: MessageTransport, cb: () => void): () => void {
  let connectedBefore = transport.state === 'connected';
  return transport.onStateChange((state) => {
    if (state !== 'connected') return;
    if (connectedBefore) cb();
    connectedBefore = true;
  });
}
