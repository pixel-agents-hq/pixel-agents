/**
 * Driving PC shells from the outside, as an office does: `openPcShell` /
 * `closePcShell` on /ws, the shell's terminal over its socket. Over a
 * standalone office composed by officeMcpHarness.ts (`useStandaloneOffice`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';

import { parseServerFrame } from '../../../core/src/terminalFrames.js';
import { type Json, type StandaloneOffice, waitFor } from './officeMcpHarness.js';

/** The furniture uid of a front PC in the bundled default layout (Blue room in seededLayout). */
export const FRONT_PC = 'f-1773356781294-b69z';
/** Another front PC of that layout (also in the Blue room). */
export const OTHER_PC = 'f-1773356782055-vp70';
/** A desk of that layout: furniture that opens no terminal. */
export const A_DESK = 'f-1773354931010-8vvr';

export interface ShellTerminal {
  /** Everything the shell printed since attaching (the replay included). */
  text(): string;
  /** Type into the shell. */
  type(data: string): void;
  /** Wait for output matching `pattern`; its match. */
  waitFor(pattern: RegExp, what?: string): Promise<RegExpMatchArray>;
  /** The exit frame, once the shell ended. */
  exited(): boolean;
  close(): void;
}

export interface PcShellDriver {
  /** Send openPcShell from an office (the first one unless given); its answer. */
  open(uid: string, ws?: WebSocket, received?: Json[]): Promise<Json>;
  /** Send openPcShell naming a Directory (the office's Directory selector); its answer. */
  openIn(uid: string, directory: string): Promise<Json>;
  /** Send closePcShell; resolves once `until` holds. */
  close(id: number, opts?: { confirmed?: boolean; ws?: WebSocket }): void;
  /** The newest pcShellsLoaded an office was sent (the first office unless given). */
  shells(received?: Json[]): Json[] | null;
  /** Attach to a terminal socket (with the server token unless `token: null`). */
  attach(id: number, opts?: { token?: string | null }): Promise<ShellTerminal>;
  /** How the terminal socket answered an attach without a valid token: its close code. */
  refusedAttach(id: number, token?: string): Promise<number>;
  /** Write a small shell script at `$HOME/bin/<name>` and return its path. */
  script(name: string, body: string): string;
}

export function pcShellDriver(h: StandaloneOffice): PcShellDriver {
  const terminalUrl = (id: number, token: string | null) =>
    `ws://127.0.0.1:${h.port}/terminal/${id}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`;

  const driver: PcShellDriver = {
    async open(uid, ws = h.socket, received = h.received) {
      const before = received.length;
      h.send({ type: 'openPcShell', uid }, ws);
      return waitFor(
        () =>
          received
            .slice(before)
            .find((m) => m.type === 'pcShellReady' || m.type === 'pcShellRejected'),
        `the answer to opening ${uid}`,
      );
    },
    async openIn(uid, directory) {
      const before = h.received.length;
      h.send({ type: 'openPcShell', uid, directory });
      return waitFor(
        () =>
          h.received
            .slice(before)
            .find((m) => m.type === 'pcShellReady' || m.type === 'pcShellRejected'),
        `the answer to opening ${uid} in ${directory}`,
      );
    },
    close(id, { confirmed, ws = h.socket } = {}) {
      h.send({ type: 'closePcShell', id, ...(confirmed ? { confirmed: true } : {}) }, ws);
    },
    shells(received = h.received) {
      const loaded = received.filter((m) => m.type === 'pcShellsLoaded');
      return loaded.length > 0 ? (loaded[loaded.length - 1].shells as Json[]) : null;
    },
    async attach(id, { token = h.token } = {}) {
      const ws = new WebSocket(terminalUrl(id, token));
      let out = '';
      let exited = false;
      ws.on('message', (raw) => {
        const frame = parseServerFrame(String(raw));
        if (!frame) return;
        if (frame.type === 'exit') exited = true;
        else out += frame.data;
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      return {
        text: () => out,
        type: (data) => ws.send(JSON.stringify({ type: 'input', data })),
        waitFor: (pattern, what = String(pattern)) =>
          waitFor(() => pattern.exec(out) ?? undefined, `${what} in the shell`),
        exited: () => exited,
        close: () => ws.close(),
      };
    },
    refusedAttach(id, token) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(terminalUrl(id, token ?? null));
        ws.on('close', (code: number) => resolve(code));
        ws.on('error', () => {
          // The close handler settles it.
        });
        setTimeout(() => reject(new Error('terminal socket timed out')), 5_000);
      });
    },
    script(name, body) {
      const file = path.join(h.home, 'bin', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o755 });
      return file;
    },
  };
  return driver;
}
