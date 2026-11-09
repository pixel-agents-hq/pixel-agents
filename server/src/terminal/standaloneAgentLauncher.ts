/**
 * Standalone agent launch: the PTY-backed counterpart to the VS Code adapter's
 * launchNewTerminal().
 *
 * This deliberately MIRRORS adapters/vscode/agentManager.ts rather than sharing
 * a core seam with it: that function imports `vscode` (so it can't move into
 * server/) and takes twelve positional dependencies, so unifying the two would
 * mean rewriting the whole VS Code lifecycle -- out of scope here and a certain
 * conflict with the sibling branches. What IS shared is the thing that matters:
 * both call provider.buildLaunchCommand(), so the launched command is identical.
 * Unifying the hosting is deferred (docs/design/standalone-terminal.md).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentRuntime } from '../agentRuntime.js';
import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import type { CapabilityRegistry } from '../capabilities.js';
import { withoutCapabilityEnv, workspaceKey } from '../capabilities.js';
import { CAPABILITY_ENV_NAME, JSONL_POLL_INTERVAL_MS } from '../constants.js';
import { directoryNameForLaunch } from '../directories.js';
import { startFileWatching } from '../fileWatcher.js';
import { directoryNameFor, hostDirectory } from '../hostDirectory.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import { isValidRoleId } from '../roles.js';
import { removeRoleSnapshot } from '../roleStorage.js';
import type { AgentState } from '../types.js';
import { workspaceIdForDirectory, workspacePermissionRoles } from '../workspaces.js';
import type { PermissionRoles } from '../writeGuard/permissionRoles.js';
import { effectivePermissionRoles } from '../writeGuard/permissionRoles.js';
import type { PtySessionManager } from './ptySessionManager.js';

export interface LaunchStandaloneAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  ptyManager: PtySessionManager;
  provider: HookProvider;
  /**
   * Whether agents launched into this (normalized) Workspace get a capability.
   * Injected only; absent means never. It is deliberately not read from the
   * environment or a global setting, so no configuration can turn issuing on
   * behind the caller's back (S2 ships with no caller passing it).
   */
  isKbEnabled?: (workspaceId: string) => boolean;
  /** Where capabilities are issued and verified. Absent: none is issued. */
  capabilities?: CapabilityRegistry;
}

export interface LaunchStandaloneAgentOptions {
  /** Path of the Directory to launch into. Defaults to the server's cwd, which
   *  is also the Directory standalone contributes as its host entry. */
  directoryPath?: string;
  /** Read from the host's persisted permission posture by the caller; never a
   *  per-launch choice made in the office. */
  bypassPermissions?: boolean;
  cols?: number;
  rows?: number;
  /**
   * The Role this agent launches with, already validated, trusted and copied by
   * the caller (roleClientMessages.ts). Absent: the launch is exactly the
   * pre-Role one. The snapshot is owned from here on: removed on every failure
   * path below and when the agent's process exits. `roleId` is the Role's file
   * name, recorded on the agent as its personal KB identity key; a launch whose
   * roleId fails the Role allowlist is refused before anything starts.
   */
  role?: { name: string; roleId: string; snapshotPath: string };
  /**
   * P3 permission-role override, already validated by the caller: an array is
   * the agent's R/E/D roles, null means no roles (everything allowed). Absent:
   * the Workspace default, else null. The result is snapshotted onto the agent
   * here and never re-read, so a later Workspace change leaves it alone.
   */
  permissionRoles?: PermissionRoles;
}

/**
 * Spawn a Claude agent in a PTY and register it with the runtime.
 * Returns the new agent id, or null when the terminal is unavailable.
 */
