import { spawn } from 'child_process';
import type { FastifyInstance } from 'fastify';
import * as http from 'http';
import * as net from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { encodeTerminalFrame } from '../../core/src/terminalFrames.js';
import {
  TASK_DISPATCH_DENIED_MESSAGE,
  TASK_DISPATCH_MCP_MAX_REQUEST_BYTES,
  TASK_DISPATCH_PORT_ENV_NAME,
} from '../src/constants.js';
import { createHttpServer, type HttpServerOptions } from '../src/httpServer.js';
import { DISPATCH_TEST_SHIM, DispatchHarness } from './taskDispatchHarness.js';
import { buildShim } from './taskDispatchShimBuild.js';

/**
 * POST /mcp end to end over real HTTP: the root-level filter (before CORS),
 * capability-only Bearer auth, the JSON-RPC subset, and the shim driven
 * against the live endpoint into a fake PTY.
 */

const SERVER_TOKEN = 'server-token-0123456789abcdef';
const PASTE = (caller: number, text: string) =>
  `\u001b[200~[Task from Workspace KB Writer (agent ${caller})]\n${text}\u001b[201~\r`;

let h: DispatchHarness;
let ws: { id: string; dir: string };
let curator: { id: number; token?: string };
let target: { id: number; token?: string };
let app: FastifyInstance;
let port: number;

function serverOptions(overrides: Partial<HttpServerOptions> = {}): HttpServerOptions {
  return {
    embedded: false,
    token: SERVER_TOKEN,
    store: h.store,
    runtime: h.runtime,
    ptyManager: h.manager,
    capabilities: h.capabilities,
    curators: h.curators,
    guardStatus: h.guardStatus,
    taskDispatchShimPath: DISPATCH_TEST_SHIM,
    ...overrides,
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  method: string,
  headers: Record<string, string | string[]>,
  body?: string,
  urlPath = '/mcp',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function capabilityHeaders(token = curator.token!): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

function rpc(message: unknown, headers = capabilityHeaders()): Promise<Reply> {
  return request('POST', headers, JSON.stringify(message));
}

/** A hand-written request, for header shapes Node's client will not send (two Hosts). */
function rawRequest(headerLines: string[], body = '{}'): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        [
          'POST /mcp HTTP/1.1',
          ...headerLines,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    });
    let text = '';
    socket.on('data', (c: Buffer) => (text += c.toString()));
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

const call = (targetAgentId: number, task = 'Summarize the notes', id = 3) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'dispatch_task', arguments: { targetAgentId, task } },
});

beforeEach(async () => {
  h = new DispatchHarness();
  ws = h.workspace('alpha');
  curator = h.launch({ directoryPath: ws.dir });
  target = h.launch({ directoryPath: ws.dir });
  h.curators.appoint(ws.id, curator.id);
  h.makeReady(target.id);
  ({ app, port } = await createHttpServer(serverOptions()));
});

afterEach(async () => {
  await app.close();
  h.dispose();
  vi.restoreAllMocks();
});

