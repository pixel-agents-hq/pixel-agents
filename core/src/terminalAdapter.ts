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
  /** Type `text` into `terminal` exactly as given: no line break is added
   *  (a Message's Enter is its own write). What a Message needs of an editor
   *  whose terminals can be typed into but not read. */
  sendText(terminal: TerminalHandle, text: string): void;
}
