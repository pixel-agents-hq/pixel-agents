/**
 * PC shells in a VS Code office, through the window's own composition
 * (adapters/vscode/vscodePcShells.ts, vscode-free) over its real terminal
 * adapter (adapters/vscode/vscodeTerminalAdapter.ts) with `vscode` faked:
 * integrated terminals that record where they were opened, whether they were
 * shown, and that close as VS Code's do (the user's ×, or `dispose`).
 * Asserted from outside: what the webview is answered, what every office is
 * told (the store's broadcast), and the terminals VS Code was asked for.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTerminal {
  name: string;
  cwd: string;
  /** Left out of VS Code's persistent sessions (not brought back on reload). */
  isTransient?: boolean;
  shown: number;
  disposed: boolean;
  show(): void;
  dispose(): void;
}

const { terminals, closeListeners } = vi.hoisted(() => ({
  terminals: [] as FakeTerminal[],
  closeListeners: new Set<(terminal: FakeTerminal) => void>(),
}));

/** VS Code closing a terminal: its close event, to every listener. */
function closeInVsCode(terminal: FakeTerminal): void {
  for (const listener of [...closeListeners]) listener(terminal);
}

vi.mock('vscode', () => ({
  window: {
    createTerminal: (options: {
      name: string;
      cwd: string;
      isTransient?: boolean;
    }): FakeTerminal => {
      const terminal: FakeTerminal = {
        name: options.name,
        cwd: options.cwd,
        isTransient: options.isTransient,
        shown: 0,
        disposed: false,
        show() {
          this.shown++;
        },
        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          closeInVsCode(this);
        },
      };
      terminals.push(terminal);
      return terminal;
    },
    onDidCloseTerminal: (listener: (terminal: FakeTerminal) => void) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    get terminals() {
      return terminals;
    },
    activeTerminal: undefined,
  },
}));

import { WebSocket } from 'ws';

import { VscodePcShells } from '../../adapters/vscode/vscodePcShells.js';
import { VscodeTerminalAdapter } from '../../adapters/vscode/vscodeTerminalAdapter.js';
import { PC_SHELL_ID_BASE } from '../../core/src/constants.js';
import type { CatalogSource } from '../../core/src/layout/index.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { handlePcShellMessage } from '../src/pcShells.js';
import { PixelAgentsServer } from '../src/server.js';
import { type Json, loadBundledAssets, seededLayout, waitFor } from './helpers/officeMcpHarness.js';
import { A_DESK, FRONT_PC, OTHER_PC } from './helpers/pcShellDriver.js';
import { removeTempDir } from './helpers/removeTempDir.js';

let catalog: readonly CatalogSource[] = [];
beforeAll(async () => {
  catalog = (await loadBundledAssets()).furniture.catalog;
});

