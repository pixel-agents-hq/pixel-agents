import * as vscode from 'vscode';

import type { ITerminalAdapter, TerminalHandle } from '../../core/src/terminalAdapter.js';
import type { PcShellTerminals } from './vscodePcShells.js';

/** VS Code implementation of ITerminalAdapter, and the editor's terminals as
 *  PC shells and Messages use them. Wraps vscode.window terminal access. */
export class VscodeTerminalAdapter implements ITerminalAdapter, PcShellTerminals {
  activeTerminal(): TerminalHandle | undefined {
    return vscode.window.activeTerminal;
  }

  allTerminals(): TerminalHandle[] {
    return [...vscode.window.terminals];
  }

  /** Type `text` into `terminal` exactly as given: no line break is added
   *  (a Message's Enter is its own write). What a Message needs of an editor
   *  whose terminals can be typed into but not read. The editor's own: not
   *  part of core's ITerminalAdapter. */
  sendText(terminal: TerminalHandle, text: string): void {
    // Every handle this adapter hands out (and every agent's terminalRef) is a
    // vscode.Terminal. `shouldExecute: false`: the caller writes its own Enter.
    (terminal as vscode.Terminal).sendText(text, false);
  }

  openTerminal(options: { name: string; cwd: string }): TerminalHandle {
    // No shellPath: VS Code's own default profile, as the user's own "New Terminal".
    // Transient: left out of VS Code's persistent sessions, so a window reload
    // never brings back a terminal the office (memory only) has forgotten.
    return vscode.window.createTerminal({
      name: options.name,
      cwd: options.cwd,
      isTransient: true,
    });
  }

  showTerminal(terminal: TerminalHandle): void {
    (terminal as vscode.Terminal).show();
  }

  disposeTerminal(terminal: TerminalHandle): void {
    (terminal as vscode.Terminal).dispose();
  }

  onTerminalClosed(listener: (terminal: TerminalHandle) => void): { dispose(): void } {
    return vscode.window.onDidCloseTerminal(listener);
  }
}
