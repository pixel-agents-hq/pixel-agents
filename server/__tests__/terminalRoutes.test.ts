/**
 * Terminal endpoint.
 *
 * `/terminal/:agentId` is arbitrary code execution -- these tests pin the
 * same-origin check and the attach-only behaviour, from a real WebSocket client
 * against a real server.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Named import: `ws` is CJS, and the server tsconfig's Node16 resolution has no
// allowSyntheticDefaultImports, so the default import form won't typecheck.
// `ws` rather than Node's built-in WebSocket because the foreign-origin test
// must set an Origin header, which the built-in client cannot do.
import { WebSocket } from 'ws';

import { WS_CLOSE_FORBIDDEN_ORIGIN, WS_CLOSE_NO_SESSION } from '../src/constants.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';

let tmpBase: string;

// Isolated HOME: server.start() writes server.json + the registry entry, and a
// test must never touch the developer's real ~/.pixel-agents.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Imported after the os mock is registered, so server.ts picks up the temp HOME.
const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');

/** Minimal fake PTY -- no real process is ever spawned by these tests. */
class FakePty implements IPty {
  readonly pid = 1;
  private dataListener: ((d: string) => void) | null = null;
  written: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  onData(l: (d: string) => void): void {
    this.dataListener = l;
  }
  onExit(): void {
    /* never exits in these tests */
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    /* no-op */
  }
  emit(d: string): void {
    this.dataListener?.(d);
  }
}

let lastPty: FakePty;

function fakeManager(): PtySessionManager {
  const module: PtyModule = {
    spawn: () => {
      lastPty = new FakePty();
      return lastPty;
    },
  };
  return new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
}

interface Attempt {
  code: number;
  opened: boolean;
}

function terminalUrl(port: number, agentId: number): string {
  return `ws://127.0.0.1:${String(port)}/terminal/${String(agentId)}`;
}

/** Connect and resolve how the server responded (opened, or closed with a code). */
function attach(port: number, agentId: number, origin?: string): Promise<Attempt> {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      terminalUrl(port, agentId),
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );
    let opened = false;
    ws.on('open', () => {
      opened = true;
    });
    ws.on('close', (code: number) => resolve({ code, opened }));
    ws.on('error', () => {
      // A close-during-handshake surfaces as an error in ws; the close handler
      // still fires with the code, so let it settle there.
    });
    setTimeout(() => reject(new Error('terminal socket timed out')), 5_000);
  });
}

describe('terminal WebSocket', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let ptyManager: PtySessionManager;
  let port: number;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-terminal-test-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
    ptyManager = fakeManager();
    const config = await server.start({
      store: new AgentStateStore(),
      embedded: false,
      ptyManager,
    });
    port = config.port;
    ptyManager.create({ agentId: 1, command: 'claude', args: [], cwd: tmpBase });
  });

  afterEach(() => {
    void ptyManager?.disposeAll();
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('accepts a same-origin connection', async () => {
    const ws = new WebSocket(terminalUrl(port, 1));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects a connection from a foreign origin', async () => {
    // Any web page can open a WebSocket to localhost (WS is exempt from CORS).
    const result = await attach(port, 1, 'http://evil.com');
    expect(result.code).toBe(WS_CLOSE_FORBIDDEN_ORIGIN);
  });

  it('rejects attaching to an agent with no terminal', async () => {
    // The route can only attach to PTYs this server spawned; it can never start one.
    const result = await attach(port, 999);
    expect(result.code).toBe(WS_CLOSE_NO_SESSION);
  });

  it('sends a serialized replay snapshot first, then the live stream', async () => {
    // Pre-attach output must arrive as screen state inside the replay frame
    // (not as raw output — a byte ring garbles a reattaching TUI), and only
    // post-attach output may flow as live output frames.
    lastPty.emit('before-attach\r\n');

    const ws = new WebSocket(terminalUrl(port, 1));
    const frames: Array<Record<string, unknown>> = [];
    const secondFrame = new Promise<void>((resolve, reject) => {
      ws.on('message', (raw: Buffer | string) => {
        frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        if (frames.length === 1) lastPty.emit('after-attach');
        if (frames.length === 2) resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timed out waiting for terminal frames')), 5_000);
    });
    await secondFrame;
    ws.close();

    expect(frames[0].type).toBe('replay');
    expect(String(frames[0].data)).toContain('before-attach');
    expect(frames[0].cols).toBeTypeOf('number');
    expect(frames[0].rows).toBeTypeOf('number');
    expect(frames[1]).toEqual({ type: 'output', data: 'after-attach' });
  });
});