describe('PC shells in a VS Code office (vscode-free composition, fake terminals)', () => {
  let root: string;
  let folder: { name: string; path: string };
  let userDirs: Array<{ name: string; path: string }>;
  let workspaceFolders: Array<{ name: string; path: string }>;
  let areaMappings: Record<string, string[]>;
  let layout: Json;
  let store: AgentStateStore;
  let broadcasts: Json[];
  let replies: Json[];
  let shells: VscodePcShells;

  beforeEach(() => {
    terminals.length = 0;
    closeListeners.clear();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-pc-vscode-')));
    folder = { name: 'proj', path: path.join(root, 'proj') };
    userDirs = [
      { name: 'a', path: path.join(root, 'a') },
      { name: 'b', path: path.join(root, 'b') },
    ];
    workspaceFolders = [folder];
    areaMappings = {};
    layout = seededLayout();
    store = new AgentStateStore();
    broadcasts = [];
    replies = [];
    store.on('broadcast', (m) => broadcasts.push(m as Json));
    shells = new VscodePcShells({
      terminals: new VscodeTerminalAdapter(),
      broadcast: (m) => store.broadcast({ ...m }),
      facts: {
        layout: () => layout,
        catalog: () => catalog,
        readAreaMappings: () => areaMappings,
      },
      directories: () => [...workspaceFolders, ...userDirs],
      workspaceFolders: () => workspaceFolders,
    });
  });

  afterEach(() => {
    shells.dispose();
    store.dispose();
    removeTempDir(root);
  });

  /** What the webview sends, as the provider hands it over; whether it was this module's. */
  const send = (message: Json): boolean =>
    handlePcShellMessage(shells, message, (m) => replies.push(m as Json));
  /** The newest list every office was told of. */
  const announced = (): Json[] | null => {
    const last = broadcasts.filter((m) => m.type === 'pcShellsLoaded').at(-1);
    return last ? (last.shells as Json[]) : null;
  };
  const lastReply = (): Json | undefined => replies.at(-1);
  const open = (uid: string, directory?: string): Json => {
    expect(send({ type: 'openPcShell', uid, ...(directory ? { directory } : {}) })).toBe(true);
    return lastReply()!;
  };

  it("opens an integrated terminal in the single Directory of the PC's Area, announced and shown", () => {
    areaMappings = { a: ['Blue room'] };
    const answer = open(FRONT_PC);
    expect(answer.type).toBe('pcShellReady');
    const id = answer.id as number;
    expect(id).toBeGreaterThan(PC_SHELL_ID_BASE);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].cwd).toBe(userDirs[0].path);
    expect(terminals[0].shown).toBe(1);
    // A card for it (and its PC lit): the piece, its furniture, its Directory.
    expect(announced()).toEqual([
      { id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF', directoryName: 'a' },
    ]);
    expect(shells.has(id)).toBe(true);
    expect(shells.message()).toEqual({ type: 'pcShellsLoaded', shells: announced() });
  });

  it('opens a transient terminal: a window reload never brings back a shell the office forgot', () => {
    open(FRONT_PC);
    expect(terminals[0].isTransient).toBe(true);
  });

  it('opens in the first workspace folder when the Area has no Directory', () => {
    const id = open(FRONT_PC).id as number;
    expect(terminals[0].cwd).toBe(folder.path);
    // Named after that folder, which is one of this window's Directories.
    expect(announced()).toEqual([
      { id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF', directoryName: 'proj' },
    ]);
  });

  it('opens in the first workspace folder for a PC in no Area', () => {
    delete layout.areas;
    delete layout.areaTiles;
    areaMappings = { a: ['Blue room'] };
    open(FRONT_PC);
    expect(terminals[0].cwd).toBe(folder.path);
  });

  it('opens in the home folder when the window has no workspace folder either', () => {
    workspaceFolders = [];
    const id = open(FRONT_PC).id as number;
    expect(terminals[0].cwd).toBe(os.homedir());
    // "Home" on its card: no Directory.
    expect(announced()).toEqual([{ id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF' }]);
  });

  it('honours a chosen Directory of the Area, and with several and none chosen opens in the workspace folder', () => {
    areaMappings = { a: ['Blue room'], b: ['Blue room'] };
    open(FRONT_PC);
    expect(terminals[0].cwd).toBe(folder.path);

    const chosen = open(OTHER_PC, 'b').id as number;
    expect(terminals[1].cwd).toBe(userDirs[1].path);
    expect(announced()?.find((s) => s.id === chosen)?.directoryName).toBe('b');
  });

  it("refuses a chosen Directory that is not one of the Area's", () => {
    areaMappings = { a: ['Blue room'] };
    expect(open(FRONT_PC, 'b')).toMatchObject({ type: 'pcShellRejected', uid: FRONT_PC });
    expect(terminals).toHaveLength(0);
  });

  it('a PC with a live shell shows that terminal and makes no other', () => {
    const first = open(FRONT_PC).id as number;
    const again = open(FRONT_PC);
    expect(again).toEqual({ type: 'pcShellReady', id: first });
    expect(terminals).toHaveLength(1);
    expect(terminals[0].shown).toBe(2);
    expect(announced()).toHaveLength(1);
  });

  it("the shell's card shows its terminal (focusAgent with its id)", () => {
    const id = open(FRONT_PC).id as number;
    expect(send({ type: 'focusAgent', id })).toBe(true);
    expect(terminals[0].shown).toBe(2);
    // An agent's focus is not this module's.
    expect(send({ type: 'focusAgent', id: 1 })).toBe(false);
  });

  it('closing the terminal in VS Code ends the shell for every listener', () => {
    const id = open(FRONT_PC).id as number;
    closeInVsCode(terminals[0]);
    expect(announced()).toEqual([]);
    expect(shells.has(id)).toBe(false);
    // The PC opens a fresh one after.
    const next = open(FRONT_PC).id as number;
    expect(next).not.toBe(id);
    expect(terminals).toHaveLength(2);
  });

  it("the card's × disposes the terminal at once, never asking", () => {
    const id = open(FRONT_PC).id as number;
    expect(send({ type: 'closePcShell', id })).toBe(true);
    expect(terminals[0].disposed).toBe(true);
    expect(announced()).toEqual([]);
    expect(replies.some((m) => m.type === 'pcShellCloseQuestion')).toBe(false);
    // Announced once, not again by VS Code's close event that followed.
    expect(broadcasts.filter((m) => m.type === 'pcShellsLoaded')).toHaveLength(2);
  });

  it('closing other terminals leaves the shells alone', () => {
    open(FRONT_PC);
    closeInVsCode({ ...terminals[0] });
    expect(announced()).toHaveLength(1);
  });

  it('refuses a piece that opens no terminal, or is not in the layout', () => {
    expect(open(A_DESK)).toMatchObject({ type: 'pcShellRejected', uid: A_DESK });
    expect(open('no-such-piece')).toMatchObject({ type: 'pcShellRejected' });
    expect(terminals).toHaveLength(0);
    expect(announced()).toBeNull();
  });

  it('ignores malformed messages and any other type', () => {
    expect(send({ type: 'openPcShell', uid: 7 })).toBe(true);
    expect(send({ type: 'closePcShell', id: 'x' })).toBe(true);
    expect(send({ type: 'launchAgent' })).toBe(false);
    expect(terminals).toHaveLength(0);
    expect(replies).toEqual([]);
  });

  it("the embedded server's /ws offices get the shells on connect and keep their cards in the order, but cannot open one", async () => {
    store.setAdapter(new FileStateAdapter({ namespace: 'vscode' }));
    const id = open(FRONT_PC).id as number;
    // As the provider composes its embedded server: the shells' list, no control.
    const server = new PixelAgentsServer();
    const config = await server.start({ store, embedded: true, pcShells: shells });
    try {
      const received: Json[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      ws.on('message', (raw) => received.push(JSON.parse(String(raw)) as Json));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ type: 'webviewReady' }));
      // The connect snapshot lists the window's shell (a reconnect is a resync).
      await waitFor(
        () => received.find((m) => m.type === 'pcShellsLoaded'),
        'the shells in the snapshot',
      );
      expect(received.find((m) => m.type === 'pcShellsLoaded')!.shells).toEqual(announced());

      // A reorder keeps the shell's card.
      ws.send(JSON.stringify({ type: 'saveCardOrder', order: [id] }));
      await waitFor(
        () => broadcasts.find((m) => m.type === 'cardOrderLoaded'),
        'the reorder broadcast',
      );
      expect(broadcasts.find((m) => m.type === 'cardOrderLoaded')!.order).toEqual([id]);

      // Only the window's own webview opens a shell: a /ws office is not answered.
      ws.send(JSON.stringify({ type: 'openPcShell', uid: OTHER_PC }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.some((m) => m.type === 'pcShellReady' || m.type === 'pcShellRejected')).toBe(
        false,
      );
      expect(terminals).toHaveLength(1);
      ws.close();
    } finally {
      server.stop();
    }
  });

  it('stops following VS Code once disposed', () => {
    open(FRONT_PC);
    shells.dispose();
    expect(closeListeners.size).toBe(0);
  });
});
