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
 * The registry is the shared one (server/src/pcShells.ts); this is VS Code's
 * backend for it. What differs from standalone (server/src/terminal/pcShells.ts):
 * - **The folder falls back to the first workspace folder**, then home: the
 *   chosen Directory of the PC's Area, else its single one, else the window's
 *   first folder (named after it on the card).
 * - **No running-command question**: closing a VS Code terminal is the
 *   user's own act, so the card's × disposes it at once.
 * - **No terminal socket**: the shell is VS Code's; a card or a click on its
 *   PC shows it.
 * A shell is not an agent here either: never in the agent store.
 */

import { pcShellName } from '../../core/src/pcShells.js';
import type { TerminalHandle } from '../../core/src/terminalAdapter.js';
import type { PlaceDirectory } from '../../server/src/pcShellPlace.js';
import { PcShellRegistry, type PcShellRegistryDeps } from '../../server/src/pcShells.js';
import { PC_SHELL_TERMINAL_NAME_PREFIX } from './constants.js';

/** The editor's terminals as PC shells use them. The VS Code adapter's own
 *  (VscodeTerminalAdapter implements it): core's ITerminalAdapter carries
 *  only what the shared runtime calls. */
export interface PcShellTerminals {
  /** Open an ordinary terminal (the user's own shell) named `name` in `cwd`:
   *  a PC shell's. Transient: never restored by the editor after a reload. */
  openTerminal(options: { name: string; cwd: string }): TerminalHandle;
  /** Bring `terminal` to the front. */
  showTerminal(terminal: TerminalHandle): void;
  /** Close `terminal` (its close event follows, as for any other close). */
  disposeTerminal(terminal: TerminalHandle): void;
  /** Every terminal that closes, however it closed (the editor's ×, `exit`,
   *  disposeTerminal); disposing the result stops listening. */
  onTerminalClosed(listener: (terminal: TerminalHandle) => void): { dispose(): void };
}

export interface VscodePcShellsDeps extends Pick<
  PcShellRegistryDeps,
  'facts' | 'directories' | 'broadcast'
> {
  /** The editor's terminals. */
  terminals: PcShellTerminals;
  /** The window's workspace folders, in order: the fallback is the first. */
  workspaceFolders: () => readonly PlaceDirectory[];
}

/** The window's PC shells: the shared registry over integrated terminals. */
export class VscodePcShells extends PcShellRegistry {
  private readonly closing: { dispose(): void };

  constructor(deps: VscodePcShellsDeps) {
    const { terminals } = deps;
    // The terminals a shell's end listens for, by handle.
    const ends = new Map<TerminalHandle, () => void>();
    super({
      facts: deps.facts,
      directories: deps.directories,
      broadcast: deps.broadcast,
      backend: {
        unavailable: () => null,
        fallback: () => deps.workspaceFolders()[0] ?? null,
        start: ({ cwd, directoryName }) => {
          const terminal = terminals.openTerminal({
            name: `${PC_SHELL_TERMINAL_NAME_PREFIX} · ${pcShellName({ directoryName })}`,
            cwd,
          });
          terminals.showTerminal(terminal);
          return {
            onEnd: (listener) => ends.set(terminal, listener),
            end: () => terminals.disposeTerminal(terminal),
            show: () => terminals.showTerminal(terminal),
          };
        },
        // Closing a VS Code terminal is the user's own act: never asked.
      },
    });
    // However a shell's terminal closes, its card goes and its PC turns off.
    this.closing = terminals.onTerminalClosed((closed) => {
      const ended = ends.get(closed);
      if (!ended) return;
      ends.delete(closed);
      ended();
    });
  }

  /** Stop following the editor's terminals (the window's provider is going). */
  dispose(): void {
    this.closing.dispose();
  }
}