describe('JSON-RPC over POST /mcp', () => {
  it('answers initialize with the requested (supported) version, else the newest', async () => {
    const reply = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'pixel-agents' },
      },
    });
    const unknown = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    expect(JSON.parse(unknown.body).result.protocolVersion).toBe('2025-06-18');
  });

  it('accepts a notification with 202 and no body', async () => {
    const reply = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(reply.status).toBe(202);
    expect(reply.body).toBe('');
  });

  it('lists exactly the dispatch_task tool', async () => {
    const reply = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = JSON.parse(reply.body).result.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toEqual(['dispatch_task']);
    expect(tools[0].inputSchema).toMatchObject({ required: ['targetAgentId', 'task'] });
  });

  it('tools/call writes into the target PTY and says only "written to terminal"', async () => {
    h.store.get(target.id)!.displayName = 'Writer';
    const reply = await rpc(call(target.id, 'Go'));
    const result = JSON.parse(reply.body).result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Task written to terminal of "Writer"');
    expect(result.content[0].text).toContain(`agent ${target.id}`);
    expect(result.content[0].text).not.toMatch(/accepted/i);
    expect(h.ptyOf(target.id).written).toEqual([PASTE(curator.id, 'Go')]);
  });

  it('every refusal is the same fixed tool error', async () => {
    const self = JSON.parse((await rpc(call(curator.id))).body).result;
    const unknown = JSON.parse((await rpc(call(999))).body).result;
    const badText = JSON.parse((await rpc(call(target.id, '@etc/passwd'))).body).result;
    for (const result of [self, unknown, badText]) {
      expect(result).toEqual({
        content: [{ type: 'text', text: TASK_DISPATCH_DENIED_MESSAGE }],
        isError: true,
      });
    }
    expect(h.ptyOf(target.id).written).toEqual([]);
  });

  it('rejects a batch (array body) and writes nothing', async () => {
    const reply = await rpc([call(target.id)]);
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(h.ptyOf(target.id).written).toEqual([]);
  });

  it('answers unknown methods and tools with JSON-RPC errors', async () => {
    expect(
      JSON.parse((await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).body),
    ).toMatchObject({
      error: { code: -32601 },
    });
    const wrongTool = await rpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'other', arguments: {} },
    });
    expect(JSON.parse(wrongTool.body)).toMatchObject({ error: { code: -32602 } });
  });

  it('GET and DELETE /mcp are 405', async () => {
    const get = await request('GET', { authorization: `Bearer ${curator.token}` });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const del = await request('DELETE', { authorization: `Bearer ${curator.token}` });
    expect(del.status).toBe(405);
  });

  it('enforces the route-level body limit', async () => {
    const huge = JSON.stringify(call(target.id, 'x'.repeat(TASK_DISPATCH_MCP_MAX_REQUEST_BYTES)));
    const reply = await request('POST', capabilityHeaders(), huge);
    expect(reply.status).toBe(413);
  });
});

describe('the /mcp filter (before CORS, capability only)', () => {
  const forbidden: Array<[string, Record<string, string>]> = [
    ['an Origin', { origin: 'http://127.0.0.1:1234' }],
    ['X-Forwarded-For', { 'x-forwarded-for': '10.0.0.1' }],
    ['Forwarded', { forwarded: 'for=10.0.0.1' }],
    ['Via', { via: '1.1 proxy' }],
    ['a non-loopback Host', { host: 'evil.example' }],
  ];
  it.each(forbidden)(
    'refuses %s with 403 before auth and without CORS headers',
    async (_label, extra) => {
      const reply = await request(
        'POST',
        { ...capabilityHeaders(), ...extra },
        JSON.stringify(call(target.id)),
      );
      expect(reply.status).toBe(403);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(h.ptyOf(target.id).written).toEqual([]);
    },
  );

  it('answers a CORS preflight with 403, not an allow-origin', async () => {
    const reply = await request('OPTIONS', {
      origin: 'http://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    });
    expect(reply.status).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses two Host headers (403) and two Authorization headers (401)', async () => {
    const auth = `Authorization: Bearer ${curator.token}`;
    expect(await rawRequest([`Host: 127.0.0.1:${port}`, `Host: 127.0.0.1:${port}`, auth])).toBe(
      403,
    );
    expect(await rawRequest([`Host: 127.0.0.1:${port}`, auth, auth])).toBe(401);
    expect(
      await rawRequest([`Host: 127.0.0.1:${port}`, auth], JSON.stringify(call(target.id))),
    ).toBe(200);
  });

  it('refuses a non-loopback peer', async () => {
    const reply = await app.inject({
      method: 'POST',
      url: '/mcp',
      remoteAddress: '192.168.1.20',
      headers: { ...capabilityHeaders(), host: `127.0.0.1:${port}` },
      payload: JSON.stringify(call(target.id)),
    });
    expect(reply.statusCode).toBe(403);
    expect(h.ptyOf(target.id).written).toEqual([]);
  });

  it('refuses the server token, a missing header, another scheme, and a revoked capability (401)', async () => {
    const body = JSON.stringify(call(target.id));
    const attempts: Array<Record<string, string>> = [
      { 'content-type': 'application/json', authorization: `Bearer ${SERVER_TOKEN}` },
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', authorization: `Basic ${curator.token}` },
    ];
    for (const headers of attempts) {
      expect((await request('POST', headers, body)).status).toBe(401);
    }
    h.ptyOf(curator.id).exit(0);
    expect((await request('POST', capabilityHeaders(), body)).status).toBe(401);
    expect(h.ptyOf(target.id).written).toEqual([]);
  });

  it('does not exist on an embedded server', async () => {
    const embedded = await createHttpServer(serverOptions({ embedded: true }));
    try {
      const reply = await embedded.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: capabilityHeaders(),
        payload: JSON.stringify(call(target.id)),
      });
      expect(reply.statusCode).toBe(404);
    } finally {
      await embedded.app.close();
    }
  });

  it('does not exist without the switch (no shim path)', async () => {
    const off = await createHttpServer(serverOptions({ taskDispatchShimPath: undefined }));
    try {
      const reply = await off.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: capabilityHeaders(),
        payload: JSON.stringify(call(target.id)),
      });
      expect(reply.statusCode).toBe(404);
    } finally {
      await off.app.close();
    }
  });
});

