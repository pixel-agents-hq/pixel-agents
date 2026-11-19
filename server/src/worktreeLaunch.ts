/**
 * A launch into a new Worktree, for either surface, in three steps the
 * surface runs itself:
 *   1. `prepareWorktreeLaunch` makes the Worktree (from the Directory's own
 *      base and prefix; a host Directory takes the defaults) and says where to
 *      run: its folder, the Worktree the agent wears, the session it was made
 *      for;
 *   2. the surface's one ordinary launch, with that `where` — the agent still
 *      an agent of its Directory (its name, default characters and Areas are
 *      the Directory's, never the folder's);
 *   3. `retireUnlaunched` when that launch started no terminal: no agent will
 *      ever run in it, so its Worktree goes through the leave rules at once (a
 *      new one is clean: it goes entirely).
 * A launch that can't be made is answered `worktreeRejected`
 * (`worktreeRejectedMessage`) and leaves nothing on disk.
 */

import * as crypto from 'crypto';

import type { Directory, WorktreeBranch, WorktreeRejected } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';
import { create as createWorktree } from './worktreeCreate.js';
import { retireWhenUnused } from './worktreeLeave.js';
import { symlinkDirectoriesFor } from './worktreeLocation.js';

/** Where a host starts an agent's terminal for a Worktree launch. */
export interface WorktreeTerminalLaunch {
  /** The folder to run in: the Worktree's. */
  cwd: string;
  /** The Worktree the agent wears (marker, branch, leave rules). */
  worktree: NonNullable<AgentState['worktree']>;
  /** The session the Worktree was made for: the launch must use this id. */
  sessionId: string;
}

export type PreparedWorktreeLaunch =
  { ok: true; where: WorktreeTerminalLaunch } | { ok: false; reason: string };

/**
 * Make a new Worktree of `directory`'s repo for a launch. Refused, making
 * nothing, when the path names no Directory or the host can't start a
 * terminal now (`terminalUnavailable`, asked before anything is made).
 */
export async function prepareWorktreeLaunch(request: {
  /** The path the launch named (for the reason when it is no Directory). */
  directoryPath: string;
  /** The Directory at that path, resolved by the host; none = refused. */
  directory: Directory | undefined;
  /** Why the host can't start a terminal right now; null when it can. */
  terminalUnavailable?: string | null;
  /** The name the user gave it (absent = generated). */
  name?: string;
  /** The branch the user chose to start from (absent = the Directory's base). */
  from?: WorktreeBranch;
}): Promise<PreparedWorktreeLaunch> {
  const { directory } = request;
  if (!directory) return { ok: false, reason: `${request.directoryPath} is not a Directory.` };
  if (request.terminalUnavailable) return { ok: false, reason: request.terminalUnavailable };

  const sessionId = crypto.randomUUID();
  const created = await createWorktree(directory, {
    base: directory.worktreeBase,
    prefix: directory.worktreeBranchPrefix,
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(request.from ? { from: request.from } : {}),
    symlinkDirectories: symlinkDirectoriesFor(directory.path),
    sessionId,
  });
  if (!created.ok) return created;
  const { name, path: worktreePath, branch } = created.worktree;
  return {
    ok: true,
    where: { cwd: worktreePath, worktree: { name, path: worktreePath, branch }, sessionId },
  };
}

/** The prepared launch's terminal never started: its Worktree goes through
 *  the leave rules now, rather than stay `active` until the next startup's
 *  sweep. Returns the reason to tell the client. */
export function retireUnlaunched(store: AgentStateStore, where: WorktreeTerminalLaunch): string {
  void retireWhenUnused(store, where.worktree);
  return `The Worktree ${where.worktree.branch} was made, but its agent's terminal could not start.`;
}

/** The answer to a Worktree launch (or resume) that could not be made. */
export function worktreeRejectedMessage(directoryPath: string, reason: string): WorktreeRejected {
  return { type: 'worktreeRejected', directoryPath, reason };
}