export function launchStandaloneAgent(
  deps: LaunchStandaloneAgentDeps,
  options: LaunchStandaloneAgentOptions = {},
): number | null {
  const { store, runtime, ptyManager, provider } = deps;
  const { role } = options;
  const releaseRoleSnapshot = (): void => {
    if (role) removeRoleSnapshot(role.snapshotPath);
  };

  // The identity key must be a listed Role file name: never a path, never `..`.
  if (role && !isValidRoleId(role.roleId)) {
    console.error('[Pixel Agents] Terminal: cannot launch -- invalid Role id');
    releaseRoleSnapshot();
    return null;
  }

  if (!ptyManager.isAvailable()) {
    console.error(`[Pixel Agents] Terminal: cannot launch -- ${ptyManager.unavailableReason()}`);
    releaseRoleSnapshot();
    return null;
  }

  const cwd = options.directoryPath ?? process.cwd();
  const sessionId = crypto.randomUUID();

  // Without a Role the options object is exactly the pre-Role one, so the
  // command is byte-for-byte what it always was.
  const launch = provider.buildLaunchCommand?.(
    sessionId,
    cwd,
    role
      ? { bypassPermissions: options.bypassPermissions, appendSystemPromptFile: role.snapshotPath }
      : { bypassPermissions: options.bypassPermissions },
  );
  if (!launch) {
    console.error('[Pixel Agents] Terminal: provider.buildLaunchCommand is not implemented');
    releaseRoleSnapshot();
    return null;
  }

  let dirs: string[];
  try {
    dirs = provider.getSessionDirs?.(cwd) ?? [];
  } catch (err) {
    // Rethrown unchanged (a launch without a Role behaves as it always did);
    // only the snapshot is released first.
    releaseRoleSnapshot();
    throw err;
  }
  if (dirs.length === 0) {
    console.error('[Pixel Agents] Terminal: provider returned no session dirs');
    releaseRoleSnapshot();
    return null;
  }
  const projectDir = dirs[0];

  // Computed once and shared by the capability and the agent, so the two can
  // never disagree about where the agent was launched. From the Directory the
  // launch names, never from the server cwd: a launch with no directoryPath
  // (or one no Workspace owns) belongs to the default.
  const workspaceId = workspaceIdForDirectory(options.directoryPath);
  // KB rule ownership (writeGuard/kbState.ts): recorded once here, never taken
  // from a hook payload's cwd. Undefined only when the Directory cannot be
  // resolved, in which case the PTY spawn below fails as well.
  const directoryRealPath = realpathOrUndefined(cwd);
  // Permission roles (P3): snapshotted once here, like the Directory above.
  const permissionRoles = effectivePermissionRoles(
    options.permissionRoles,
    workspacePermissionRoles(workspaceId),
  );
  // Only a caller that injected both the registry and isKbEnabled can get a
  // capability; the default is a launch exactly as before.
  const capabilities =
    deps.isKbEnabled?.(workspaceKey(workspaceId)) === true ? deps.capabilities : undefined;

  const id = store.nextAgentId.current++;

  const grant = capabilities?.issue({ agentId: id, sessionId, workspaceId });
  // Layered last, so nothing the provider returns can replace it.
  const env = grant
    ? { ...withoutCapabilityEnv(launch.env ?? {}), [CAPABILITY_ENV_NAME]: grant.token }
    : launch.env;

  let session;
  try {
    session = ptyManager.create({
      agentId: id,
      command: launch.command,
      args: launch.args,
      cwd,
      env,
      cols: options.cols,
      rows: options.rows,
    });
  } catch (err) {
    // Roll the id back so a failed spawn doesn't burn an agent id.
    store.nextAgentId.current--;
    grant?.revoke();
    console.error(`[Pixel Agents] Terminal: spawn failed: ${String(err)}`);
    releaseRoleSnapshot();
    return null;
  }

  // Revocation rides the process from the very first moment it exists, before
  // anything below can throw: a capability never outlives its PTY.
  if (grant) session.onExit(() => grant.revoke());

  let agent: AgentState;
  try {
    agent = registerLaunchedAgent(deps, {
      id,
      sessionId,
      cwd,
      projectDir,
      workspaceId,
      role,
      directoryRealPath,
      permissionRoles,
    });
  } catch (err) {
    // A throwing store listener (or broadcast subscriber) must not leave a
    // live PTY, a valid capability or a half-registered agent behind.
    ptyManager.dispose(id);
    grant?.revoke();
    releaseRoleSnapshot();
    try {
      if (store.has(id)) {
        runtime.unregisterAgent(sessionId);
        runtime.removeAgent(id);
      }
    } catch {
      // Best effort: the same listener may throw again.
    }
    console.error(`[Pixel Agents] Terminal: Agent ${id} - registration failed: ${String(err)}`);
    return null;
  }

  console.log(
    `[Pixel Agents] Terminal: Agent ${id} - spawned ${launch.command} (pid ${session.pid}) in ${cwd}`,
  );

  // The terminal closing is this surface's equivalent of VS Code's
  // "terminal closed -> clean up orphan" pass in fileWatcher.
  session.onExit((exit) => {
    console.log(`[Pixel Agents] Terminal: Agent ${id} - exited (code ${exit.exitCode})`);
    // claude re-reads the file after a compaction, so the snapshot lives
    // exactly as long as the process does.
    releaseRoleSnapshot();
    store.broadcast({ type: 'terminalSessionClosed', agentId: id, exitCode: exit.exitCode });
    if (store.has(id)) {
      runtime.unregisterAgent(agent.sessionId);
      runtime.closeAgent(id);
    }
  });

  startJsonlPoll(deps, id, agent);

  return id;
}

