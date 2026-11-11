/**
 * PC shells as the VS Code window keeps them (CONTEXT.md → Interactive
 * Furniture → PC shell): a free PC opens an ordinary integrated terminal, and
 * the window tracks it like an agent's — announced to every office
 * (`pcShellsLoaded` through the store's broadcast), a card, its PC lit —
 * until the terminal closes, however it closes (VS Code's own ×, `exit`, the
 * card's ×). Free of the `vscode` module, so it is tested as it runs
 * (server/__tests__/pcShellsVsCode.test.ts): the editor's terminals come in
 * through the terminal adapter (core/src/terminalAdapter.ts).
 *
 * What differs from standalone (server/src/terminal/pcShells.ts):
 * - **The folder falls back to the first workspace folder**, then home: the
 *   chosen Directory of the PC's Area, else its single one, else the window's
 *   first folder (named after it on the card).
 * - **No running-command question**: closing a VS Code terminal is the
 *   user's own act, so the card's × disposes it at once.
 * - **No terminal socket**: the shell is VS Code's; a card or a click on its
 *   PC shows it.
 * A shell is not an agent here either: never in the agent store.
 */

import * as os from 'os';

import { PC_SHELL_ID_BASE } from '../../core/src/constants.js';
import type { CatalogSource } from '../../core/src/layout/index.js';
import { layoutFromJson } from '../../core/src/layout/index.js';
import type { PcShell, PcShellsLoaded } from '../../core/src/messages.js';
import { isPcShellId, pcShellName } from '../../core/src/pcShells.js';
import type { ITerminalAdapter, TerminalHandle } from '../../core/src/terminalAdapter.js';
import { catalogOf } from '../../server/src/mcp/seatPlace.js';
import {
  pcShellPiece,
  type PlaceDirectory,
  shellDirectory,
} from '../../server/src/pcShellPlace.js';
import { PC_SHELL_TERMINAL_NAME_PREFIX } from './constants.js';

export interface VscodePcShellsDeps {
  /** The editor's terminals. */
  terminals: Pick<
    ITerminalAdapter,
    'openTerminal' | 'showTerminal' | 'disposeTerminal' | 'onTerminalClosed'
  >;
  /** Tell every open office (the store's broadcast). */
  broadcast: (message: PcShellsLoaded) => void;
  /** The layout as stored (layout.json, else the default one). */
  layout: () => unknown;
  /** The furniture catalogue's data (the loaded assets'). */
  catalog: () => readonly CatalogSource[];
  /** Directory name → the Area labels it is mapped to (config `vscode.areaMappings`). */
  areaMappings: () => Readonly<Record<string, readonly string[]>>;
  /** Every Directory a shell may open in: the workspace folders and the user's. */
  directories: () => readonly PlaceDirectory[];
  /** The window's workspace folders, in order: the fallback is the first. */
  workspaceFolders: () => readonly PlaceDirectory[];
}

export type VscodePcShellOpen = { ok: true; id: number } | { ok: false; reason: string };

type Send = (message: Record<string, unknown>) => void;

interface LiveShell extends PcShell {
  terminal: TerminalHandle;
}

export class VscodePcShells {
  private readonly shells = new Map<number, LiveShell>();
  private nextId = PC_SHELL_ID_BASE + 1;
  private readonly closing: { dispose(): void };

  constructor(private readonly deps: VscodePcShellsDeps) {
    // However a shell's terminal closes, its card goes and its PC turns off.
    this.closing = deps.terminals.onTerminalClosed((closed) => {
      for (const shell of this.shells.values()) {
        if (shell.terminal === closed) this.forget(shell.id);
      }
    });
  }

  has(id: number): boolean {
    return this.shells.has(id);
  }

  /** What every office is told: the whole list, oldest first. */
  message(): PcShellsLoaded {
    return {
      type: 'pcShellsLoaded',
      shells: [...this.shells.values()].map(({ id, uid, furnitureType, directoryName }) => ({
        id,
        uid,
        furnitureType,
        ...(directoryName !== undefined ? { directoryName } : {}),
      })),
    };
  }

