/** P4：agentGuardStatus 走完整的 /ws 握手；內嵌（VS Code）伺服器忽略 reporter，唯讀客戶端收得到。 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createAgentState } = await import('../src/agentState.js');
const { WriteGuard } = await import('../src/writeGuard/writeGuard.js');
const { GuardStatusReporter } = await import('../src/writeGuard/guardStatusReporter.js');

const SETTLE_MS = 600;

/** Open /ws, send webviewReady, and collect every message for a short window. */
function handshake(
  port: number,
  headers: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port.toString()}/ws`, { headers });
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (data: Buffer) => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    });
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'webviewReady' }));
      setTimeout(() => {
        socket.terminate();
        resolve(messages);
      }, SETTLE_MS);
    });
    socket.on('error', reject);
  });
}

let server: InstanceType<typeof PixelAgentsServer>;
let store: InstanceType<typeof AgentStateStore>;
let guard: InstanceType<typeof WriteGuard>;
let reporter: InstanceType<typeof GuardStatusReporter>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-status-srv-'));
  fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
  server = new PixelAgentsServer();
  store = new AgentStateStore();
  guard = new WriteGuard({ store, ptyManager: { has: () => true } });
  reporter = new GuardStatusReporter({
    store,
    ptyManager: { has: () => true },
    guard,
    curators: { curatorOf: () => null },
    broadcast: () => {},
    probeChain: () => ({ hooksInstalled: true, preToolUsePresent: true, scriptPresent: true }),
  });
  store.set(
    1,
    createAgentState({
      id: 1,
      sessionId: 's1',
      projectDir: tmpBase,
      jsonlFile: path.join(tmpBase, 's1.jsonl'),
      isExternal: false,
      permissionRoles: ['R'],
    }),
  );
});

afterEach(() => {
  reporter.dispose();
  guard.dispose();
  server.stop();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('agentGuardStatus over /ws', () => {
  it('standalone: a client gets the status after existingAgents', async () => {
    const config = await server.start({
      embedded: false,
      store,
      writeGuard: guard,
      guardStatus: reporter,
    });
    const messages = await handshake(config.port, {});
    const types = messages.map((m) => m.type);
    const status = messages.find((m) => m.type === 'agentGuardStatus');
    expect(status).toEqual({
      type: 'agentGuardStatus',
      id: 1,
      active: false,
      reasons: ['awaiting_first_verdict', 'no_workspace_root'],
      permissionRoles: ['R'],
    });
    expect(types.indexOf('agentGuardStatus')).toBeGreaterThan(types.indexOf('existingAgents'));
  });

  it('embedded (VS Code): never sends agentGuardStatus even if a reporter is passed', async () => {
    const config = await server.start({ embedded: true, store, guardStatus: reporter });
    const messages = await handshake(config.port, { Authorization: `Bearer ${config.token}` });
    expect(messages.some((m) => m.type === 'existingAgents')).toBe(true);
    expect(messages.some((m) => m.type === 'agentGuardStatus')).toBe(false);
  });
});
