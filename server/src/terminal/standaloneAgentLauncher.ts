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
import type { PersistedAgent } from '../../../core/src/schemas.js';
import { restoredAgentInit } from '../agentPersistence.js';
import type { AgentRuntime } from '../agentRuntime.js';
import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { JSONL_POLL_INTERVAL_MS } from '../constants.js';
import { clearContextUsage } from '../contextUsage.js';
import { directoryAt } from '../directories.js';
import { startFileWatching } from '../fileWatcher.js';
import { directoryNameFor, hostDirectory } from '../hostDirectory.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import type { AgentState } from '../types.js';
import type { TerminalSession, TerminalSessions } from './terminalSessions.js';

export interface LaunchStandaloneAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  ptyManager: TerminalSessions;
  provider: HookProvider;
}

export interface LaunchStandaloneAgentOptions {
  /** Path of the Directory to launch into. Defaults to the server's cwd, which
   *  is also the Directory standalone contributes as its host entry. */
  directoryPath?: string;
  /** Read from the host's persisted permission posture by the caller; never a
   *  per-launch choice made in the office. */
  bypassPermissions?: boolean;
  /** The character picked from the roster (a palette index). Out of range or
   *  absent, the Directory's default characters apply, else a random pick. */
  palette?: number;
  /** Resume this past session instead of starting a new one: same session
   *  id, same transcript (read from its end), and the seat its agent sat in
   *  when that one is free. */
  resume?: { sessionId: string; transcript: string; seatId?: string };
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

  const cwd = options.directoryPath ?? process.cwd();
  const sessionId = options.resume?.sessionId ?? crypto.randomUUID();

