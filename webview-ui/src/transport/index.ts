import { isBrowserRuntime, isJetBrainsRuntime } from '../runtime.js';
import { JetBrainsTransport } from './jetbrainsTransport.js';
import { PostMessageTransport } from './postMessageTransport.js';
import type { MessageTransport } from './types.js';
import { buildWebSocketUrl, WebSocketTransport } from './webSocketTransport.js';

function createTransport(): MessageTransport {
  if (isJetBrainsRuntime) {
    return new JetBrainsTransport();
  }
  if (!isBrowserRuntime) {
    return new PostMessageTransport();
  }
  // Standalone browser: connect via WebSocket to the same host serving the SPA
  const ws = new WebSocketTransport(buildWebSocketUrl());
  ws.connect();
  return ws;
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
