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
import type { AgentStateStore } from '../agentStateStore.js';
import { JSONL_POLL_INTERVAL_MS } from '../constants.js';
import { startFileWatching } from '../fileWatcher.js';
import type { AgentState } from '../types.js';
import type { PtySessionManager } from './ptySessionManager.js';

export interface LaunchStandaloneAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  ptyManager: PtySessionManager;
  provider: HookProvider;
}

export interface LaunchStandaloneAgentOptions {
  /** Working directory for the agent. Defaults to the server's cwd -- standalone
   *  has no workspace-folder concept (see design doc open question 4). */
  folderPath?: string;
  bypassPermissions?: boolean;
  cols?: number;
  rows?: number;
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

  if (!ptyManager.isAvailable()) {
    console.error(`[Pixel Agents] Terminal: cannot launch -- ${ptyManager.unavailableReason()}`);
    return null;
  }

  const cwd = options.folderPath ?? process.cwd();
  const sessionId = crypto.randomUUID();

  const launch = provider.buildLaunchCommand?.(sessionId, cwd, {
    bypassPermissions: options.bypassPermissions,
  });
  if (!launch) {
    console.error('[Pixel Agents] Terminal: provider.buildLaunchCommand is not implemented');
    return null;
  }

  const dirs = provider.getSessionDirs?.(cwd) ?? [];
  if (dirs.length === 0) {
    console.error('[Pixel Agents] Terminal: provider returned no session dirs');
    return null;
  }
  const projectDir = dirs[0];

  const id = store.nextAgentId.current++;

  let session;
  try {
    session = ptyManager.create({
      agentId: id,
      command: launch.command,
      args: launch.args,
      cwd,
      env: launch.env,
      cols: options.cols,
      rows: options.rows,
    });
  } catch (err) {
    // Roll the id back so a failed spawn doesn't burn an agent id.
    store.nextAgentId.current--;
    console.error(`[Pixel Agents] Terminal: spawn failed: ${String(err)}`);
    return null;
  }

  // Pre-register the expected JSONL so the project scanner doesn't mistake it
  // for a /clear file, exactly as the VS Code path does.
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  runtime.knownJsonlFiles.add(expectedFile);

  const agent: AgentState = {
    id,
    sessionId,
    terminalRef: undefined,
    // Not external: this server owns the process. External agents are the ones
    // adopted from someone else's terminal, and they're what the stale-check and
    // restore paths act on -- a PTY agent must be excluded from both.
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
    providerId: provider.id,
  };

  store.set(id, agent);
  runtime.activeAgentId.current = id;
  runtime.registerAgent(sessionId, id);
  store.persist();

  console.log(
    `[Pixel Agents] Terminal: Agent ${id} - spawned ${launch.command} (pid ${session.pid}) in ${cwd}`,
  );

  // Tell the UI a terminal exists for this agent, so the drawer opens a tab.
  // A separate message (rather than a field on agentCreated) keeps the protocol
  // change additive for the sibling branches.
  store.broadcast({ type: 'terminalSessionOpened', agentId: id });

  // The terminal closing is this surface's equivalent of VS Code's
  // "terminal closed -> clean up orphan" pass in fileWatcher.
  session.onExit((exit) => {
    console.log(`[Pixel Agents] Terminal: Agent ${id} - exited (code ${exit.exitCode})`);
    store.broadcast({ type: 'terminalSessionClosed', agentId: id, exitCode: exit.exitCode });
    if (store.has(id)) {
      runtime.dismissalTracker.dismiss(agent.jsonlFile);
      runtime.unregisterAgent(agent.sessionId);
      runtime.removeAgent(id);
    }
  });

  startJsonlPoll(deps, id, agent);

  return id;
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