  /**
   * Open the PC shell of piece `uid`, and show it: its live one when it has
   * one, else a new integrated terminal in `directoryName` (refused unless it is one
   * of the Directories mapped to the piece's Area), else the Area's single one,
   * else the first workspace folder, else the home folder.
   */
  open(uid: string, directoryName?: string): VscodePcShellOpen {
    const live = [...this.shells.values()].find((shell) => shell.uid === uid);
    if (live) {
      this.deps.terminals.showTerminal(live.terminal);
      return { ok: true, id: live.id };
    }

    const piece = pcShellPiece({
      layout: layoutFromJson(this.deps.layout()),
      catalog: catalogOf(this.deps.catalog()),
      uid,
      areaMappings: this.deps.areaMappings(),
      directories: this.deps.directories(),
    });
    if (!piece.ok) return piece;
    // The standalone server's own rule: a named Directory must be one of the Area's.
    const chosen = shellDirectory(piece.directories, directoryName);
    if (!chosen.ok) return chosen;
    const directory = chosen.directory ?? this.deps.workspaceFolders()[0] ?? null;
    const cwd = directory?.path ?? os.homedir();
    const named = directory ? { directoryName: directory.name } : {};

    let terminal: TerminalHandle;
    try {
      terminal = this.deps.terminals.openTerminal({
        name: `${PC_SHELL_TERMINAL_NAME_PREFIX} · ${pcShellName(named)}`,
        cwd,
      });
    } catch (err) {
      console.error(`[Pixel Agents] PC shell: the terminal failed to open: ${String(err)}`);
      return { ok: false, reason: `The terminal could not open: ${String(err)}` };
    }
    const id = this.nextId++;
    this.shells.set(id, { id, uid, furnitureType: piece.type, ...named, terminal });
    this.deps.terminals.showTerminal(terminal);
    this.announce();
    console.log(`[Pixel Agents] PC shell ${id} - terminal for piece ${uid} in ${cwd}`);
    return { ok: true, id };
  }

  /** End shell `id` (its card's ×): its terminal disposed, never asked first. */
  close(id: number): void {
    const shell = this.shells.get(id);
    if (!shell) return;
    // Forgotten first, so VS Code's close event that follows finds nothing.
    this.forget(id);
    this.deps.terminals.disposeTerminal(shell.terminal);
  }

  /** Show shell `id`'s terminal (its card pressed); false when there is none. */
  show(id: number): boolean {
    const shell = this.shells.get(id);
    if (!shell) return false;
    this.deps.terminals.showTerminal(shell.terminal);
    return true;
  }

  /**
   * The webview's PC shell messages: `openPcShell` (answered `pcShellReady` /
   * `pcShellRejected` on `send`), `closePcShell`, and `focusAgent` naming a
   * shell. False for any other message (an agent's focus included).
   */
  handleMessage(message: Record<string, unknown>, send: Send): boolean {
    switch (message.type) {
      case 'openPcShell': {
        if (typeof message.uid !== 'string') return true;
        const directory = typeof message.directory === 'string' ? message.directory : undefined;
        const opened = this.open(message.uid, directory);
        send(
          opened.ok
            ? { type: 'pcShellReady', id: opened.id }
            : { type: 'pcShellRejected', uid: message.uid, reason: opened.reason },
        );
        return true;
      }
      case 'closePcShell':
        if (typeof message.id === 'number') this.close(message.id);
        return true;
      case 'focusAgent':
        if (typeof message.id !== 'number' || !isPcShellId(message.id)) return false;
        this.show(message.id);
        return true;
      default:
        return false;
    }
  }

  /** Stop following the editor's terminals (the window's provider is going). */
  dispose(): void {
    this.closing.dispose();
  }

  private forget(id: number): void {
    if (!this.shells.delete(id)) return;
    this.announce();
  }

  private announce(): void {
    this.deps.broadcast(this.message());
  }
}
