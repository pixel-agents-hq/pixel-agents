/**
 * Terminal routes: the data plane for the standalone embedded terminal.
 *
 * SECURITY: `/terminal/:agentId` pipes a browser's keystrokes into a real
 * process. It is arbitrary code execution and is the most sensitive surface in
 * this codebase.
 *
 * The route requires the server token in BOTH modes. WebSocket connections are
 * exempt from CORS, so any page the user visits can open
 * ws://127.0.0.1:<port>/terminal/1 -- the same-origin policy stops the browser
 * from READING a cross-origin HTTP response, but never stops the socket from
 * connecting; scanning localhost ports from a web page is a known, practical
 * attack. The token is the same out-of-band secret that privileges the /ws
 * control socket (httpServer.ts standaloneTokenValid): it reaches the browser
 * ONLY inside the URL the CLI printed, is never handed out by an HTTP route,
 * and rides here as the second Sec-WebSocket-Protocol value so it stays out of
 * the request log. The same-origin + loopback-Host check is defence in depth on
 * top of it (it blunts DNS rebinding); it is never the gate on its own. See
 * docs/design/standalone-terminal.md ("Security model").
 */

import type { FastifyInstance } from 'fastify';

import {
  TERMINAL_CLOSE_NO_SESSION,
  TERMINAL_CLOSE_UNAUTHORIZED,
  TERMINAL_WS_PREFIX,
} from '../../core/src/constants.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import {
  encodeServerFrame,
  extractTokenFromProtocolHeader,
  isLoopbackHost,
  isTrustedTerminalRequest,
  isValidToken,
  parseClientFrame,
} from './terminal/terminalProtocol.js';

export interface TerminalRoutesOptions {
  token: string;
  /** Host the server is bound to. When loopback, the terminal guard also
   *  requires a loopback Host header (anti-DNS-rebinding); see
   *  isTrustedTerminalRequest. */
  host: string;
  ptyManager?: PtySessionManager;
}

/** Minimal structural view of the socket, so tests don't need a real WebSocket. */
interface TerminalSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
}

const WS_OPEN = 1;

export function registerTerminalRoutes(app: FastifyInstance, options: TerminalRoutesOptions): void {
  // The terminal feature is standalone-only; VS Code owns its own terminals.
  if (!options.ptyManager) return;
  const ptyManager = options.ptyManager;

  // Only enforce the loopback-Host allowlist when we're actually loopback-bound.
  // An operator who bound off-loopback opted into network exposure (and was
  // warned); their legitimate Host is a LAN name we can't enumerate.
  const enforceLoopbackHost = isLoopbackHost(options.host);

  registerTerminalSocketRoute(app, options.token, ptyManager, enforceLoopbackHost);
}

function registerTerminalSocketRoute(
  app: FastifyInstance,
  token: string,
  ptyManager: PtySessionManager,
  enforceLoopbackHost: boolean,
): void {
  app.get<{ Params: { agentId: string } }>(
    `${TERMINAL_WS_PREFIX}/:agentId`,
    {
      websocket: true,
      schema: {
        params: {
          type: 'object',
          properties: { agentId: { type: 'string', pattern: '^[0-9]+$' } },
          required: ['agentId'],
        },
      },
    },
    (socket: TerminalSocket, request) => {
      // ── Auth (before anything else touches a process) ──
      const provided = extractTokenFromProtocolHeader(request.headers['sec-websocket-protocol']);
      if (!isValidToken(provided, token)) {
        socket.close(TERMINAL_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      if (
        !isTrustedTerminalRequest(request.headers.origin, request.headers.host, enforceLoopbackHost)
      ) {
        socket.close(TERMINAL_CLOSE_UNAUTHORIZED, 'forbidden origin');
        return;
      }

      const agentId = Number(request.params.agentId);
      const session = ptyManager.get(agentId);
      if (!session) {
        // Only attaches to PTYs this server spawned -- it can never start one.
        socket.close(TERMINAL_CLOSE_NO_SESSION, 'no terminal for agent');
        return;
      }

      const send = (data: string): void => {
        if (socket.readyState === WS_OPEN) socket.send(data);
      };

      // Snapshot-then-live handoff. The replay frame carries a serialized
      // snapshot of the mirrored screen (valid on a fresh terminal, unlike a
      // raw byte ring), and it must be the FIRST frame: any output or exit
      // arriving while the snapshot is being taken is queued and flushed right
      // after it. The snapshot's flush-write semantics (see PtySession) mean a
      // queued chunk is never also inside the snapshot — no byte is dropped or
      // doubled across the handoff.
      let replaySent = false;
      const preReplay: string[] = [];
      const forward = (frame: string): void => {
        if (replaySent) send(frame);
        else preReplay.push(frame);
      };

      const offData = session.onData((chunk) => {
        forward(encodeServerFrame({ type: 'output', data: chunk }));
      });

      const offExit = session.onExit((exit) => {
        forward(encodeServerFrame({ type: 'exit', exitCode: exit.exitCode, signal: exit.signal }));
      });

      void session.snapshot().then((data) => {
        send(encodeServerFrame({ type: 'replay', data, cols: session.cols, rows: session.rows }));
        replaySent = true;
        for (const frame of preReplay) send(frame);
        preReplay.length = 0;
      });

      socket.on('message', (raw: Buffer | string) => {
        const frame = parseClientFrame(raw.toString());
        if (!frame) return; // Malformed/unknown frames are ignored, never thrown on.
        if (frame.type === 'input') {
          session.write(frame.data);
        } else {
          session.resize(frame.cols, frame.rows);
        }
      });

      socket.on('close', () => {
        // Detach only. The PTY outlives the socket so a reload reattaches to the
        // still-running Claude session; only closeAgent (or the process exiting)
        // ends it.
        offData();
        offExit();
      });
    },
  );
}
