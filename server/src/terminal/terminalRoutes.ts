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
 *
 * The file upload (`POST /api/terminal/:agentId/files`) writes a file onto
 * this machine, so it sits behind the SAME verdict and same-origin check, and
 * only for an agent with a terminal. What it saves, where and under what name
 * is fileUploads.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'stream';

import {
  TERMINAL_FILES_API_PREFIX,
  TERMINAL_FILES_LOCATE_SUFFIX,
  TERMINAL_UPLOAD_MAX_BYTES,
  TERMINAL_WS_PREFIX,
} from '../../../core/src/constants.js';
import { encodeTerminalFrame, parseClientFrame } from '../../../core/src/terminalFrames.js';
import {
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_NO_SESSION,
  WS_CLOSE_UNAUTHORIZED,
} from '../constants.js';
import { isAllowedWebSocketOrigin, isLoopbackHost, standaloneHandshakeVerdict } from '../wsAuth.js';
import {
  defaultUploadDirectory,
  saveUpload,
  sweepUploads,
  terminalPathText,
  uploadFileName,
  UploadTooLargeError,
} from './fileUploads.js';
import { findLocalFile, parseSentFileIdentity, usualSourceDirectories } from './localFile.js';
import type { TerminalSessions } from './terminalSessions.js';

export interface TerminalRoutesOptions {
  token: string;
  /** Host names a privileged handshake may arrive under (wsAuth.privilegedHostnames). */
  allowedHostnames: ReadonlySet<string>;
  ptyManager?: TerminalSessions;
  /** The directory sent files are saved in, absolute, read per upload (a
   *  setting the user can change while the server runs). */
  uploadDirectory: () => string;
  /** More folders a sent file's original is looked for in, beside the usual
   *  ones: the Directories the user added (read per request). */
  sourceDirectories?: () => string[];
  /** The largest upload accepted (tests lower it). */
  maxUploadBytes?: number;
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

  registerFileUploadRoute(app, options, ptyManager);

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

/**
 * `POST /api/terminal/:agentId/files?name=<file name>&token=<server token>`,
 * the file as the raw body (`application/octet-stream`). Answers
 * `{ path, text }`: where the file was saved, and that path as the terminal
 * should receive it (quoted the way this OS's terminals type a dropped file).
 * `POST …/files/locate` answers the same shape for a file found on this disk.
 */
function registerFileUploadRoute(
  app: FastifyInstance,
  options: TerminalRoutesOptions,
  ptyManager: TerminalSessions,
): void {
  const maxBytes = options.maxUploadBytes ?? TERMINAL_UPLOAD_MAX_BYTES;
  const filesPath = `${TERMINAL_FILES_API_PREFIX}/:agentId/files`;
  const params = {
    type: 'object',
    properties: { agentId: { type: 'string', pattern: '^[0-9]+$' } },
    required: ['agentId'],
  } as const;

  /** The terminal socket's gate, for both file routes: the token under an
   *  allowed Host, same-origin, and an agent that has a terminal. Sends the
   *  refusal and returns true when the request may not go on. */
  const refused = (
    request: FastifyRequest<{ Params: { agentId: string } }>,
    reply: FastifyReply,
  ) => {
    const verdict = standaloneHandshakeVerdict(
      request.url,
      request.headers.host,
      options.token,
      options.allowedHostnames,
    );
    if (verdict === 'bad-token') {
      void reply.code(401).send({ error: 'unauthorized' });
    } else if (
      verdict === 'untrusted-host' ||
      !isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)
    ) {
      void reply.code(403).send({ error: 'forbidden origin' });
    } else if (!ptyManager.has(Number(request.params.agentId))) {
      void reply.code(404).send({ error: 'no terminal for agent' });
    } else {
      return false;
    }
    return true;
  };

  // A browser on this machine asks first whether the file is already here
  // (localFile.ts): its own path is then answered and nothing is uploaded.
  // Only under a loopback Host -- through a proxy (Tailscale Serve) the
  // browser is on another machine, whose files are not on this disk.
  app.post<{ Params: { agentId: string }; Body: unknown }>(
    `${filesPath}${TERMINAL_FILES_LOCATE_SUFFIX}`,
    { schema: { params } },
    async (request, reply) => {
      if (refused(request, reply)) return reply;
      const file = isLoopbackHost(request.headers.host)
        ? parseSentFileIdentity(request.body)
        : null;
      const found = file
        ? await findLocalFile(file, [
            ...usualSourceDirectories(),
            options.uploadDirectory(),
            ...(options.sourceDirectories?.() ?? []),
          ])
        : null;
      if (!found) return reply.code(404).send({ error: 'not on this machine' });
      return reply.send({ path: found, text: terminalPathText(found, process.platform) });
    },
  );

  // Its own scope: the raw-stream body parser must not reach other routes.
  void app.register(async (scope) => {
    // The body is handed over as a stream and written straight to disk (a
    // photo library's video doesn't belong in memory), so the size limit is
    // counted by saveUpload rather than by Fastify.
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload);
    });

    scope.post<{ Params: { agentId: string }; Querystring: { name?: string }; Body: Readable }>(
      filesPath,
      {
        schema: { params },
        // Before the body is read: an unauthorized upload is refused without
        // a byte of it being taken in.
        onRequest: async (request, reply) => {
          if (refused(request, reply)) return reply;
          if (Number(request.headers['content-length'] ?? 0) > maxBytes) {
            return reply.code(413).send({ error: 'file too large' });
          }
        },
      },
      async (request, reply) => {
        const name = uploadFileName(String(request.query.name ?? ''));
        try {
          const directory = options.uploadDirectory();
          const filePath = await saveUpload(request.body, directory, name, maxBytes);
          // Our own folder is kept under its size limit as it fills, not only
          // by the daily sweep: a run of large files must not fill the disk.
          if (directory === defaultUploadDirectory()) {
            void sweepUploads(directory, Date.now(), undefined, filePath);
          }
          return await reply.send({
            path: filePath,
            text: terminalPathText(filePath, process.platform),
          });
        } catch (err) {
          if (err instanceof UploadTooLargeError) {
            // The rest of the body is left unread, so this connection ends here.
            return reply.code(413).header('connection', 'close').send({ error: 'file too large' });
          }
          console.error('[Pixel Agents] Saving a file sent to a terminal failed:', err);
          return reply.code(500).send({ error: "couldn't save the file" });
        }
      },
    );
  });
}
