/**
 * The task-dispatch stdio MCP shim (bundled to dist/hooks/pixel-agents-mcp.js).
 *
 * Claude Code starts it as a stdio MCP server (`node <shim>`, from the
 * launcher's --mcp-config). It speaks newline-delimited JSON-RPC on stdio and
 * forwards every message, unchanged, to `POST http://127.0.0.1:<port>/mcp`,
 * where the server implements initialize, tools/list and tools/call. Requests
 * get the server's answer on stdout; notifications get nothing.
 *
 * Secrets: the capability comes from PIXEL_AGENTS_CAPABILITY in this process's
 * environment and leaves it ONLY as the Authorization header of that loopback
 * request. It is never in argv, never written to disk, never logged. The port
 * (PIXEL_AGENTS_PORT) is not secret. The host is always 127.0.0.1.
 *
 * stdout carries JSON-RPC only; diagnostics go to stderr and never include the
 * token or a task.
 */

import * as http from 'http';
import * as readline from 'readline';

import {
  CAPABILITY_ENV_NAME,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_PARSE_ERROR,
  MAX_PORT,
  MIN_PORT,
  TASK_DISPATCH_MCP_PATH,
  TASK_DISPATCH_PORT_ENV_NAME,
  TASK_DISPATCH_SHIM_MAX_RESPONSE_BYTES,
  TASK_DISPATCH_SHIM_NOT_CONFIGURED_MESSAGE as NOT_CONFIGURED_MESSAGE,
  TASK_DISPATCH_SHIM_PARSE_ERROR_MESSAGE as PARSE_ERROR_MESSAGE,
  TASK_DISPATCH_SHIM_REFUSED_MESSAGE as REFUSED_MESSAGE,
  TASK_DISPATCH_SHIM_TIMEOUT_MS,
  TASK_DISPATCH_SHIM_UNREACHABLE_MESSAGE as UNREACHABLE_MESSAGE,
} from '../constants.js';

export interface ShimIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  /** Diagnostics (stderr in production). Never handed a token or a task. */
  log: (line: string) => void;
  timeoutMs?: number;
}

interface ShimTarget {
  port: number;
  authorization: string;
}

function targetFrom(env: NodeJS.ProcessEnv): ShimTarget | null {
  const token = env[CAPABILITY_ENV_NAME];
  const port = Number(env[TASK_DISPATCH_PORT_ENV_NAME]);
  if (typeof token !== 'string' || token.length === 0) return null;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
  return { port, authorization: `Bearer ${token}` };
}

/** The id of a request, or undefined for a notification / unparsable shape. */
function requestId(message: unknown): string | number | null | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  if (!('id' in message)) return undefined;
  const id = (message as { id: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function errorLine(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

type PostOutcome =
  { kind: 'answer'; status: number; body: string } | { kind: 'failed'; reason: string };

function post(target: ShimTarget, body: string, timeoutMs: number): Promise<PostOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: PostOutcome): void => {
      if (done) return;
      done = true;
      resolve(outcome);
    };
    const request = http.request(
      {
        host: '127.0.0.1',
        port: target.port,
        path: TASK_DISPATCH_MCP_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: target.authorization,
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > TASK_DISPATCH_SHIM_MAX_RESPONSE_BYTES) {
            request.destroy();
            finish({ kind: 'failed', reason: 'response too large' });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish({
            kind: 'answer',
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', () => finish({ kind: 'failed', reason: 'response error' }));
      },
    );
    request.on('timeout', () => {
      request.destroy();
      finish({ kind: 'failed', reason: 'timeout' });
    });
    request.on('error', (err) => finish({ kind: 'failed', reason: err.message }));
    request.end(body);
  });
}

/** Forward one stdin line; returns the stdout line to write, or null. */
async function forwardLine(
  line: string,
  target: ShimTarget | null,
  io: ShimIo,
): Promise<string | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return errorLine(null, JSON_RPC_PARSE_ERROR, PARSE_ERROR_MESSAGE);
  }
  const id = requestId(message);
  if (!target) {
    return id === undefined ? null : errorLine(id, JSON_RPC_INTERNAL_ERROR, NOT_CONFIGURED_MESSAGE);
  }

  const outcome = await post(target, line, io.timeoutMs ?? TASK_DISPATCH_SHIM_TIMEOUT_MS);
  if (outcome.kind === 'failed') {
    io.log(`[Pixel Agents] MCP shim: request failed (${outcome.reason})`);
    return id === undefined ? null : errorLine(id, JSON_RPC_INTERNAL_ERROR, UNREACHABLE_MESSAGE);
  }
  if (id === undefined) return null; // notification: 202, nothing to say
  if (outcome.status === 200 || outcome.status === 400) {
    try {
      // Re-serialized: exactly one line on stdout, whatever the server's spacing.
      return JSON.stringify(JSON.parse(outcome.body));
    } catch {
      return errorLine(id, JSON_RPC_INTERNAL_ERROR, UNREACHABLE_MESSAGE);
    }
  }
  io.log(`[Pixel Agents] MCP shim: server answered HTTP ${outcome.status}`);
  return errorLine(id, JSON_RPC_INTERNAL_ERROR, REFUSED_MESSAGE);
}

/**
 * Serve stdio until the input ends. Messages are handled one at a time, in
 * order, so answers come back in request order.
 */
export function runMcpShim(io: ShimIo): Promise<void> {
  const target = targetFrom(io.env);
  if (!target) io.log('[Pixel Agents] MCP shim: no capability or port in the environment');
  const lines = readline.createInterface({ input: io.input, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  return new Promise((resolve) => {
    lines.on('line', (line) => {
      if (line.trim().length === 0) return;
      queue = queue.then(async () => {
        const answer = await forwardLine(line, target, io);
        if (answer !== null) io.output.write(`${answer}\n`);
      });
    });
    lines.on('close', () => {
      void queue.then(() => resolve());
    });
  });
}

if (require.main === module) {
  void runMcpShim({
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
  }).then(() => process.exit(0));
}