describe('wiring with the rest of the server', () => {
  it('operator input over /terminal blocks a dispatch into that terminal', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal/${target.id}`);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.send(encodeTerminalFrame({ type: 'input', data: 'typing' }));
    await vi.waitFor(() => expect(h.ptyOf(target.id).written).toEqual(['typing']));
    socket.close();

    const result = JSON.parse((await rpc(call(target.id))).body).result;
    expect(result.isError).toBe(true);
    expect(logs.some((l) => l.includes('outcome=denied:operator_typing'))).toBe(true);
    expect(h.ptyOf(target.id).written).toEqual(['typing']);
  });

  it("a launch over /ws puts THIS server's port in the agent env", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    const before = h.spawned.length;
    socket.send(JSON.stringify({ type: 'launchAgent', directoryPath: ws.dir }));
    await vi.waitFor(() => expect(h.spawned.length).toBe(before + 1));
    socket.close();
    const spawned = h.spawned[h.spawned.length - 1];
    expect(spawned.options.env?.[TASK_DISPATCH_PORT_ENV_NAME]).toBe(String(port));
    expect(spawned.args).toContain('--mcp-config');
  });
});

describe('the bundled shim against the live endpoint', () => {
  let shimPath: string;
  let cleanupShim: () => void;
  beforeAll(async () => {
    ({ shimPath, cleanup: cleanupShim } = await buildShim());
  });
  afterAll(() => cleanupShim());

  function driveShim(lines: string[], token: string): Promise<string[]> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [shimPath], {
        env: {
          PATH: process.env.PATH,
          PIXEL_AGENTS_CAPABILITY: token,
          PIXEL_AGENTS_PORT: String(port),
        },
        stdio: 'pipe',
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('close', () => resolve(out.split('\n').filter((l) => l.length > 0)));
      child.stdin.end(lines.map((l) => `${l}\n`).join(''));
    });
  }

  it('initialize, tools/list and an allowed then a locked tools/call reach the PTY as framed', async () => {
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      call(target.id, 'First task', 3),
      call(target.id, 'Second task', 4),
    ].map((m) => JSON.stringify(m));
    const answers = (await driveShim(lines, curator.token!)).map(
      (l) => JSON.parse(l) as { id: number; result: Record<string, unknown> },
    );
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3, 4]);
    expect(answers[0].result.serverInfo).toMatchObject({ name: 'pixel-agents' });
    expect(answers[2].result.isError).toBeUndefined();
    expect(answers[3].result).toEqual({
      content: [{ type: 'text', text: TASK_DISPATCH_DENIED_MESSAGE }],
      isError: true,
    });
    expect(h.ptyOf(target.id).written).toEqual([PASTE(curator.id, 'First task')]);
  });
});
