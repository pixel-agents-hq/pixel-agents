/**
 * Unit tests for onReconnect: every `connected` after the first is a
 * reconnect (the webview then asks for the snapshot again); the first one
 * only flushes what was queued.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { onReconnect } from '../src/transport/onReconnect.js';
import type { MessageTransport, TransportState } from '../src/transport/types.js';

function fakeTransport(initial: TransportState) {
  const handlers = new Set<(s: TransportState) => void>();
  const transport = {
    state: initial,
    onStateChange(h: (s: TransportState) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  } as unknown as MessageTransport;
  const emit = (s: TransportState) => {
    for (const h of handlers) h(s);
  };
  return { transport, emit, handlers };
}

test('connecting first: the first connect is not a reconnect, later ones are', () => {
  const { transport, emit } = fakeTransport('connecting');
  let calls = 0;
  onReconnect(transport, () => calls++);
  emit('connected');
  assert.equal(calls, 0);
  emit('reconnecting');
  assert.equal(calls, 0);
  emit('connected');
  assert.equal(calls, 1);
  emit('disconnected');
  emit('connected');
  assert.equal(calls, 2);
});

test('already connected: the next connect is a reconnect', () => {
  const { transport, emit } = fakeTransport('connected');
  let calls = 0;
  onReconnect(transport, () => calls++);
  emit('reconnecting');
  emit('connected');
  assert.equal(calls, 1);
});

test('unsubscribe stops the callbacks', () => {
  const { transport, emit, handlers } = fakeTransport('connected');
  let calls = 0;
  const off = onReconnect(transport, () => calls++);
  off();
  assert.equal(handlers.size, 0);
  emit('connected');
  assert.equal(calls, 0);
});
