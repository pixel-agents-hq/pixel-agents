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
}
