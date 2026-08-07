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

/**
 * Same as connect(), for a URL the caller builds — a `localhost` host, or one
 * carrying (or deliberately omitting) the `?token=` privilege query.
 */
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
    return (JSON.parse(raw) as { hooksConsentGiven?: boolean }).hooksConsentGiven === true;
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
      // cross-origin test asserts the real privilege, not just a close code.
      onSetHooksEnabled: async (enabled: boolean) => {
        if (enabled) grantHooksConsent();
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
      result.socket.send(JSON.stringify({ type: 'setHooksEnabled', enabled: true }));
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

  // 3. A non-browser client (no Origin header) still CONNECTS — watching the
  //    office is the standalone server's job, and `--host` exposing it to the
  //    LAN is documented. What it must not do is grant consent; see the
  //    privileged-message tests below.
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
 * The CONNECTION gate above is necessary but not sufficient: what it admits can
 * still reach `grantHooksConsent()` — durable, machine-wide approval to modify
 * ~/.claude/settings.json plus a 12-event hook install.
 *
 * Privilege is therefore decided by the server token carried in the handshake's
 * `?token=` query (httpServer's standaloneTokenValid), never by a network
 * position. Position was the previous model — loopback peer AND loopback Host —
 * and it fell to a dumb LAN-bound TCP forwarder piping bytes verbatim to
 * 127.0.0.1, which presents the server exactly what the local SPA presents.
 * Reproduced against the real `dist/cli.js`: a client on another machine got
 * `consent=true` and 12 installed hook events. The forwarded attacker never has
 * the token, because the token reaches the SPA only through the URL the CLI
 * printed in the operator's own terminal.
 *
 * Every test below sends the real `setHooksEnabled` message and asserts on the
 * install seam plus the on-disk consent flag. The socket stays OPEN throughout —
 * a tokenless viewer keeps watching the office; it just cannot approve a change
 * to a file in someone's home directory.
 */
describe('/ws privileged-message gate', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  const sockets: WebSocket[] = [];
  /** Values `onSetHooksEnabled` was invoked with — the install/uninstall seam. */
  let sideEffects: boolean[];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-priv-'));
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

  async function startStandalone(): Promise<{ port: number; token: string }> {
    const config = await server.start({
      embedded: false,
      store: new AgentStateStore(),
      // The real cli.ts side effect, minus the actual install: an enable
      // toggle over this socket IS the consent grant (server/src/cli.ts).
      onSetHooksEnabled: (enabled: boolean) => {
        sideEffects.push(enabled);
        if (enabled) grantHooksConsent();
      },
    });
    return { port: config.port, token: config.token };
  }

  /** Send setHooksEnabled over an accepted socket and let it settle. */
  async function sendToggle(socket: WebSocket, enabled: boolean): Promise<void> {
    socket.send(JSON.stringify({ type: 'setHooksEnabled', enabled }));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // KNOWN-BAD FIXTURE 1 — DNS rebinding, on the DEFAULT loopback bind.
  // `evil.com` re-resolved to 127.0.0.1: the browser sends Origin AND Host as
  // `evil.com:PORT`, both attacker-controlled, so the CONNECTION gate's equality
  // check passes and the peer address is genuinely loopback. What the rebound
  // page never receives is the token — it reached our origin by name, not by the
  // URL the CLI printed — so the consent-bearing message is refused.
  it('refuses setHooksEnabled from a rebound (Origin === Host) connection', async () => {
    const { port } = await startStandalone();
    const forged = `evil.example:${port.toString()}`;

    const result = await connect(port, { Origin: `http://${forged}`, Host: forged });
    sockets.push(result.socket);

    // The connection gate passes — that is precisely the residual.
    expect(result.accepted).toBe(true);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([]);
    expect(readHooksConsent()).toBe(false);
  });

  // KNOWN-BAD FIXTURE 2 — the loopback-terminating forwarder that broke the
  // previous peer-address model. A dumb LAN-bound TCP proxy piping bytes to
  // 127.0.0.1 makes the server see a loopback peer, and the remote client
  // forges a loopback Host — the exact pair the old gate accepted, reproduced
  // against the real dist/cli.js (consent=true, 12 events installed). No token
  // rides the handshake, because the operator's URL never left their terminal.
  it('refuses setHooksEnabled from a loopback-terminating forwarder', async () => {
    const { port } = await startStandalone();

    const result = await connectTo(`ws://127.0.0.1:${port.toString()}/ws`, {
      Host: `localhost:${port.toString()}`,
      Origin: `http://localhost:${port.toString()}`,
    });
    sockets.push(result.socket);

    // Still watching the office — only the privileged message is withheld.
    expect(result.accepted).toBe(true);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([]);
    expect(readHooksConsent()).toBe(false);
  });

  // The untokened local session: someone typed the bare http://127.0.0.1:PORT/
  // instead of opening the printed URL. Read-only by construction — a graceful
  // degrade, not a disconnect.
  it('refuses setHooksEnabled without a token', async () => {
    const { port } = await startStandalone();

    const result = await connectTo(`ws://127.0.0.1:${port.toString()}/ws`, {
      Origin: `http://127.0.0.1:${port.toString()}`,
    });
    sockets.push(result.socket);

    expect(result.accepted).toBe(true);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([]);
    expect(readHooksConsent()).toBe(false);
  });

  // A guessed/stale token is no token. (The comparison is constant-time, but
  // what this pins is the outcome: wrong secret, no privilege.)
  it('refuses setHooksEnabled with a wrong token', async () => {
    const { port } = await startStandalone();

    const result = await connectTo(`ws://127.0.0.1:${port.toString()}/ws?token=not-the-token`, {
      Origin: `http://127.0.0.1:${port.toString()}`,
    });
    sockets.push(result.socket);

    expect(result.accepted).toBe(true);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([]);
    expect(readHooksConsent()).toBe(false);
  });

  // The route this gate exists to keep working: the real local SPA, loaded from
  // the tokened URL the CLI printed, forwarding that token on the handshake
  // (webview-ui/src/transport/index.ts). The toggle installs, exactly as
  // documented ("enable hooks in the UI settings").
  it('allows setHooksEnabled from the local SPA', async () => {
    const { port, token } = await startStandalone();

    const result = await connectTo(
      `ws://127.0.0.1:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://127.0.0.1:${port.toString()}` },
    );
    sockets.push(result.socket);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });

  // ...and over `localhost`, which resolves to ::1 as often as 127.0.0.1.
  it('allows setHooksEnabled over a localhost URL', async () => {
    const { port, token } = await startStandalone();

    const result = await connectTo(
      `ws://localhost:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://localhost:${port.toString()}` },
    );
    sockets.push(result.socket);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });
});
