/**
 * PC shells, standalone (CONTEXT.md → Interactive Furniture → PC shell): the
 * plain login shell on the host a PC opens for the user. It runs through the
 * same terminal sessions as agents' terminals (in process or in the PTY host),
 * so its terminal socket and file upload are the agents' own routes under the
 * same gate — but it is NOT an agent: it never enters the agent store, so no
 * provider, session, transcript, hooks, look, seat or gauge, and nothing that
 * enumerates agents (the Pixel Office MCP among them) ever sees it.
 *
 * PcShells is the one owner of the live shells: open (a piece's live shell, or
 * a new one in the single Directory of its Area, else the home folder), close
 * (an idle one at once; one running a command only once confirmed), the
 * shell's own exit, and the list every office is told of (`pcShellsLoaded`).
 */

import { execFile } from 'child_process';
import * as os from 'os';

import { PC_SHELL_ID_BASE } from '../../../core/src/constants.js';
import type { CatalogSource } from '../../../core/src/layout/index.js';
import { layoutFromJson } from '../../../core/src/layout/index.js';
import type { PcShell, PcShellsLoaded } from '../../../core/src/messages.js';
import type { HookProvider } from '../../../core/src/provider.js';
import {
  PC_SHELL_FALLBACK,
  PC_SHELL_NO_TERMINAL_REASON,
  PC_SHELL_PROBE_TIMEOUT_MS,
} from '../constants.js';
import { catalogOf } from '../mcp/seatPlace.js';
import { pcShellPiece, type PlaceDirectory, soleDirectory } from '../pcShellPlace.js';
import { inheritedEnv, terminalEnv } from './terminalEnv.js';
import type { TerminalSessions } from './terminalSessions.js';

/** A live shell as the server keeps it: what offices are told, and its folder. */
export interface PcShellRecord extends PcShell {
  /** The folder it started in. */
  cwd: string;
}

/** What is running in a shell, for the ×: null = idle (only the shell itself). */
export type ForegroundProbe = (shellPid: number) => Promise<{ command?: string } | null>;

export interface PcShellsDeps {
  ptyManager: TerminalSessions;
  /** Tell every open office (the store's broadcast). */
  broadcast: (message: PcShellsLoaded) => void;
  /** The layout as stored (layout.json, else the default one). */
  layout: () => unknown;
  /** The furniture catalogue's data (the loaded assets'). */
  catalog: () => readonly CatalogSource[];
  /** Directory name → the Area labels it is mapped to (config `areaMappings`). */
  areaMappings: () => Readonly<Record<string, readonly string[]>>;
  /** Every Directory a shell may open in: the host's and the user's. */
  directories: () => readonly PlaceDirectory[];
  /** The providers whose CLI session markers a shell must not inherit. */
  providers: ReadonlyArray<Pick<HookProvider, 'isInheritedSessionEnv'>>;
  /** Injectable for tests; production asks `ps` (foregroundOf). */
  foreground?: ForegroundProbe;
}

export type PcShellOpen = { ok: true; id: number } | { ok: false; reason: string };

export type PcShellClose =
  | { closed: true }
  /** A command is running: asked first (`pcShellCloseQuestion`). */
  | { closed: false; question: { command?: string } }
  /** No such live shell. */
  | { closed: false; question: null };

export class PcShells {
  private readonly shells = new Map<number, PcShellRecord>();
  private nextId = PC_SHELL_ID_BASE + 1;

  constructor(private readonly deps: PcShellsDeps) {}

  /** Whether a shell can be opened here: the office runs terminals. */
  get available(): boolean {
    return this.deps.ptyManager.enabled && this.deps.ptyManager.isAvailable();
  }

  has(id: number): boolean {
    return this.shells.has(id);
  }

  /** The live shells, oldest first (folders included: server-side only). */
  records(): PcShellRecord[] {
    return [...this.shells.values()];
  }

  /** What every office is told: the whole list, no folders. */
  message(): PcShellsLoaded {
    return {
      type: 'pcShellsLoaded',
      shells: this.records().map(({ id, uid, furnitureType, directoryName }) => ({
        id,
        uid,
        furnitureType,
        ...(directoryName !== undefined ? { directoryName } : {}),
      })),
    };
  }

