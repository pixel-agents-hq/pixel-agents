/**
 * Minimal terminal interface for fileWatcher's terminal adoption logic.
 * Only exposes the `.name` property needed for matching terminals to agents.
 */
export interface TerminalHandle {
  name: string;
}

/**
 * Adapter for terminal access. VS Code provides vscode.window.activeTerminal
 * and vscode.window.terminals; standalone server has no terminals.
 */
export interface ITerminalAdapter {
  activeTerminal(): TerminalHandle | undefined;
  allTerminals(): TerminalHandle[];
}
