/**
 * PC shells, standalone (CONTEXT.md → Interactive Furniture → PC shell): the
 * registry (../pcShells.ts, shared with VS Code) over this host's backend — the
 * user's login shell on the same terminal sessions as agents' terminals (in
 * process or in the PTY host), so its terminal socket and file upload are the
 * agents' own routes under the same gate. A command still running asks the ×
 * first (`ps`). The live shells are saved beside the agents, and `restore`
 * brings back those whose terminals outlived the last server (only the PTY
 * host keeps them).
 *
 * It is also the ONE owner of how a shell's terminal is read and written
 * (`screen`, `write`): the Pixel Office MCP's shell tools go through it, never
 * through the agents' terminal seam (agentTerminals.ts `ptyAgentTerminals`,
 * which refuses shell ids), and only ever reach a live shell of this registry.
 */

import { execFile } from 'child_process';
import * as os from 'os';

import { isPcShellId, type PersistedPcShell } from '../../../core/src/pcShells.js';
import type { HookProvider } from '../../../core/src/provider.js';
import {
  PC_SHELL_FALLBACK,
  PC_SHELL_NO_TERMINAL_REASON,
  PC_SHELL_PROBE_TIMEOUT_MS,
} from '../constants.js';
import { PcShellRegistry, type PcShellRegistryDeps, type PcShellTerminal } from '../pcShells.js';
import { inheritedEnv, terminalEnv } from './terminalEnv.js';
import { readScreen, type TerminalScreen } from './terminalScreen.js';
import type { TerminalSession, TerminalSessions } from './terminalSessions.js';

/** What is running in a shell, for the ×: null = idle (only the shell itself). */
export type ForegroundProbe = (shellPid: number) => Promise<{ command?: string } | null>;

/** Where the live shells are saved beside the agents (FileStateAdapter). */
export interface PcShellSaves {
  loadPcShells(): PersistedPcShell[];
  savePcShells(shells: PersistedPcShell[]): void;
}

export interface StandalonePcShellsDeps extends Pick<
  PcShellRegistryDeps,
  'facts' | 'directories' | 'broadcast'
> {
  ptyManager: TerminalSessions;
  saves: PcShellSaves;
  /** The providers whose CLI session markers a shell must not inherit. */
  providers: ReadonlyArray<Pick<HookProvider, 'isInheritedSessionEnv'>>;
  /** Injectable for tests; production asks `ps` (foregroundOf). */
  foreground?: ForegroundProbe;
}

export class StandalonePcShells extends PcShellRegistry {
  constructor(private readonly standalone: StandalonePcShellsDeps) {
    const { ptyManager, providers } = standalone;
    super({
      facts: standalone.facts,
      directories: standalone.directories,
      broadcast: standalone.broadcast,
      changed: (records) => standalone.saves.savePcShells(records),
      backend: {
        unavailable: () =>
          ptyManager.enabled && ptyManager.isAvailable()
            ? null
            : (ptyManager.unavailableReason() ?? PC_SHELL_NO_TERMINAL_REASON),
        // No single Directory: the home folder.
        fallback: () => null,
        start: ({ id, cwd }) => {
          const shell = loginShell();
          const session = ptyManager.create({
            agentId: id,
            command: shell.command,
            args: shell.args,
            cwd,
            // An agent's terminal's rules: this process's env without any CLI's
            // session markers, TERM and a UTF-8 locale (here as well as in the
            // PTY: a PTY host spawns with the env it is handed). PWD is the
            // folder it opens in, not the server's.
            env: terminalEnv({ ...inheritedEnv(sessionMarkersOf(providers)), PWD: cwd }),
          });
          const pid = session.pid !== null ? ` (pid ${session.pid})` : '';
          console.log(`[Pixel Agents] PC shell ${id} - ${shell.command}${pid}`);
          return terminalOf(ptyManager, session);
        },
        busy: async (id) => {
          // A PTY host session has no pid until the host's create reply lands:
          // that can't tell, and a probe that can't tell counts as running.
          const pid = ptyManager.get(id)?.pid ?? null;
          if (pid === null) return {};
          return (standalone.foreground ?? foregroundOf)(pid);
        },
      },
    });
  }

  /** Shell `id`'s visible screen (the server's headless mirror of its PTY),
   *  or null when it is no live shell of this registry. */
  async screen(id: number): Promise<TerminalScreen | null> {
    const session = this.sessionOf(id);
    return session ? readScreen(session) : null;
  }

  /** Write bytes to shell `id`'s terminal; throws when it is no live shell. */
  write(id: number, bytes: string): void {
    const session = this.sessionOf(id);
    if (!session) throw new Error(`no PC shell ${id}`);
    session.write(bytes);
  }

  /** A live shell's session: never an agent's terminal, whatever the id. */
  private sessionOf(id: number): TerminalSession | undefined {
    if (!isPcShellId(id) || !this.has(id)) return undefined;
    return this.standalone.ptyManager.get(id);
  }

  /**
   * Bring back the shells whose terminals outlived the last server (only the
   * PTY host keeps them; in process there are none), under their own ids and
   * with what they were announced with. A survivor with no saved record (the
   * state file lost or corrupt) still gets a card of its own — `Home`, no
   * piece — so it can be seen and closed; a shell outlives its piece anyway.
   * Saved shells with no terminal (ended with the last server, or while none
   * ran) are dropped. Runs before the
   * server accepts connections, so the first office's snapshot lists them.
   */
  restore(): number[] {
    const { ptyManager, saves } = this.standalone;
    const saved = new Map(saves.loadPcShells().map((s) => [s.id, s]));
    const restored: number[] = [];
    for (const session of ptyManager.survivors()) {
      const id = session.agentId;
      if (!isPcShellId(id)) continue;
      // Never hand a new shell an id a live terminal still holds (creating a
      // terminal under it would kill that one).
      this.reserve(id);
      if (this.has(id)) continue;
      let record = saved.get(id);
      if (!record) {
        console.warn(
          `[Pixel Agents] PC shell ${id} - running in the PTY host with no saved record; kept as a card of its own.`,
        );
        record = { id, uid: '', furnitureType: '', cwd: os.homedir() };
      }
      this.adopt(record, terminalOf(ptyManager, session));
      restored.push(id);
      console.log(`[Pixel Agents] PC shell ${id} - reattached (pid ${session.pid})`);
    }
    for (const id of saved.keys()) {
      if (!this.has(id)) console.log(`[Pixel Agents] PC shell ${id} - ended; dropped`);
    }
    this.announce();
    return restored;
  }
}

/** A shell's terminal session as the registry drives it. */
function terminalOf(ptyManager: TerminalSessions, session: TerminalSession): PcShellTerminal {
  const id = session.agentId;
  return {
    onEnd: (listener) => {
      session.onExit((exit) => {
        console.log(`[Pixel Agents] PC shell ${id} - exited (code ${exit.exitCode})`);
        listener();
      });
    },
    end: () => ptyManager.dispose(id),
  };
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
 * has no such probe: its shells close at once (CLAUDE.md → PC shells).
 */
export const foregroundOf: ForegroundProbe = async (shellPid) => {
  if (process.platform === 'win32') return null;
  const group = Number(await ps(['-o', 'tpgid=', '-p', String(shellPid)]));
  if (!Number.isInteger(group) || group <= 0) return {};
  if (group === shellPid) return null;
  const command = await ps(['-o', 'comm=', '-p', String(group)]);
  return command ? { command: command.split('/').pop() ?? command } : {};
};
