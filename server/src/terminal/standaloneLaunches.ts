/**
 * The standalone office's launches, as operations: a launch into a Directory
 * (or into a new Worktree of it) and a resume of a past conversation. The
 * drawer and the conversation list (clientMessageHandler) and the Pixel Office
 * MCP's launch_agent all run these, so Directory defaults, characters, the
 * seat preference, the Worktree rules, the resume checks and the permission
 * posture are one set of rules whoever asks.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { WorktreeBranch } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { LAUNCH_JOIN_SETTLE_MS, LAUNCH_JOIN_TIMEOUT_MS } from '../constants.js';
import {
  directoryAt,
  expandTilde,
  type HostDirectoryEntry,
  listDirectories,
} from '../directories.js';
import type { AgentLaunch, AgentLaunchOutcome } from '../mcp/officeOperations.js';
import { recordCharacterUse } from '../recentCharacters.js';
import { prepareWorktreeLaunch, retireUnlaunched } from '../worktreeLaunch.js';
import { worktreeOptionsFor } from '../worktreeOptions.js';
import { resumeConversation, type ResumeOutcome } from '../worktreeResume.js';
import { checkLaunchAsks, type LaunchAsks } from './launchAsks.js';
import {
  launchStandaloneAgent,
  type LaunchStandaloneAgentDeps,
  type LaunchStandaloneAgentOptions,
} from './standaloneAgentLauncher.js';
import type { TerminalSession, TerminalSessions } from './terminalSessions.js';

/** The host's skip-permissions setting (Settings → the launch posture). */
export const KEY_BYPASS_PERMISSIONS = 'pixel-agents.bypassPermissions';

export interface StandaloneLaunchDeps extends LaunchStandaloneAgentDeps {
  /** This host's own Directories (the start directory), shown or not: a
   *  launch into one is named after it. */
  hostDirectories: HostDirectoryEntry[];
}

/** How a launch went: its agent, or why it launched none. A refusal with
 *  `rejectedAt` is one the office is told of with `worktreeRejected`. */
export type LaunchOutcome = ResumeOutcome;

/** Why the terminal can't start one now, or null when it can. */
export function terminalUnavailableReason(ptyManager: TerminalSessions): string | null {
  return ptyManager.isAvailable()
    ? null
    : (ptyManager.unavailableReason() ?? 'The terminal is unavailable.');
}

/** Whether the office allows skipping permissions (its persisted posture). */
export function bypassPermissionsAllowed(store: AgentStateStore): boolean {
  return store.getAdapter()?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false;
}

/** A launch's asks checked against this office's posture (launchAsks.ts). */
function checkedAsks(deps: StandaloneLaunchDeps, asks: LaunchAsks | undefined) {
  return checkLaunchAsks(deps.provider, bypassPermissionsAllowed(deps.store), asks);
}

/** A roster pick moves to the front of every office's roster, once an agent
 *  wears it: a launch that failed records nothing. */
function recordPick(store: AgentStateStore, picked: number | undefined): void {
  const recent = recordCharacterUse(picked);
  if (recent) store.broadcast(recent);
}

/**
 * Launch an agent into the Directory at `directoryPath` (absent = the server
 * cwd), or, with `worktree`, into a new Worktree of it (made first; refused
 * with `rejectedAt` when it can't be, or when its terminal then can't start).
 * `palette` is a roster pick.
 */
export async function launchIntoDirectory(
  deps: StandaloneLaunchDeps,
  request: {
    directoryPath?: string;
    palette?: number;
    worktree?: { name?: string; from?: WorktreeBranch };
    asks?: LaunchAsks;
    /** Pixel Office MCP tools it may call without a prompt (the tutorial agent). */
    preapprovedMcpTools?: readonly string[];
    /** A plugin folder this session alone loads (the tutorial's onboarding skill). */
    pluginDir?: string;
  },
): Promise<LaunchOutcome> {
  const { store, ptyManager } = deps;
  const { directoryPath, palette } = request;
  const directory = directoryAt(directoryPath ?? process.cwd(), deps.hostDirectories);
  const checked = checkedAsks(deps, request.asks);
  if (!checked.ok) return checked;
  const launch = (where: Partial<LaunchStandaloneAgentOptions>): number | null => {
    const id = launchStandaloneAgent(deps, {
      ...where,
      directory,
      asks: checked.asks,
      palette,
      preapprovedMcpTools: request.preapprovedMcpTools,
      pluginDir: request.pluginDir,
    });
    if (id !== null) recordPick(store, palette);
    return id;
  };

  if (!request.worktree) {
    const id = launch({ cwd: directoryPath });
    return id === null ? { ok: false, reason: couldNotStart(ptyManager) } : { ok: true, id };
  }
  const rejectedAt = directoryPath ?? process.cwd();
  const prepared = await prepareWorktreeLaunch({
    directoryPath: rejectedAt,
    directory,
    terminalUnavailable: terminalUnavailableReason(ptyManager),
    ...request.worktree,
  });
  if (!prepared.ok) return { ok: false, reason: prepared.reason, rejectedAt };
  const id = launch(prepared.where);
  if (id === null) {
    return { ok: false, reason: retireUnlaunched(store, prepared.where), rejectedAt };
  }
  return { ok: true, id };
}