  /**
   * Open the PC shell of piece `uid`: its live one when it has one, else a new
   * login shell in the single Directory mapped to the piece's Area, else the
   * home folder. Refused where the office runs no terminals, and for a piece
   * that is not in the layout or opens no terminal.
   */
  open(uid: string): PcShellOpen {
    if (!this.available) {
      return {
        ok: false,
        reason: this.deps.ptyManager.unavailableReason() ?? PC_SHELL_NO_TERMINAL_REASON,
      };
    }
    const live = this.records().find((shell) => shell.uid === uid);
    if (live) return { ok: true, id: live.id };

    const catalog = catalogOf(this.deps.catalog());
    const piece = pcShellPiece({
      layout: layoutFromJson(this.deps.layout()),
      catalog,
      uid,
      areaMappings: this.deps.areaMappings(),
      directories: this.deps.directories(),
    });
    if (!piece.ok) return piece;
    const directory = soleDirectory(piece.directories);
    const cwd = directory?.path ?? os.homedir();

    const id = this.nextId++;
    const shell = loginShell();
    let session;
    try {
      session = this.deps.ptyManager.create({
        agentId: id,
        command: shell.command,
        args: shell.args,
        cwd,
        // An agent's terminal's rules: this process's env without any CLI's
        // session markers, TERM and a UTF-8 locale (here as well as in the
        // PTY: a PTY host spawns with the env it is handed). PWD is the
        // folder it opens in, not the server's.
        env: terminalEnv({ ...inheritedEnv(sessionMarkersOf(this.deps.providers)), PWD: cwd }),
      });
    } catch (err) {
      this.nextId--;
      console.error(`[Pixel Agents] PC shell: spawn failed: ${String(err)}`);
      return { ok: false, reason: `The shell could not start: ${String(err)}` };
    }

    const record: PcShellRecord = {
      id,
      uid,
      furnitureType: piece.type,
      cwd,
      ...(directory ? { directoryName: directory.name } : {}),
    };
    this.shells.set(id, record);
    // `exit` in the shell (or its process ending any other way) ends it as
    // the card's × does.
    session.onExit((exit) => {
      console.log(`[Pixel Agents] PC shell ${id} - exited (code ${exit.exitCode})`);
      this.forget(id);
    });
    this.announce();
    const pid = session.pid !== null ? ` (pid ${session.pid})` : '';
    console.log(
      `[Pixel Agents] PC shell ${id} - ${shell.command} for piece ${uid}${pid} in ${cwd}`,
    );
    return { ok: true, id };
  }

  /**
   * End shell `id` (its card's ×). An idle shell ends at once; one with a
   * command still running is not closed unless `confirmed`, and answers with
   * the question instead.
   */
  async close(id: number, confirmed: boolean): Promise<PcShellClose> {
    if (!this.shells.has(id)) return { closed: false, question: null };
    if (!confirmed) {
      const pid = this.deps.ptyManager.get(id)?.pid ?? null;
      const running = pid === null ? null : await (this.deps.foreground ?? foregroundOf)(pid);
      if (running) return { closed: false, question: running };
      // It may have ended while we looked.
      if (!this.shells.has(id)) return { closed: true };
    }
    this.deps.ptyManager.dispose(id);
    this.forget(id);
    return { closed: true };
  }

  private forget(id: number): void {
    if (!this.shells.delete(id)) return;
    this.announce();
  }

  private announce(): void {
    this.deps.broadcast(this.message());
  }
}

/** The user's login shell: their shell with `-l` (POSIX), else the command interpreter. */
function loginShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: [] };
  }
  let shell = process.env.SHELL;
  if (!shell) {
    try {
      shell = os.userInfo().shell ?? undefined;
    } catch {
      // No passwd entry: the fallback.
    }
  }
  return { command: shell || PC_SHELL_FALLBACK, args: ['-l'] };
}

/** One predicate over every provider's session markers. */
function sessionMarkersOf(
  providers: ReadonlyArray<Pick<HookProvider, 'isInheritedSessionEnv'>>,
): Pick<HookProvider, 'isInheritedSessionEnv'> {
  return { isInheritedSessionEnv: (key) => providers.some((p) => p.isInheritedSessionEnv?.(key)) };
}

function ps(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: PC_SHELL_PROBE_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });
}

/**
 * What runs in the foreground of a shell's terminal, by `ps`: the terminal's
 * foreground process group (`tpgid`) is the shell's own while it waits at its
 * prompt, a command's while one runs. A probe that can't answer counts as
 * running (asking costs a click; guessing idle could kill a build). Windows
 * has no such probe: its shells close at once.
 */
export const foregroundOf: ForegroundProbe = async (shellPid) => {
  if (process.platform === 'win32') return null;
  const group = Number(await ps(['-o', 'tpgid=', '-p', String(shellPid)]));
  if (!Number.isInteger(group) || group <= 0) return {};
  if (group === shellPid) return null;
  const command = await ps(['-o', 'comm=', '-p', String(group)]);
  return command ? { command: command.split('/').pop() ?? command } : {};
};
