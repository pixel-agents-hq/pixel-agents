import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { WS_CLOSE_FORBIDDEN_ORIGIN, WS_CLOSE_UNAUTHORIZED } from '../src/constants.js';

// Isolated temp HOME: the server writes ~/.pixel-agents/{server.json,servers/}
// and the consent assertions below read ~/.pixel-agents/config.json.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { grantHooksConsent } = await import('../src/configPersistence.js');

/** How long to wait, after the handshake, for a server-side rejection close.
 *  The gate runs synchronously in the route handler, so a rejection lands
 *  immediately; this is slack, not a real delay. */
const SETTLE_MS = 750;

interface ConnectResult {
  /** True when the connection survived the server's gate. */
  accepted: boolean;
  /** Close code, when the server closed us instead. */
  closeCode?: number;
  socket: WebSocket;
}

/**
 * Open a /ws socket and report whether the server KEPT it. `@fastify/websocket`
 * completes the HTTP upgrade before the route handler runs, so a rejected
 * connection still fires 'open' and is then closed with an application close
 * code — "accepted" therefore means "still open after the settle window", not
 * "'open' fired". (The handler returns before registering its 'message'
 * listener, so a rejected socket can never have a message processed.)
 */
function connect(port: number, headers: Record<string, string> = {}): Promise<ConnectResult> {
  return connectTo(`ws://127.0.0.1:${port.toString()}/ws`, headers);
}

/** Same as connect(), for a URL the caller builds — a `localhost` host. */
function connectTo(url: string, headers: Record<string, string> = {}): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    let closeCode: number | undefined;
    const failTimer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for the /ws handshake to settle'));
    }, 5_000);
    const settle = (): void => {
      clearTimeout(failTimer);
      resolve({ accepted: closeCode === undefined, closeCode, socket });
    };
    socket.on('open', () => setTimeout(settle, SETTLE_MS));
    socket.on('close', (code: number) => {
      closeCode = code;
      settle();
    });
    socket.on('error', () => {
      /* a server-side close surfaces as 'close'; ignore the paired error */
    });
  });
}

/** Wait for one JSON message of the given type (or resolve null on timeout). */
function waitForMessage(socket: WebSocket, type: string, ms = 2_000): Promise<unknown | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === type) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });
  });
}

function readHooksConsent(): boolean {
  try {
    const raw = fs.readFileSync(path.join(tmpBase, '.pixel-agents', 'config.json'), 'utf-8');
    const consent = (JSON.parse(raw) as { hooksConsent?: Record<string, string> }).hooksConsent;
    return consent?.claude === 'granted';
  } catch {
    return false;
  }
}

