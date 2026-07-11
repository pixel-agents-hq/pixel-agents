import { TRANSPORT_STATE_CONNECTED } from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport, TransportState } from './types.js';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

/**
 * VS Code webview transport. Uses acquireVsCodeApi().postMessage for sends
 * and window 'message' events for receives.
 *
 * The postMessage channel has no connection lifecycle, so it reports `connected`
 * for its entire lifetime: `ready` is already resolved and `onStateChange` never
 * fires (the no-op subscription keeps the MessageTransport interface total).
 */
export class PostMessageTransport implements MessageTransport {
  private readonly vscodeApi: { postMessage(msg: unknown): void };
  readonly state: TransportState = TRANSPORT_STATE_CONNECTED;
  readonly ready: Promise<void> = Promise.resolve();

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

  onStateChange(): () => void {
    // State never changes; return a no-op unsubscribe.
    return () => {};
  }

  dispose(): void {
    // No cleanup needed for postMessage
  }
}
