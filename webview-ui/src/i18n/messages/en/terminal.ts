/** English strings: terminal. The source of truth — vi/terminal.ts must carry every key. */
export const terminal = {
  // Agent cards (they double as the terminal's tabs)
  agentTitle: 'Agent {id}',
  closeAgent: 'Close agent',
  contextLeft: '{pct}% context left',
  // Terminal panel
  dragToResize: 'Drag to resize',
  hideTerminal: 'Hide terminal',
  emptyTitle: 'No agent terminals yet',
  emptyHint: 'Tap + in the bar below to launch one',
  processExited: 'process exited with code {code}',
  // Touch selection pill + paste
  copyAsText: 'Copy as text',
  pastePrompt: 'Paste into the terminal:',
  // Mobile key bar
  arrowKeys: 'Arrow keys',
} as const;
