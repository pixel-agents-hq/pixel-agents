/**
 * The PTY host's wire protocol: newline-delimited JSON over a Unix socket.
 *
 * Development only (`pixel-agents --pty-host`). The host is meant to run for
 * days across many server restarts, so a server and a host built from
 * different checkouts meet often: anything that changes a message's meaning
 * bumps PTY_HOST_PROTOCOL, and a server refuses a host speaking another one
 * (the operator stops the old host, which ends its agents, deliberately).
 */

import * as os from 'os';
import * as path from 'path';

import type { CreateTerminalOptions, TerminalReplay } from './terminalSessions.js';

export const PTY_HOST_PROTOCOL = 1;

/** A running terminal, as the host reports it to a server that connects. */
export interface HostSessionInfo {
  agentId: number;
  pid: number;
  cols: number;
  rows: number;
}

/** Server → host requests the host answers; on the wire each carries a
 *  `rid` that pairs it with its reply. */
export type HostQuery =
  { t: 'spawn'; options: CreateTerminalOptions } | { t: 'replay'; agentId: number };

/** Server → host. */
export type HostRequest =
  | { t: 'hello'; protocol: number }
  | (HostQuery & { rid: number })
  | { t: 'write'; agentId: number; data: string }
  | { t: 'resize'; agentId: number; cols: number; rows: number }
  | { t: 'kill'; agentId: number };

/** Host → server. After `hello`, the host streams every terminal's `data` and
 *  `exit` to every connected server. */
export type HostMessage =
  | {
      t: 'hello';
      protocol: number;
      pid: number;
      moduleId: string | null;
      reason: string | null;
      sessions: HostSessionInfo[];
    }
  | { t: 'spawned'; rid: number; agentId: number; pid: number }
  | { t: 'spawnFailed'; rid: number; agentId: number; message: string }
  | { t: 'replay'; rid: number; agentId: number; replay: TerminalReplay | null }
  | { t: 'data'; agentId: number; data: string; seq: number }
  | { t: 'exit'; agentId: number; exitCode: number; signal?: number };

/** The reply the host sends to a query, paired with it by `rid`. */
export type HostReply<Q extends HostQuery> = Q extends { t: 'spawn' }
  ? Extract<HostMessage, { t: 'spawned' | 'spawnFailed' }>
  : Extract<HostMessage, { t: 'replay' }>;

export function encodeLine(msg: HostRequest | HostMessage): string {
  // JSON.stringify escapes newlines inside strings, so '\n' only ever ends a message.
  return `${JSON.stringify(msg)}\n`;
}

/** Splits a byte stream into messages; a partial line waits for the rest. */
export class LineDecoder {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const out: unknown[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A malformed line is dropped; the stream stays in sync at the next '\n'.
      }
    }
    return out;
  }
}

/** macOS limits a socket path to 104 bytes (Linux 108). */
const MAX_SOCKET_PATH_BYTES = 103;

/** Where the host lives: a 0700 directory under ~/.pixel-agents. */
export function ptyHostDir(): string {
  return path.join(os.homedir(), '.pixel-agents', 'pty-host');
}

export function defaultPtyHostSocket(): string {
  return path.join(ptyHostDir(), 'host.sock');
}

export function ptyHostLogFile(): string {
  return path.join(ptyHostDir(), 'host.log');
}

/** Why a socket path can't be used, or null when it can. */
export function socketPathProblem(socketPath: string): string | null {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return `PTY host socket path is too long for a Unix socket (${socketPath}); pass a shorter one with --pty-host-socket.`;
  }
  return null;
}
