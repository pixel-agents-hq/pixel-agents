/**
 * PC shells (CONTEXT.md → Interactive Furniture → PC shell): the plain login
 * shell a PC opens for the user. Not an agent, so it lives in an id space of
 * its own (PC_SHELL_ID_BASE), the one fact the server, the card bar and the
 * terminal panes tell it apart by. Pure.
 */

import { PC_SHELL_HOME_NAME, PC_SHELL_ID_BASE } from './constants.js';
import type { PcShell } from './messages.js';

export type { PcShell };

/**
 * A PC shell as a surface saves it beside its agents (CLAUDE.md → Persistence):
 * what offices are told, and the folder it started in. Saved so a shell whose
 * terminal outlived the server (the PTY host) comes back under the same id.
 */
export interface PersistedPcShell extends PcShell {
  /** The folder it started in. */
  cwd: string;
}

/** Whether an id names a PC shell (and so never an agent). */
export function isPcShellId(id: number): boolean {
  return Number.isSafeInteger(id) && id > PC_SHELL_ID_BASE;
}

/** How a PC shell is named to the user: its Directory's name, or "Home". */
export function pcShellName(shell: Pick<PcShell, 'directoryName'>): string {
  return shell.directoryName ?? PC_SHELL_HOME_NAME;
}

/** Saved PC shells from untrusted JSON: the well-formed entries, each id once. */
export function parsePersistedPcShells(raw: unknown): PersistedPcShell[] {
  if (!Array.isArray(raw)) return [];
  const shells: PersistedPcShell[] = [];
  const seen = new Set<number>();
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, uid, furnitureType, directoryName, cwd } = entry as Record<string, unknown>;
    if (typeof id !== 'number' || !isPcShellId(id) || seen.has(id)) continue;
    if (typeof uid !== 'string' || typeof furnitureType !== 'string' || typeof cwd !== 'string') {
      continue;
    }
    if (directoryName !== undefined && typeof directoryName !== 'string') continue;
    seen.add(id);
    shells.push({
      id,
      uid,
      furnitureType,
      cwd,
      ...(directoryName !== undefined ? { directoryName } : {}),
    });
  }
  return shells;
}
