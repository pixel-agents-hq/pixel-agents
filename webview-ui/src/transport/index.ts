import type { ServerMessage } from '../../../core/src/messages.js';
import { isBrowserRuntime } from '../runtime.js';
import { PostMessageTransport } from './postMessageTransport.js';
import { serverToken } from './serverToken.js';
import { socketUrl } from './socketUrl.js';
import type { MessageTransport } from './types.js';
import { WebSocketTransport } from './webSocketTransport.js';

function createTransport(): MessageTransport {
  if (!isBrowserRuntime) {
    return new PostMessageTransport();
  }
  // Standalone browser: connect via WebSocket to the same host serving the SPA.
  // The server token rides the handshake query when this page was opened from
  // the tokened URL the CLI printed — that is what makes the session privileged
  // enough to approve a hook install (server/src/httpServer.ts). Without it the
  // socket still connects and the office still renders; only the hooks toggle
  // is refused (so is launching an agent or attaching to its terminal, which
  // read the same token from serverToken.ts). WebSocketTransport captures the
  // url once, so the token survives reconnects even if the address bar is later
  // cleared.
  // Resolved against the page's base URL so a reverse proxy can mount the SPA
  // at a sub-path (socketUrl.ts).
  const wsUrl = socketUrl('ws', document.baseURI, serverToken);
  const ws = new WebSocketTransport(wsUrl);
  // Vite dev only: there is no server to connect to, so `browserMock` injects
  // ServerMessages as `window` 'message' events. Bridge them into the transport
  // and DON'T open a real socket — there is no /ws on the Vite dev server, so
  // the transport would loop on reconnect. Guarded by DEV so it's tree-shaken
  // out of the production standalone build. Exactly ONE connect() call must
  // remain: WebSocketTransport has no guard, and a second call orphans a live
  // socket whose handlers keep delivering every broadcast a second time.
  if (import.meta.env.DEV) {
    window.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as unknown;
      if (
        data &&
        typeof data === 'object' &&
        typeof (data as { type?: unknown }).type === 'string'
      ) {
        ws.deliver(data as ServerMessage);
      }
    });
  } else {
    ws.connect();
  }
  return ws;
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
