import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  CONTROL_CLOSE_UNAUTHORIZED,
  CONTROL_SESSION_API_PATH,
  CONTROL_WS_PROTOCOL,
} from '../../core/src/constants.js';

// Isolated temp HOME so the server registry never touches real ~/.pixel-agents/.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Import AFTER the mock is registered.
const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');

/**
 * Open a /ws connection and classify the outcome. The server accepts the HTTP
 * upgrade (101) before its handler runs, so an unauthorized connection opens and
 * is then closed with CONTROL_CLOSE_UNAUTHORIZED — auth failure is signalled by
 * the CLOSE code, not by never opening. A short grace window distinguishes the
 * two: a close within it means rejected; silence means the socket stayed open
 * (authorized).
 */
function classifyWs(
  port: number,
  protocols: string[],
  options?: { headers?: Record<string, string> },
): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, options);
    let closeCode: number | null = null;
    ws.on('close', (code: number) => {
      closeCode = code;
    });
    ws.on('error', () => {
      // A close event always follows; classification happens in the timer.
    });
    setTimeout(() => {
      if (closeCode !== null) {
        resolve(closeCode);
      } else {
        ws.close();
        resolve('open');
      }
    }, 250);
  });
}

describe('/ws authentication (standalone)', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-wsauth-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
    const config = await server.start({
      embedded: false,
      host: '127.0.0.1',
      store: new AgentStateStore(),
    });
    port = config.port;
    token = config.token;
  });

  afterEach(() => {
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects a connection with no token', async () => {
    expect(await classifyWs(port, [])).toBe(CONTROL_CLOSE_UNAUTHORIZED);
  });

  it('rejects a wrong token carried as a subprotocol', async () => {
    expect(await classifyWs(port, [CONTROL_WS_PROTOCOL, 'not-the-token'])).toBe(
      CONTROL_CLOSE_UNAUTHORIZED,
    );
  });

  it('accepts the valid token carried as a subprotocol (browser path)', async () => {
    expect(await classifyWs(port, [CONTROL_WS_PROTOCOL, token])).toBe('open');
  });

  it('accepts the valid token as an Authorization header (non-browser path)', async () => {
    expect(await classifyWs(port, [], { headers: { Authorization: `Bearer ${token}` } })).toBe(
      'open',
    );
  });

  it('rejects a wrong Authorization header', async () => {
    expect(await classifyWs(port, [], { headers: { Authorization: 'Bearer nope' } })).toBe(
      CONTROL_CLOSE_UNAUTHORIZED,
    );
  });
});

describe('control session token endpoint (standalone)', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-wsauth-sess-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
    const config = await server.start({
      embedded: false,
      host: '127.0.0.1',
      store: new AgentStateStore(),
    });
    port = config.port;
    token = config.token;
  });

  afterEach(() => {
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('hands the token to a same-origin request (no Origin header)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}${CONTROL_SESSION_API_PATH}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toBe(token);
  });

  it('refuses a cross-origin request', async () => {
    const res = await fetch(`http://127.0.0.1:${port}${CONTROL_SESSION_API_PATH}`, {
      headers: { Origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
  });
});
