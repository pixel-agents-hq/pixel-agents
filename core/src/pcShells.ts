/**
 * PC shells (CONTEXT.md → Interactive Furniture → PC shell): the plain login
 * shell a PC opens for the user. Not an agent, so it lives in an id space of
 * its own (PC_SHELL_ID_BASE), the one fact the server, the card bar and the
 * terminal panes tell it apart by. Pure.
 */

import { PC_SHELL_HOME_NAME, PC_SHELL_ID_BASE } from './constants.js';
import type { PcShell } from './messages.js';

export type { PcShell };

/** Whether an id names a PC shell (and so never an agent). */
export function isPcShellId(id: number): boolean {
  return Number.isSafeInteger(id) && id > PC_SHELL_ID_BASE;
}

/** How a PC shell is named to the user: its Directory's name, or "Home". */
export function pcShellName(shell: Pick<PcShell, 'directoryName'>): string {
  return shell.directoryName ?? PC_SHELL_HOME_NAME;
}