/**
 * Resume the conversation `sessionId` of the Directory at `directoryPath`
 * (worktreeResume's rules: its Worktree brought back first, refused with
 * `rejectedAt` when it can't be). It comes back as the agent it was (look,
 * seat) unless `palette` or the asked seat say otherwise.
 */
export async function resumeInDirectory(
  deps: StandaloneLaunchDeps,
  request: { sessionId: unknown; directoryPath: unknown; palette?: number; asks?: LaunchAsks },
): Promise<LaunchOutcome> {
  const { store, ptyManager, provider } = deps;
  const checked = checkedAsks(deps, request.asks);
  if (!checked.ok) return checked;
  return resumeConversation(
    {
      store,
      provider,
      directoryFor: (directoryPath) => directoryAt(directoryPath, deps.hostDirectories),
      terminalUnavailable: () => terminalUnavailableReason(ptyManager),
      launch: (options) => {
        const id = launchStandaloneAgent(deps, {
          ...options,
          // The asked seat wins over the one it sat in; without one, its old seat.
          asks: checked.asks,
          palette: request.palette ?? options.palette,
        });
        if (id !== null && request.palette !== undefined) recordPick(store, request.palette);
        return id;
      },
    },
    { sessionId: request.sessionId, directoryPath: request.directoryPath },
  );
}

function couldNotStart(ptyManager: TerminalSessions): string {
  return terminalUnavailableReason(ptyManager) ?? "The agent's terminal could not start.";
}

// ── The Pixel Office MCP's launch ───────────────────────────

/**
 * The folder a launch_agent `directory` names: a Directory by name (exactly,
 * else ignoring case), else a path (`~` expanded) — a Directory's, or any
 * existing folder (an agent then of no Directory, named after the folder, as
 * a drawer launch outside the Directories is).
 */
export function resolveLaunchDirectory(
  hostDirectories: HostDirectoryEntry[],
  nameOrPath: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const directories = listDirectories(hostDirectories);
  const wanted = nameOrPath.trim();
  const byName =
    directories.find((d) => d.name === wanted) ??
    directories.find((d) => d.name.toLowerCase() === wanted.toLowerCase());
  if (byName) return { ok: true, path: byName.path };
  const expanded = expandTilde(wanted);
  if (path.isAbsolute(expanded)) {
    const directory = directoryAt(expanded, hostDirectories);
    if (directory) return { ok: true, path: directory.path };
    if (isFolder(expanded)) return { ok: true, path: expanded };
  }
  const names = directories.map((d) => d.name).join(', ');
  return {
    ok: false,
    reason: `${wanted} is neither a Directory nor an existing folder (an absolute path). The Directories are: ${names || 'none'}.`,
  };
}

function isFolder(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The branch a launch_agent Worktree starts from: a local branch by name,
 *  else origin's (`origin/<name>` names origin's alone). */
async function resolveWorktreeFrom(
  deps: StandaloneLaunchDeps,
  directoryPath: string,
  from: string,
): Promise<{ ok: true; branch: WorktreeBranch } | { ok: false; reason: string }> {
  const directory = directoryAt(directoryPath, deps.hostDirectories);
  if (!directory) return { ok: false, reason: `${directoryPath} is not a Directory.` };
  const options = await worktreeOptionsFor(directory);
  if (!options.ok) return options;
  const branches = options.message.branches;
  const originName = from.startsWith('origin/') ? from.slice('origin/'.length) : undefined;
  const branch =
    (originName === undefined
      ? branches.find((b) => b.location === 'local' && b.name === from)
      : undefined) ??
    branches.find((b) => b.location === 'origin' && b.name === (originName ?? from));
  if (branch) return { ok: true, branch: { name: branch.name, location: branch.location } };
  const listed = branches
    .map((b) => (b.location === 'origin' ? `origin/${b.name}` : b.name))
    .join(', ');
  return {
    ok: false,
    reason: `There is no branch ${from} to start the Worktree from. Branches: ${listed || 'none'}.`,
  };
}

