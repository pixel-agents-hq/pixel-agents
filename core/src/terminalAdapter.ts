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
