/**
 * Terminal routes: the data plane for the standalone embedded terminal.
 *
 * SECURITY: `/terminal/:agentId` pipes a browser's keystrokes into a real
 * process. It is arbitrary code execution and is the most sensitive surface in
 * this codebase.
 *
 * The route requires privilege. WebSocket connections are exempt from
 * CORS, so any page the user visits can open ws://127.0.0.1:<port>/terminal/1
 * -- the same-origin policy stops the browser from READING a cross-origin HTTP
 * response, but never stops the socket from connecting; scanning localhost
 * ports from a web page is a known, practical attack. Privilege is decided by
 * the SAME predicate as the /ws control socket (wsAuth.standaloneHandshakeVerdict:
 * the `?token=` the CLI printed, under an allowed Host), so there is exactly one
 * privilege gate to audit; the request logger redacts the token. A same-origin
 * check sits on top. See docs/design/standalone-terminal.md ("Security model").
 */

import type { FastifyInstance } from 'fastify';

import { TERMINAL_WS_PREFIX } from '../../../core/src/constants.js';
import { encodeTerminalFrame, parseClientFrame } from '../../../core/src/terminalFrames.js';
import {
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_NO_SESSION,
  WS_CLOSE_UNAUTHORIZED,
} from '../constants.js';
import { isAllowedWebSocketOrigin, standaloneHandshakeVerdict } from '../wsAuth.js';
import type { TerminalSessions } from './terminalSessions.js';

export interface TerminalRoutesOptions {
  token: string;
  /** Host names a privileged handshake may arrive under (wsAuth.privilegedHostnames). */
  allowedHostnames: ReadonlySet<string>;
  ptyManager?: TerminalSessions;
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
      const verdict = standaloneHandshakeVerdict(
        request.url,
        request.headers.host,
        options.token,
        options.allowedHostnames,
      );
      if (verdict === 'bad-token') {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      if (
        verdict === 'untrusted-host' ||
        !isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)
      ) {
        socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
        return;
      }

      const agentId = Number(request.params.agentId);
      const session = ptyManager.get(agentId);
      if (!session) {
        // Only attaches to PTYs this server spawned -- it can never start one.
        socket.close(WS_CLOSE_NO_SESSION, 'no terminal for agent');
        return;
      }

      const send = (data: string): void => {
        if (socket.readyState === WS_OPEN) socket.send(data);
      };

      // Snapshot-then-live handoff. The replay frame carries a serialized
      // snapshot of the mirrored screen (valid on a fresh terminal, unlike a
      // raw byte ring), and it must be the FIRST frame: any output or exit
      // arriving while the snapshot is being taken is queued and flushed right
      // after it. Chunks are numbered and the replay says the last one it
      // holds, so a queued chunk already inside it is dropped — no byte is
      // dropped or doubled across the handoff, even when the screen comes from
      // the PTY host and output keeps streaming while its reply travels.
      let replaySent = false;
      const preReplay: Array<{ seq: number | null; frame: string }> = [];
      /** Send a frame, or queue it until the replay is out. `seq` numbers an
       *  output chunk (null for the exit, which no replay holds). */
      const forward = (frame: string, seq: number | null): void => {
        if (!replaySent) preReplay.push({ seq, frame });
        else send(frame);
      };

      const offData = session.onData((chunk, seq) => {
        forward(encodeTerminalFrame({ type: 'output', data: chunk }), seq);
      });

      const offExit = session.onExit((exit) => {
        forward(
          encodeTerminalFrame({ type: 'exit', exitCode: exit.exitCode, signal: exit.signal }),
          null,
        );
      });

      void session.replay().then((replay) => {
        send(
          encodeTerminalFrame({
            type: 'replay',
            data: replay.data,
            cols: replay.cols,
            rows: replay.rows,
          }),
        );
        replaySent = true;
        for (const { seq, frame } of preReplay) {
          if (seq === null || seq > replay.seq) send(frame);
        }
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