/**
 * launch_agent on the standalone surface: the launch (or resume) through the
 * same operations as the drawer and the conversation list, then the wait for
 * the agent to join — its CLI drawing on its terminal and still running
 * `LAUNCH_JOIN_SETTLE_MS` later — for at most `LAUNCH_JOIN_TIMEOUT_MS` from
 * the call (a Worktree being made counts against it; a launch still under way
 * then carries on).
 */
export async function launchForOffice(
  deps: StandaloneLaunchDeps,
  request: AgentLaunch,
  timeoutMs = LAUNCH_JOIN_TIMEOUT_MS,
): Promise<AgentLaunchOutcome> {
  const deadline = Date.now() + timeoutMs;
  const seconds = Math.round(timeoutMs / 1000);
  const late = (): AgentLaunchOutcome => ({
    ok: false,
    reason: `The launch didn't finish within ${seconds} s. It may still join: check list_agents.`,
  });
  const launched = await beforeDeadline(launchOrResume(deps, request), deadline);
  if (launched === null) return late();
  if (!launched.ok) return { ok: false, reason: launched.reason };
  const session = deps.ptyManager.get(launched.id);
  if (!session) return { ok: false, reason: `Agent ${launched.id}'s terminal is gone.` };
  const joined = await joinOf(session, deadline - Date.now());
  if (joined === null) {
    return {
      ok: false,
      reason: `Agent ${launched.id} was launched, but its CLI hasn't started within ${seconds} s: read its terminal (read_agent_terminal) or check list_agents.`,
    };
  }
  if (!joined.ok) return { ok: false, reason: `Agent ${launched.id} ${joined.reason}` };
  return { ok: true, id: launched.id };
}

async function launchOrResume(
  deps: StandaloneLaunchDeps,
  request: AgentLaunch,
): Promise<LaunchOutcome> {
  const where = resolveLaunchDirectory(deps.hostDirectories, request.directory);
  if (!where.ok) return where;
  const { asks } = request;
  if (request.resumeSessionId !== undefined) {
    if (request.worktree) {
      return {
        ok: false,
        reason:
          'A resume runs where its conversation ran (its own Worktree, if it had one): leave `worktree` out.',
      };
    }
    return resumeInDirectory(deps, {
      sessionId: request.resumeSessionId,
      directoryPath: where.path,
      palette: request.palette,
      asks,
    });
  }
  let worktree: { name?: string; from?: WorktreeBranch } | undefined;
  if (request.worktree) {
    worktree = request.worktree.name !== undefined ? { name: request.worktree.name } : {};
    if (request.worktree.from !== undefined) {
      const from = await resolveWorktreeFrom(deps, where.path, request.worktree.from);
      if (!from.ok) return from;
      worktree.from = from.branch;
    }
  }
  return launchIntoDirectory(deps, {
    directoryPath: where.path,
    palette: request.palette,
    worktree,
    asks,
  });
}

/** The agent's CLI drew on its terminal and was still running a moment
 *  later; or it exited first, and how; or null when `withinMs` ran out first.
 *  Every listener is dropped whichever way it ends. Output drawn before this
 *  was asked (a resume awaits git after its launch) counts: the replay says. */
function joinOf(
  session: TerminalSession,
  withinMs: number,
): Promise<{ ok: true } | { ok: false; reason: string } | null> {
  return new Promise((resolve) => {
    let output = '';
    let settle: NodeJS.Timeout | undefined;
    let settled = false;
    const done = (result: { ok: true } | { ok: false; reason: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(settle);
      clearTimeout(limit);
      stopData();
      stopExit();
      resolve(result);
    };
    const drew = () => {
      settle ??= setTimeout(() => done({ ok: true }), LAUNCH_JOIN_SETTLE_MS);
    };
    const limit = setTimeout(() => done(null), Math.max(0, withinMs));
    const stopData = session.onData((chunk) => {
      output += chunk;
      drew();
    });
    const stopExit = session.onExit((exit) => {
      const said = lastLines(output);
      done({
        ok: false,
        reason: `exited as it started (code ${exit.exitCode})${said ? `, saying:\n${said}` : '.'}`,
      });
    });
    void session.replay().then(
      (replay) => {
        if (replay.seq === 0) return;
        if (!output) output = replay.data;
        drew();
      },
      () => {},
    );
  });
}

/** The last few lines a terminal printed, escape sequences dropped. */
function lastLines(output: string): string {
  const plain = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
  return plain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-5)
    .join('\n');
}

/** `work`'s value, or null once `deadline` passes first (the work carries on). */
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
