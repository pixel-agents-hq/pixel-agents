/**
 * Agent records that exist before (or without) a process: `createAgent` makes
 * one, `startAgent` gives it a Claude Code process.
 *
 * A record is an ordinary AgentState with `stopped` set. Starting it goes
 * through launchStandaloneAgent -- the one place a PTY is spawned, a
 * capability issued and an exit handled -- so a started record behaves exactly
 * like an agent that was launched in one step.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { createAgentState } from '../agentState.js';
import { directoryNameForLaunch } from '../directories.js';
import { directoryNameFor, hostDirectory } from '../hostDirectory.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import { workspaceIdForDirectory } from '../workspaces.js';
import type { PermissionRoles } from '../writeGuard/permissionRoles.js';
import type { LaunchStandaloneAgentDeps } from './standaloneAgentLauncher.js';
import { launchStandaloneAgent } from './standaloneAgentLauncher.js';

const AGENT_NAME_MAX_LENGTH = 64;

export interface CreateStoppedAgentOptions {
  directoryPath: string;
  name?: string;
  /** Same meaning as on a launch: an array is the roles, null is no roles,
   *  absent takes the Workspace default when the agent starts. */
  permissionRoles?: PermissionRoles;
}

/** Normalize a client-supplied display name; undefined when nothing is left. */
export function normalizeAgentName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim().slice(0, AGENT_NAME_MAX_LENGTH);
  return trimmed === '' ? undefined : trimmed;
}

/** Register a stopped record; returns its id, or null when it cannot be created. */
export function createStoppedAgent(
  deps: Pick<LaunchStandaloneAgentDeps, 'store' | 'provider'>,
  options: CreateStoppedAgentOptions,
): number | null {
  const { store, provider } = deps;
  const cwd = options.directoryPath;

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(cwd).isDirectory();
  } catch {
    /* missing path: refused below */
  }
  if (!isDirectory) {
    console.error(`[Pixel Agents] Terminal: cannot create an agent -- not a directory: ${cwd}`);
    return null;
  }

  const projectDir = provider.getSessionDirs?.(cwd)[0];
  if (projectDir === undefined) {
    console.error('[Pixel Agents] Terminal: provider returned no session dirs');
    return null;
  }

  const id = store.nextAgentId.current++;
  const sessionId = crypto.randomUUID();
  const agent = createAgentState({
    id,
    sessionId,
    isExternal: false,
    projectDir,
    jsonlFile: path.join(projectDir, `${sessionId}.jsonl`),
    directoryName: directoryNameForLaunch(cwd, [hostDirectory()]) ?? directoryNameFor(cwd),
    providerId: provider.id,
    workspaceId: workspaceIdForDirectory(cwd),
    displayName: options.name,
    stopped: true,
    launchDirectory: cwd,
    permissionRoles: options.permissionRoles,
  });
  assignPaletteIfNeeded(agent, store);
  store.set(id, agent);
  store.persist();
  return id;
}

/** Start a stopped record; false when it is not startable or the spawn failed. */
export function startStoppedAgent(
  deps: LaunchStandaloneAgentDeps,
  id: number,
  options: { bypassPermissions?: boolean } = {},
): boolean {
  const agent = deps.store.get(id);
  if (!agent?.stopped || agent.launchDirectory === undefined) return false;
  if (deps.ptyManager.has(id)) return false;

  return (
    launchStandaloneAgent(deps, {
      directoryPath: agent.launchDirectory,
      bypassPermissions: options.bypassPermissions,
      permissionRoles: agent.permissionRoles,
      // The transcript only exists once the conversation had a first turn;
      // before that there is nothing to resume and a fresh session id is used.
      existing: { id, sessionId: agent.sessionId, resume: fs.existsSync(agent.jsonlFile) },
    }) !== null
  );
}
