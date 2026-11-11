import fs from 'node:fs';
import path from 'node:path';

import { WebSocket } from 'ws';

/**
 * Helpers for the task-dispatch standalone spec: a `claude` stand-in that
 * behaves like the real CLI at the process boundary (task-dispatch-claude.cjs),
 * a /ws client that plays the operator, and the file protocol the
 * stand-in uses to let the test play the curator's model.
 */

const PROBE_SOURCE = path.join(__dirname, 'task-dispatch-claude.cjs');
const POLL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockRoot(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock');
}

/**
 * Replace the installed mock `claude` (standaloneOptions.mockClaude) with the
 * dispatch stand-in. It still runs the regular scenario runner, so scenarios
 * arranged with claudeScenario() play exactly as before.
 */
export function installDispatchProbe(tmpHome: string): void {
  const binDir = path.join(tmpHome, 'mock-bin');
  if (!fs.existsSync(path.join(binDir, 'mock-claude-runner.cjs'))) {
    throw new Error(`mock claude is not installed in ${binDir} (use mockClaude: true)`);
  }
  fs.copyFileSync(PROBE_SOURCE, path.join(binDir, 'task-dispatch-claude.cjs'));
  const wrapper = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'exec "${PIXEL_AGENTS_NODE_BIN:-node}" "${SCRIPT_DIR}/task-dispatch-claude.cjs" "$@"',
    '',
  ].join('\n');
  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(claudePath, wrapper);
  fs.chmodSync(claudePath, 0o755);
}

/** The session ids of started stand-ins, in start order, with whether they got the shim. */
export function probeSessions(tmpHome: string): Array<{ sessionId: string; mcp: boolean }> {
  const logPath = path.join(mockRoot(tmpHome), 'dispatch-probes.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sessionId, mcp] = line.split(' ');
      return { sessionId, mcp: mcp === 'mcp=yes' };
    });
}

export async function waitForProbeCount(
  tmpHome: string,
  count: number,
  timeoutMs = 15_000,
): Promise<Array<{ sessionId: string; mcp: boolean }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = probeSessions(tmpHome);
    if (sessions.length >= count) return sessions;
    await delay(POLL_MS);
  }
  throw new Error(`only ${probeSessions(tmpHome).length} dispatch probes started`);
}

let requestSerial = 0;

/**
 * Hand a JSON-RPC batch to a stand-in's MCP shim (as its model would) and wait
 * for the answers to every request in it.
 */
export async function callMcpThroughAgent(
  tmpHome: string,
  sessionId: string,
  messages: Array<Record<string, unknown>>,
  timeoutMs = 15_000,
): Promise<Array<Record<string, unknown>>> {
  requestSerial += 1;
  const name = `${sessionId}-${String(requestSerial).padStart(4, '0')}.json`;
  const requestPath = path.join(mockRoot(tmpHome), `mcp-request-${name}`);
  const responsePath = path.join(mockRoot(tmpHome), `mcp-response-${name}`);
  fs.writeFileSync(`${requestPath}.tmp`, JSON.stringify(messages));
  fs.renameSync(`${requestPath}.tmp`, requestPath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      return JSON.parse(fs.readFileSync(responsePath, 'utf8')) as Array<Record<string, unknown>>;
    }
    await delay(POLL_MS);
  }
  throw new Error(`no MCP answer from session ${sessionId}`);
}

/** Exactly what reached an agent's terminal input so far. */
export function ptyInputOf(tmpHome: string, sessionId: string): string {
  const logPath = path.join(mockRoot(tmpHome), `pty-input-${sessionId}.log`);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

/** The URL the CLI printed. */
export function printedOfficeUrl(hostLogs: string): URL {
  const printed = /Pixel Agents server running at (\S+)\s/.exec(hostLogs)?.[1];
  if (!printed) throw new Error('the CLI never printed its URL');
  return new URL(printed);
}

export interface OfficeSocket {
  send(message: Record<string, unknown>): void;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

/** A /ws connection, the way the SPA opens it. */
export async function openOfficeSocket(officeUrl: URL): Promise<OfficeSocket> {
  const socket = new WebSocket(`ws://${officeUrl.host}/ws`);
  const received: Array<Record<string, unknown>> = [];
  socket.on('message', (data: Buffer) => {
    try {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // not JSON: ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'webviewReady' }));
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: async (predicate, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = received.find(predicate);
        if (hit) return hit;
        await delay(POLL_MS);
      }
      throw new Error('timed out waiting for an office message');
    },
    close: () => socket.close(),
  };
}