  const launch = provider.buildLaunchCommand?.(sessionId, cwd, {
    bypassPermissions: options.bypassPermissions,
    resume: options.resume !== undefined,
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
  // A resumed session's transcript is wherever the CLI filed it (under the
  // Directory's resolved path, when it was reached through a symlink).
  const jsonlFile = options.resume?.transcript ?? path.join(dirs[0], `${sessionId}.jsonl`);
  const projectDir = path.dirname(jsonlFile);

  const id = store.nextAgentId.current++;

  // The Directory launched into, if the cwd is one: its name and its default characters.
  const directory = directoryAt(cwd, [hostDirectory()]);
  const agent = createAgentState({
    id,
    sessionId,
    // Not external: this server owns the process. External agents are the ones
    // adopted from someone else's terminal, and they're what the stale-check and
    // restore paths act on -- a PTY agent must be excluded from both.
    isExternal: false,
    projectDir,
    jsonlFile,
    // The character's origin label (and its Area-mapping key): the name of the
    // Directory it was launched into, as the user named it — so an entry called
    // "Side Project" labels its agents that, not "side-project", and the Areas
    // it was assigned in the modal actually match. Falls back to the basename
    // for a cwd that is no Directory at all.
    directoryName: directory?.name ?? directoryNameFor(cwd),
    providerId: provider.id,
    seatId: options.resume?.seatId,
  });
  if (options.resume) {
    // Its history is the past: replaying it would resurrect finished tools.
    try {
      agent.fileOffset = fs.statSync(agent.jsonlFile).size;
    } catch {
      // No transcript after all: read it from the start once it appears.
    }
  }

  // Server-side, like every other creation path: the palette rides the
  // agentCreated broadcast and is persisted with the agent, so a reload
  // restores the same character without the webview having to save it back.
  assignPaletteIfNeeded(agent, store, { picked: options.palette, directory });

  let session;
  try {
    session = ptyManager.create({
      agentId: id,
      command: launch.command,
      args: launch.args,
      cwd,
      env: { ...processEnv(), ...launch.env },
      cols: options.cols,
      rows: options.rows,
    });
  } catch (err) {
    // Roll the id back so a failed spawn doesn't burn an agent id.
    store.nextAgentId.current--;
    console.error(`[Pixel Agents] Terminal: spawn failed: ${String(err)}`);
    return null;
  }

  admitTerminalAgent(deps, agent, session);
  // A fresh session starts with an empty context: a full gauge from the spawn on.
  // A resumed one keeps its gauge, read from its transcript.
  if (!options.resume) clearContextUsage(id, store);
  runtime.activeAgentId.current = id;
  store.persist();

  const pid = session.pid !== null ? ` (pid ${session.pid})` : '';
  const what = options.resume ? `resumed session ${sessionId}` : `spawned ${launch.command}`;
  console.log(`[Pixel Agents] Terminal: Agent ${id} - ${what}${pid} in ${cwd}`);
  return id;
}

/**
 * Bring back the agents whose terminals outlived the last server (only the
 * PTY host keeps them; in process there are none). Runs before the server
 * accepts connections, so the first office to connect already sees them —
 * and before anything persists, which would drop them from the saved list.
 *
 * Each agent is rebuilt from the saved list (team, look, spawns): shutting
 * down never empties it. Its transcript is read from its current end: what it
 * did while no server was watching is history, and replaying it would
 * resurrect finished tools.
 */
export function reattachTerminalAgents(deps: LaunchStandaloneAgentDeps): number[] {
  const { store, ptyManager } = deps;
  const saved = new Map(store.loadPersistedAgents().map((p) => [p.id, p]));
  const restored: number[] = [];

  for (const session of ptyManager.survivors()) {
    const id = session.agentId;
    // Never hand a new launch an id a live terminal still holds.
    if (id >= store.nextAgentId.current) store.nextAgentId.current = id + 1;
    if (store.has(id)) continue;
    const record = saved.get(id);
    if (!record) {
      console.warn(
        `[Pixel Agents] Terminal: Agent ${id} - running in the PTY host with no saved record; left out of the office.`,
      );
      continue;
    }

    // Restored from where the transcript really is: the finished-spawn check
    // must read the same file the agent will watch.
    const agent = createAgentState({
      ...restoredAgentInit(relocatedRecord(deps.provider, record)),
      isExternal: false,
      providerId: deps.provider.id,
    });
    try {
      agent.fileOffset = fs.statSync(agent.jsonlFile).size;
    } catch {
      // No transcript yet: it starts from the beginning once it appears.
    }
    assignPaletteIfNeeded(agent, store);
    admitTerminalAgent(deps, agent, session);
    restored.push(id);
    console.log(`[Pixel Agents] Terminal: Agent ${id} - reattached (pid ${session.pid})`);
  }

  if (restored.length > 0) store.persist();
  return restored;
}

/**
 * The saved record with its transcript where it really is, when that isn't
 * where the record says. Older servers saved the path under the Directory as
 * given, but the CLI files it under the symlink-resolved path, so such an
 * agent never got its transcript (and none of its sub-agents) watched. The
 * session id is a UUID, so the one `<sessionId>.jsonl` under the session roots
 * is its own. Returns the record itself when nothing moved.
 */
function relocatedRecord(provider: HookProvider, record: PersistedAgent): PersistedAgent {
  if (fs.existsSync(record.jsonlFile)) return record;
  const name = path.basename(record.jsonlFile);
  for (const root of provider.getAllSessionRoots?.() ?? []) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const file = path.join(root, dir, name);
      if (!fs.existsSync(file)) continue;
      console.log(`[Pixel Agents] Terminal: Agent ${record.id} - transcript found at ${file}`);
      return { ...record, jsonlFile: file, projectDir: path.dirname(file) };
    }
  }
  return record;
}

/** What every agent with a terminal gets, launched or reattached: a place in
 *  the office, its drawer tab, its removal when the process ends, and its
 *  transcript watched. */
function admitTerminalAgent(
  deps: LaunchStandaloneAgentDeps,
  agent: AgentState,
  session: TerminalSession,
): void {
  const { store, runtime } = deps;
  const id = agent.id;

  // Pre-register the expected JSONL so the project scanner doesn't mistake it
  // for a /clear file, exactly as the VS Code path does.
  runtime.knownJsonlFiles.add(agent.jsonlFile);
  store.set(id, agent);
  runtime.registerAgent(agent.sessionId, id);

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
      runtime.unregisterAgent(agent.sessionId);
      runtime.closeAgent(id);
    }
  });

  startJsonlPoll(deps, id, agent);
}

/**
 * Wait for the session's JSONL to appear, then start watching it.
 *
 * Hooks (the default) already route by sessionId, so this is what backfills tool
 * content and keeps hooks-off standalone working at all. Unlike the VS Code
 * path this does NOT implement /resume reassignment: a launch either names a
 * fresh --session-id or --resume's an existing one, so the transcript is
 * known up front either way.
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

/** This process's env as plain strings (process.env is `string | undefined`-valued,
 *  a PTY env all-strings): what an agent's terminal runs with, under its own
 *  variables. Built here, by the server, so a PTY host started long ago by an
 *  older server never lends its own. */
function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
