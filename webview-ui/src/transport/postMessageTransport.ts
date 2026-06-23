import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

/**
 * VS Code webview transport. Uses acquireVsCodeApi().postMessage for sends
 * and window 'message' events for receives.
 */
export class PostMessageTransport implements MessageTransport {
  private readonly vscodeApi: { postMessage(msg: unknown): void };

  constructor() {
    this.vscodeApi = acquireVsCodeApi();
  }

  send(message: ClientMessage): void {
    this.vscodeApi.postMessage(message);
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data as ServerMessage);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  dispose(): void {
    // No cleanup needed for postMessage
  }
}
