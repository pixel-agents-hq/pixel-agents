/**
 * The `shells` capability: PC shells (CONTEXT.md → PC shell) as agents drive
 * them over the Pixel Office MCP — listed, opened at a PC, read, typed into
 * and closed. Everything goes through the surface's PC shell registry, the one
 * an office's clicks drive (server/src/pcShells.ts), so an agent's open shows
 * the user the same card, lit PC and terminal, and meets the same refusals.
 * No office opened it, so no office is sent `pcShellReady`: its drawer stays
 * where it is, and the `pcShellsLoaded` broadcast puts up the card.
 *
 * Reading and typing go through the registry's own terminal seam (standalone
 * terminal/pcShells.ts `screen` / `write`), never the agents' one, which
 * refuses shell ids. Typing is the Message's `typeInto` with no sender tag
 * (a shell is no conversation) and no screen token (there is no other
 * agent's turn to guard; the agent reads the screen when it wants to).
 */

import type { PersistedPcShell } from '../../../core/src/pcShells.js';
import { MESSAGE_SUBMIT_DELAY_MS } from '../constants.js';
import { pause } from '../pause.js';
import type { PcShellClose, PcShellOpen, PcShellPc } from '../pcShells.js';
import { typeInto } from '../terminal/agentTerminals.js';
import type { TerminalScreen } from '../terminal/terminalScreen.js';
import type { OfficePcShell, PcShellOps } from './officeOperations.js';

/** What a surface's PC shells give the MCP (standalone's StandalonePcShells). */
export interface McpPcShells {
  records(): PersistedPcShell[];
  pcs(): PcShellPc[];
  open(uid: string, directory?: string): PcShellOpen;
  close(id: number, confirmed: boolean): Promise<PcShellClose>;
  running(id: number): Promise<{ command?: string } | null | undefined>;
  screen(id: number): Promise<TerminalScreen | null>;
  write(id: number, bytes: string): void;
}

export function noShellReason(id: number): string {
  return `There is no PC shell ${id}: see list_pc_shells for the live ones.`;
}

export function createPcShellOps(shells: McpPcShells): PcShellOps {
  const recordOf = (id: number) => shells.records().find((r) => r.id === id);

  return {
    async listPcShells() {
      const pcs = shells.pcs();
      const inLayout = new Set(pcs.map((pc) => pc.uid));
      const listed = await Promise.all(
        shells.records().map(async (r): Promise<OfficePcShell> => {
          const running = await shells.running(r.id);
          return {
            id: r.id,
            furnitureUid: r.uid && inLayout.has(r.uid) ? r.uid : null,
            directory: r.directoryName ?? null,
            cwd: r.cwd,
            busy: Boolean(running),
            ...(running?.command ? { command: running.command } : {}),
          };
        }),
      );
      return {
        shells: listed,
        pcs: pcs.map((pc) => ({
          furnitureUid: pc.uid,
          area: pc.area,
          directories: pc.directories.map((d) => d.name),
          shellId: pc.shellId,
        })),
      };
    },

    openPcShell(uid, directory) {
      const opened = shells.open(uid, directory);
      if (!opened.ok) return opened;
      const record = recordOf(opened.id);
      return {
        ok: true,
        id: opened.id,
        cwd: record?.cwd ?? '',
        directory: record?.directoryName ?? null,
        alreadyOpen: opened.existing,
      };
    },

    async readPcShell(id) {
      const screen = await shells.screen(id);
      if (!screen) return { ok: false, reason: noShellReason(id) };
      return { ok: true, screen: { text: screen.text, token: screen.token } };
    },

    async typeInPcShell(id, input) {
      // Its modes: a paste is bracketed only when the program in it asked.
      const screen = await shells.screen(id);
      if (!screen) return { ok: false, reason: noShellReason(id) };
      const write = (bytes: string) => shells.write(id, bytes);
      try {
        if ('keys' in input) {
          await typeInto(write, input, screen);
          return { ok: true };
        }
        await typeInto(write, { text: input.text }, screen);
        if (input.submit) {
          // Its own write, after the paste has landed: see MESSAGE_SUBMIT_DELAY_MS.
          await pause(MESSAGE_SUBMIT_DELAY_MS);
          await typeInto(write, { keys: ['enter'] }, screen);
        }
        return { ok: true };
      } catch {
        // It ended while we typed.
        return { ok: false, reason: noShellReason(id) };
      }
    },

    async closePcShell(id, confirmed) {
      const outcome = await shells.close(id, confirmed);
      if (outcome.closed) return { ok: true };
      if ('gone' in outcome) return { ok: false, reason: noShellReason(id) };
      const { command } = outcome.question;
      const what = command ? `\`${command}\` is` : 'A command is';
      return {
        ok: false,
        reason:
          `${what} still running in PC shell ${id}. Closing ends it: call close_pc_shell again ` +
          'with `confirmed: true` if that is what you want (or press ctrl+c with type_in_pc_shell first).',
        ...(command ? { command } : {}),
      };
    },
  };
}
