import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';
import { buildWebSocketUrl, WebSocketTransport } from './webSocketTransport.js';

declare global {
  interface Window {
    pixelAgentsBridge?: {
      launchAgent: (folderPath: string | undefined, bypassPermissions: boolean | undefined) => void;
    };
  }
}

/**
 * JetBrains transport: routes launchAgent to the native IDE bridge (JBCefJSQuery)
 * and all other messages to the standalone server via WebSocket.
 */
export class JetBrainsTransport implements MessageTransport {
  private readonly ws: WebSocketTransport;
  private pendingLaunchAgents: Array<{
    folderPath: string | undefined;
    bypassPermissions: boolean | undefined;
  }> = [];

  constructor() {
    this.ws = new WebSocketTransport(buildWebSocketUrl());
    this.ws.connect();
  }

  send(message: ClientMessage): void {
    if (message.type === 'launchAgent') {
      if (window.pixelAgentsBridge) {
        this.flushPending();
        window.pixelAgentsBridge.launchAgent(message.folderPath, message.bypassPermissions);
      } else {
        console.warn('[JetBrains] Bridge not ready, queuing launchAgent');
        this.pendingLaunchAgents.push({
          folderPath: message.folderPath,
          bypassPermissions: message.bypassPermissions,
        });
        this.waitForBridge();
      }
      return;
    }
    this.ws.send(message);
  }

  private waitForBridge(): void {
    const interval = setInterval(() => {
      if (window.pixelAgentsBridge) {
        clearInterval(interval);
        this.flushPending();
      }
    }, 100);
    // Stop polling after 10s to avoid memory leak
    setTimeout(() => clearInterval(interval), 10_000);
  }

  private flushPending(): void {
    const pending = this.pendingLaunchAgents.splice(0);
    for (const p of pending) {
      window.pixelAgentsBridge?.launchAgent(p.folderPath, p.bypassPermissions);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    return this.ws.onMessage(handler);
  }

  dispose(): void {
    this.ws.dispose();
  }
}
