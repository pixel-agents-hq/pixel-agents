import * as vscode from 'vscode';

import type { ITerminalAdapter, TerminalHandle } from '../../core/src/terminalAdapter.js';

/** VS Code implementation of ITerminalAdapter. Wraps vscode.window terminal access. */
export class VscodeTerminalAdapter implements ITerminalAdapter {
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
}
