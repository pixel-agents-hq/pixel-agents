/**
 * Reading and typing into agents' terminals (Messages) on both TerminalSessions:
 * in process and through the PTY host (development only), each over a fake
 * PTY module — what the program drew is what the screen reads, and the bytes
 * a Message types follow the modes the program set.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ptyAgentTerminals, typeInto } from '../src/terminal/agentTerminals.js';
import type { PtyHost } from '../src/terminal/ptyHost.js';
import { startPtyHost } from '../src/terminal/ptyHost.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { RemotePtySessions } from '../src/terminal/remotePtySessions.js';
import type { TerminalSessions } from '../src/terminal/terminalSessions.js';
import { removeTempDir } from './helpers/removeTempDir.js';

const ESC = '\x1b';

class FakePty implements IPty {
  readonly pid = 4242;
  written: string[] = [];
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  constructor(readonly options: PtySpawnOptions) {}
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  kill(): void {
    queueMicrotask(() => this.exitListener?.({ exitCode: 0 }));
  }
  /** The program draws. */
  emit(data: string): void {
    this.dataListener?.(data);
  }
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SPAWN = { agentId: 1, command: 'claude', args: [], env: {}, cols: 40, rows: 6 };

for (const where of ['in process', 'PTY host'] as const) {
  describe(`agent terminals (${where})`, () => {
    let dir: string;
    let spawned: FakePty[];
    let sessions: TerminalSessions;
    let host: PtyHost | null = null;
    const module: PtyModule = {
      spawn: (_file, _args, options) => {
        const pty = new FakePty(options);
        spawned.push(pty);
        return pty;
      },
    };
    const resolve = () => ({ module, moduleId: 'fake-pty', reason: null });

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxt-'));
      spawned = [];
      if (where === 'in process') {
        sessions = new PtySessionManager(resolve);
      } else {
        const socketPath = path.join(dir, 'h.sock');
        host = await startPtyHost({ socketPath, resolve });
        sessions = await RemotePtySessions.connect({ socketPath });
      }
    });

    afterEach(async () => {
      await sessions.shutdown();
      await host?.close();
      host = null;
      removeTempDir(dir);
    });

    /** Spawn agent 1 and let its program draw `output`. */
    async function drawn(output: string): Promise<FakePty> {
      sessions.create({ ...SPAWN, cwd: dir });
      await until(() => spawned.length === 1);
      // The mirror (here, or in the host) parses it: the screen is read from there.
      spawned[0].emit(output);
      return spawned[0];
    }

    it('reads the visible rows as text, and its token follows the screen', async () => {
      const pty = await drawn(`${ESC}[1mBold${ESC}[0m title\r\n  > prompt   \r\n\r\n`);
      const terminals = ptyAgentTerminals(sessions);
      const screen = (await terminals.screen(1))!;
      expect(screen.text).toBe('Bold title\n  > prompt');
      expect(screen.bracketedPaste).toBe(false);
      expect((await terminals.screen(1))!.token).toBe(screen.token);

      pty.emit('more');
      const after = (await terminals.screen(1))!;
      expect(after.text).toBe('Bold title\n  > prompt\n\nmore');
      expect(after.token).not.toBe(screen.token);
      expect(await terminals.screen(2)).toBeNull();
    });

    it('only the visible rows: what scrolled off is not on the screen', async () => {
      await drawn(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\r\n'));
      const screen = (await ptyAgentTerminals(sessions).screen(1))!;
      expect(screen.text.split('\n')).toEqual([
        'line 4',
        'line 5',
        'line 6',
        'line 7',
        'line 8',
        'line 9',
      ]);
    });

    it('types plain text without bracketed paste, and arrows as SS3 under application cursor keys', async () => {
      const pty = await drawn(`${ESC}[?1hready`);
      const terminals = ptyAgentTerminals(sessions);
      const modes = (await terminals.screen(1))!;
      const write = (bytes: string) => terminals.write(1, bytes);
      // Text, then its Enter (the submit step), then keys.
      await typeInto(write, { text: 'a\nb' }, modes);
      await typeInto(write, { keys: ['enter'] }, modes);
      await typeInto(write, { keys: ['up', 'left', 'enter'] }, modes);
      await until(() => pty.written.length === 5);
      expect(pty.written).toEqual(['a\rb', '\r', `${ESC}OA`, `${ESC}OD`, '\r']);
    });

    it('wraps text in bracketed paste when the program asked for it, dropping markers inside it', async () => {
      const pty = await drawn(`${ESC}[?2004hready`);
      const terminals = ptyAgentTerminals(sessions);
      expect((await terminals.screen(1))!.bracketedPaste).toBe(true);
      await typeInto(
        (bytes) => terminals.write(1, bytes),
        { text: `x${ESC}[201~y` },
        (await terminals.screen(1))!,
      );
      await until(() => pty.written.length === 1);
      expect(pty.written).toEqual([`${ESC}[200~xy${ESC}[201~`]);
    });
  });
}
