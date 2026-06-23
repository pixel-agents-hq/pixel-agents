import type { ClientMessage, ServerMessage } from './messages.js';

/**
 * Transport-agnostic message layer between webview and extension/server.
 *
 * Implementations:
 * - PostMessageTransport: VS Code webview (acquireVsCodeApi)
 * - WebSocketTransport: standalone browser (future)
 */
export interface MessageTransport {
  /** Send a message to the extension/server. */
  send(message: ClientMessage): void;
  /** Subscribe to messages from the extension/server. Returns unsubscribe function. */
  onMessage(handler: (message: ServerMessage) => void): () => void;
  /** Clean up resources (WebSocket close, etc.). */
  dispose(): void;
}
