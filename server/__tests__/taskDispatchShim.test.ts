import { spawn } from 'child_process';
import * as http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildShim } from './taskDispatchShimBuild.js';

/**
 * The bundled stdio shim against a fake /mcp: newline-delimited JSON-RPC in,
 * one POST per message out, the capability ONLY as the Authorization header.
 */

const TOKEN = 'pxa_kb_' + 'A'.repeat(43);

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
}

let shimPath: string;
let cleanupShim: () => void;

beforeAll(async () => {
  ({ shimPath, cleanup: cleanupShim } = await buildShim());
});
afterAll(() => cleanupShim());

/** A fake /mcp that answers like the real one, recording each request. */
function fakeMcp(status = 200): Promise<{ port: number; recorded: Recorded[]; close: () => void }> {
  const recorded: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      recorded.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body,
      });
      const message = JSON.parse(body) as { id?: unknown; method: string };
      if (!('id' in message)) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          { jsonrpc: '2.0', id: message.id, result: { echoed: message.method } },
          null,
          2, // multi-line on purpose: the shim must still print one line
        ),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, recorded, close: () => server.close() });
    });
  });
}

/** Run the shim with these stdin lines; resolve its stdout lines and stderr. */
function runShim(
  lines: string[],
  env: Record<string, string>,
): Promise<{ stdout: string[]; stderr: string; code: number | null; argv: string[] }> {
  const argv = [shimPath];
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...env };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env: childEnv, stdio: 'pipe' });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) =>
      resolve({
        stdout: out.split('\n').filter((l) => l.length > 0),
        stderr: err,
        code,
        argv,
      }),
    );
    child.stdin.end(lines.map((l) => `${l}\n`).join(''));
  });
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
});
const INITIALIZED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'dispatch_task', arguments: { targetAgentId: 2, task: 'hi' } },
});

describe('MCP shim (stdio)', () => {
  it('forwards initialize, notifications/initialized, tools/list and tools/call in order', async () => {
    const mcp = await fakeMcp();
    try {
      const run = await runShim([INIT, INITIALIZED, LIST, CALL], {
        PIXEL_AGENTS_CAPABILITY: TOKEN,
        PIXEL_AGENTS_PORT: String(mcp.port),
      });
      expect(run.code).toBe(0);
      expect(run.stdout.map((l) => JSON.parse(l) as unknown)).toEqual([
        { jsonrpc: '2.0', id: 1, result: { echoed: 'initialize' } },
        { jsonrpc: '2.0', id: 2, result: { echoed: 'tools/list' } },
        { jsonrpc: '2.0', id: 3, result: { echoed: 'tools/call' } },
      ]);
      // One POST per message, the body forwarded unchanged, notification included.
      expect(mcp.recorded.map((r) => [r.method, r.url, r.body])).toEqual([
        ['POST', '/mcp', INIT],
        ['POST', '/mcp', INITIALIZED],
        ['POST', '/mcp', LIST],
        ['POST', '/mcp', CALL],
      ]);
    } finally {
      mcp.close();
    }
  });

  it('sends the capability only as the one Authorization header, to a loopback Host, with no Origin', async () => {
    const mcp = await fakeMcp();
    try {
      const run = await runShim([INIT, CALL], {
        PIXEL_AGENTS_CAPABILITY: TOKEN,
        PIXEL_AGENTS_PORT: String(mcp.port),
      });
      expect(run.argv.join(' ')).not.toContain(TOKEN);
      expect(run.stderr).not.toContain(TOKEN);
      expect(run.stdout.join('\n')).not.toContain(TOKEN);
      for (const request of mcp.recorded) {
        const authorizations = request.rawHeaders.filter(
          (_v, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'authorization',
        );
        expect(authorizations).toHaveLength(1);
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(request.headers.host).toBe(`127.0.0.1:${mcp.port}`);
        expect(request.headers.origin).toBeUndefined();
        expect(request.url).not.toContain(TOKEN);
        expect(request.body).not.toContain(TOKEN);
        // The token appears in exactly one header value: Authorization.
        const carrying = request.rawHeaders.filter((v, i) => i % 2 === 1 && v.includes(TOKEN));
        expect(carrying).toEqual([`Bearer ${TOKEN}`]);
      }
    } finally {
      mcp.close();
    }
  });

  it('answers every request with a fixed error and sends nothing without a capability or port', async () => {
    const mcp = await fakeMcp();
    try {
      const missingToken = await runShim([INIT, INITIALIZED], {
        PIXEL_AGENTS_PORT: String(mcp.port),
      });
      const badPort = await runShim([LIST], {
        PIXEL_AGENTS_CAPABILITY: TOKEN,
        PIXEL_AGENTS_PORT: 'x',
      });
      expect(missingToken.stdout.map((l) => JSON.parse(l) as unknown)).toEqual([
        {
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32603,
            message: 'Pixel Agents task dispatch is not available in this session',
          },
        },
      ]);
      expect((JSON.parse(badPort.stdout[0]) as { error: { code: number } }).error.code).toBe(
        -32603,
      );
      expect(mcp.recorded).toEqual([]);
    } finally {
      mcp.close();
    }
  });

  it('turns an HTTP refusal into a fixed JSON-RPC error, never the server body', async () => {
    const mcp = await fakeMcp(401);
    try {
      const run = await runShim([LIST], {
        PIXEL_AGENTS_CAPABILITY: TOKEN,
        PIXEL_AGENTS_PORT: String(mcp.port),
      });
      expect(JSON.parse(run.stdout[0])).toEqual({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32603, message: 'Pixel Agents server refused the request' },
      });
    } finally {
      mcp.close();
    }
  });

  it('answers a parse error locally and keeps serving', async () => {
    const mcp = await fakeMcp();
    try {
      const run = await runShim(['{not json', LIST], {
        PIXEL_AGENTS_CAPABILITY: TOKEN,
        PIXEL_AGENTS_PORT: String(mcp.port),
      });
      expect(JSON.parse(run.stdout[0])).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      expect(JSON.parse(run.stdout[1])).toMatchObject({ id: 2, result: { echoed: 'tools/list' } });
      expect(mcp.recorded).toHaveLength(1);
    } finally {
      mcp.close();
    }
  });
});