/**
 * Everything between a successful spawn and the exit handler: the agent's
 * state, its registration, and the terminal announcement. Split out so the
 * launcher can undo a failure anywhere in it as one unit.
 */
function registerLaunchedAgent(
  deps: LaunchStandaloneAgentDeps,
  launched: {
    id: number;
    sessionId: string;
    cwd: string;
    projectDir: string;
    workspaceId: string | undefined;
    role: LaunchStandaloneAgentOptions['role'];
    directoryRealPath: string | undefined;
    permissionRoles: PermissionRoles;
  },
): AgentState {
  const { store, runtime, provider } = deps;
  const { id, sessionId, cwd, projectDir, workspaceId, role, directoryRealPath, permissionRoles } =
    launched;

  // Pre-register the expected JSONL so the project scanner doesn't mistake it
  // for a /clear file, exactly as the VS Code path does.
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  runtime.knownJsonlFiles.add(expectedFile);

  const agent = createAgentState({
    id,
    sessionId,
    // Not external: this server owns the process. External agents are the ones
    // adopted from someone else's terminal, and they're what the stale-check and
    // restore paths act on -- a PTY agent must be excluded from both.
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
    // The character's origin label (and its Area-mapping key): the name of the
    // Directory it was launched into, as the user named it — so an entry called
    // "Side Project" labels its agents that, not "side-project", and the Areas
    // it was assigned in the modal actually match. Falls back to the basename
    // for a cwd that is no Directory at all.
    directoryName: directoryNameForLaunch(cwd, [hostDirectory()]) ?? directoryNameFor(cwd),
    providerId: provider.id,
    workspaceId,
    // Display only, runtime only: never persisted, so no restore or restart
    // path can bring a Role back.
    roleName: role?.name,
    // Runtime only, like roleName: the KB identity key and the Directory the
    // rules attribute this agent to.
    roleId: role?.roleId,
    directoryRealPath,
    // Runtime only: the R/E/D snapshot the write guard reads (never persisted).
    permissionRoles,
  });

  // Server-side, like every other creation path: the palette rides the
  // agentCreated broadcast and is persisted with the agent, so a reload
  // restores the same character without the webview having to save it back.
  assignPaletteIfNeeded(agent, store);
  store.set(id, agent);
  runtime.activeAgentId.current = id;

  runtime.registerAgent(sessionId, id);
  store.persist();

  // Tell the UI a terminal exists for this agent, so the drawer opens a tab.
  // A separate message (rather than a field on agentCreated) keeps the protocol
  // change additive for the sibling branches.
  store.broadcast({ type: 'terminalSessionOpened', agentId: id });
  return agent;
}

function realpathOrUndefined(directory: string): string | undefined {
  try {
    return fs.realpathSync(directory);
  } catch {
    return undefined;
  }
}

/**
 * Wait for the session's JSONL to appear, then start watching it.
 *
 * Hooks (the default) already route by sessionId, so this is what backfills tool
 * content and keeps hooks-off standalone working at all. Unlike the VS Code
 * path this does NOT implement /resume reassignment -- standalone always spawns
 * a fresh --session-id, so there's no resume case to detect here.
 */
function startJsonlPoll(deps: LaunchStandaloneAgentDeps, id: number, agent: AgentState): void {
  const { store, runtime } = deps;
  let pollCount = 0;

  const timer = setInterval(() => {
    pollCount++;
    try {
      if (!fs.existsSync(agent.jsonlFile)) {
        if (pollCount === 10) {
          console.warn(
            `[Pixel Agents] Terminal: Agent ${id} - JSONL not found after 10s. Expected: ${agent.jsonlFile}`,
          );
        }
        return;
      }
      clearInterval(timer);
      runtime.jsonlPollTimers.delete(id);
      // The agent may have been closed while we waited.
      if (!store.has(id)) return;
      console.log(
        `[Pixel Agents] Terminal: Agent ${id} - found JSONL ${path.basename(agent.jsonlFile)}`,
      );
      startFileWatching(
        id,
        agent.jsonlFile,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
      );
    } catch {
      // File may not exist yet, or vanished mid-check; keep polling.
    }
  }, JSONL_POLL_INTERVAL_MS);

  runtime.jsonlPollTimers.set(id, timer);
}