describe('/ws connection gate', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-test-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startStandalone(): Promise<{ port: number }> {
    const config = await server.start({
      embedded: false,
      store: new AgentStateStore(),
      // Mirrors the standalone CLI's own side effect (server/src/cli.ts): an
      // enable toggle over this socket IS the consent grant. Wired here so the
      // cross-origin test asserts the real effect, not just a close code.
      onSetHooksEnabled: async (providerId: string, enabled: boolean) => {
        if (enabled) grantHooksConsent(providerId);
      },
    });
    return { port: config.port };
  }

  // 1. THE finding: a WebSocket connect is not blocked by CORS, so a page the
  //    user happens to be visiting could open /ws and grant durable consent to
  //    modify ~/.claude/settings.json. A forged Origin must be refused, and no
  //    message it sends may take effect.
  it('rejects a cross-origin standalone connection and its setHooksEnabled', async () => {
    const { port } = await startStandalone();

    const result = await connect(port, { Origin: 'http://evil.example' });
    sockets.push(result.socket);

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(WS_CLOSE_FORBIDDEN_ORIGIN);

    // Even if the attacker keeps writing, nothing is processed.
    try {
      result.socket.send(
        JSON.stringify({ type: 'setHooksEnabled', providerId: 'claude', enabled: true }),
      );
    } catch {
      /* socket already closed — that IS the point */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readHooksConsent()).toBe(false);
  });

  // 2. The SPA's own origin (what the browser sends after loading the page from
  //    this very server) connects normally.
  it('accepts a same-origin standalone connection', async () => {
    const { port } = await startStandalone();

    const result = await connect(port, { Origin: `http://127.0.0.1:${port.toString()}` });
    sockets.push(result.socket);

    expect(result.accepted).toBe(true);

    // And the channel actually works: webviewReady gets a handshake back.
    const settled = waitForMessage(result.socket, 'hooksStatus');
    result.socket.send(JSON.stringify({ type: 'webviewReady' }));
    expect(await settled).not.toBeNull();
  });

  // 3. A non-browser client (no Origin header) still CONNECTS.
  it('accepts a standalone connection with no Origin header', async () => {
    const { port } = await startStandalone();

    const result = await connect(port);
    sockets.push(result.socket);

    expect(result.accepted).toBe(true);
  });

  // 4. An unparseable Origin is not a same-origin browser request.
  it('rejects a standalone connection with a malformed Origin', async () => {
    const { port } = await startStandalone();

    const result = await connect(port, { Origin: 'not a url' });
    sockets.push(result.socket);

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(WS_CLOSE_FORBIDDEN_ORIGIN);
  });

  // 5. Embedded mode is Bearer-gated and unchanged by the Origin gate: a
  //    same-origin-looking connection without the token is still refused.
  it('rejects an embedded connection without the Bearer token', async () => {
    const config = await server.start({ embedded: true, store: new AgentStateStore() });

    const result = await connect(config.port, {
      Origin: `http://127.0.0.1:${config.port.toString()}`,
    });
    sockets.push(result.socket);

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  // 6. Embedded + correct token connects, and no Origin gate is applied there
  //    (the VS Code webview's Origin is a vscode-webview:// URL, never our host).
  it('accepts an embedded connection with the Bearer token and a foreign Origin', async () => {
    const config = await server.start({ embedded: true, store: new AgentStateStore() });

    const result = await connect(config.port, {
      Authorization: `Bearer ${config.token}`,
      Origin: 'vscode-webview://some-webview-id',
    });
    sockets.push(result.socket);

    expect(result.accepted).toBe(true);
  });
});

/**
 * Every connection the gate above admits has full control: a consent-bearing
 * message (`setHooksEnabled`, or the consent dialog's `hooksConsentResponse`)
 * takes effect with no token. These tests assert on the install seam plus the
 * on-disk consent flag.
 */
describe('/ws messages (standalone)', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  const sockets: WebSocket[] = [];
  /** Values `onSetHooksEnabled` was invoked with — the install/uninstall seam. */
  let sideEffects: boolean[];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-msg-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    sideEffects = [];
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startStandalone(): Promise<{ port: number }> {
    const config = await server.start({
      embedded: false,
      store: new AgentStateStore(),
      // The real cli.ts side effect, minus the actual install: an enable
      // toggle over this socket IS the consent grant (server/src/cli.ts).
      onSetHooksEnabled: (providerId: string, enabled: boolean) => {
        sideEffects.push(enabled);
        if (enabled) grantHooksConsent(providerId);
      },
    });
    return { port: config.port };
  }

  /** Send setHooksEnabled over an accepted socket and let it settle. */
  async function sendToggle(socket: WebSocket, enabled: boolean): Promise<void> {
    socket.send(JSON.stringify({ type: 'setHooksEnabled', providerId: 'claude', enabled }));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  it('allows setHooksEnabled from the local SPA', async () => {
    const { port } = await startStandalone();

    const result = await connectTo(`ws://127.0.0.1:${port.toString()}/ws`, {
      Origin: `http://127.0.0.1:${port.toString()}`,
    });
    sockets.push(result.socket);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });

  // ...and over `localhost`, which resolves to ::1 as often as 127.0.0.1.
  it('allows setHooksEnabled over a localhost URL', async () => {
    const { port } = await startStandalone();

    const result = await connectTo(`ws://localhost:${port.toString()}/ws`, {
      Origin: `http://localhost:${port.toString()}`,
    });
    sockets.push(result.socket);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });

  // The first-run ask is solicited by the server during the webviewReady
  // handshake.
  it('sends hooksConsentRequest on the handshake', async () => {
    const { port } = await startStandalone();

    const result = await connect(port, { Origin: `http://127.0.0.1:${port.toString()}` });
    sockets.push(result.socket);

    const request = waitForMessage(result.socket, 'hooksConsentRequest');
    result.socket.send(JSON.stringify({ type: 'webviewReady' }));
    expect(await request).toMatchObject({ type: 'hooksConsentRequest' });
  });

  // The route the dialog exists for: the Install button grants consent and runs
  // the install, end to end over the real wire.
  it('accepts the dialog approval: install runs and consent is granted', async () => {
    const { port } = await startStandalone();

    const result = await connect(port, { Origin: `http://127.0.0.1:${port.toString()}` });
    sockets.push(result.socket);

    result.socket.send(
      JSON.stringify({ type: 'hooksConsentResponse', providerId: 'claude', choice: 'install' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });
});
