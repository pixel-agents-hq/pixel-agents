/**
 * Worktrees in the sidebar's conversations: where each Directory's Worktrees
 * are (ours from the registry, parked ones included; Claude Code's from git),
 * so their conversations are listed under the Directory, and resuming one of
 * them — which, for a Worktree of ours whose folder was removed, rebuilds the
 * folder from its branch first (worktreeRestore.ts `restore`), so the CLI finds its
 * transcript where it left it.
 *
 * Claude Code's worktrees are resumed in place only: never rebuilt, never
 * marked, never cleaned up by the leave rules (no registry entry); only the
 * user's Remove from the Worktrees list takes one away (claudeWorktrees.ts).
 *
 * A session whose Worktree is gone for good (removed, its branch deleted —
 * ours or Claude Code's) resumes in the Directory's own checkout, its
 * transcript moved there first: removing a Worktree never loses its chats.
 */

import type { Directory } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { isClaudeWorktree } from './claudeWorktrees.js';
import {
  moveSessionIntoDirectory,
  resumeRequest,
  type WorktreeLocation,
  type WorktreesOf,
} from './conversations.js';
import type { LaunchStandaloneAgentOptions } from './terminal/standaloneAgentLauncher.js';
import { broadcastWorktrees, retireWhenUnused } from './worktreeLeave.js';
import { worktreesOf } from './worktreeListing.js';
import { restore } from './worktreeRestore.js';
import { markIdle } from './worktreeRetire.js';

type Send = (message: Record<string, unknown>) => void;

/** Each Directory's Worktrees, ours then Claude Code's (where they are,
 *  not what they hold), keyed by the Directory's path as given. */
export async function worktreeLocations(
  directories: ReadonlyArray<Pick<Directory, 'path'>>,
): Promise<WorktreesOf> {
  const byPath = new Map<string, WorktreeLocation[]>();
  for (const { path: directoryPath } of directories) {
    if (byPath.has(directoryPath)) continue;
    const listed = await worktreesOf(directoryPath, { details: false });
    byPath.set(
      directoryPath,
      listed.map(({ name, path: worktreePath, branch, owner }) => ({
        name,
        path: worktreePath,
        branch,
        owner,
      })),
    );
  }
  return (directoryPath) => byPath.get(directoryPath) ?? [];
}

export interface ResumeDeps {
  store: AgentStateStore;
  provider: HookProvider;
  /** The Directory at a path (the agent is named after it). */
  directoryFor: (directoryPath: string) => Directory | undefined;
  /** Why no terminal can start now, or null when one can. */
  terminalUnavailable: () => string | null;
  launch: (options: LaunchStandaloneAgentOptions) => number | null;
}

/**
 * `resumeConversation`: the conversation comes back in a new terminal, as the
 * agent it was (look, seat). One of a Directory's Worktrees resumes in the
 * Worktree's folder, as an agent of the Directory wearing the Worktree: ours
 * restored first (a removed folder rebuilt from its branch, a save commit
 * undone into uncommitted changes, a kept one used as it is), Claude Code's
 * only while its folder is there. Refused with `worktreeRejected` (like a
 * refused launch) when the Worktree can't be brought back. Returns the
 * agent's id, or null when nothing was launched.
 */
export async function resumeConversation(
  deps: ResumeDeps,
  send: Send,
  msg: { sessionId?: unknown; directoryPath?: unknown },
): Promise<number | null> {
  const { store, provider } = deps;
  const directoryPath = typeof msg.directoryPath === 'string' ? msg.directoryPath : undefined;
  if (directoryPath === undefined) return null;
  const worktreesOf = await worktreeLocations([{ path: directoryPath }]);
  const resume = resumeRequest(store, provider, msg, worktreesOf);
  if (!resume) return null;
  if (resume.fromRemovedWorktree) {
    // Its Worktree is gone: it carries on in the Directory's checkout, filed
    // where the CLI looks for that folder's sessions.
    const moved = moveSessionIntoDirectory(provider, resume.directoryPath, resume.transcript);
    if (!moved.ok) {
      send({ type: 'worktreeRejected', directoryPath, reason: moved.reason });
      return null;
    }
    console.log(
      `[Pixel Agents] Conversations: ${resume.sessionId} moved out of its removed Worktree to resume in ${resume.directoryPath}`,
    );
    resume.transcript = moved.transcript;
  }

  const directory = deps.directoryFor(resume.directoryPath);
  const options: LaunchStandaloneAgentOptions = {
    directory,
    cwd: resume.directoryPath,
    palette: resume.look?.palette,
    resume: {
      sessionId: resume.sessionId,
      transcript: resume.transcript,
      seatId: resume.look?.seatId,
    },
  };
  const worktree = resume.worktree;
  if (!worktree) return deps.launch(options);

  const reject = (reason: string) => {
    send({ type: 'worktreeRejected', directoryPath, reason });
    return null;
  };
  const unavailable = deps.terminalUnavailable();
  if (unavailable) return reject(unavailable);
  const marker = { name: worktree.name, path: worktree.path, branch: worktree.branch };

  if (worktree.owner === 'claude') {
    if (!isClaudeWorktree(directoryPath, worktree.name)) {
      return reject(`Claude Code's worktree ${worktree.branch} is gone.`);
    }
    return deps.launch({ ...options, cwd: worktree.path, worktree: marker });
  }

  const restored = await restore(worktree, {
    symlinkDirectories: provider.worktreeSymlinkDirectories?.(directoryPath),
    sessionId: resume.sessionId,
  });
  if (!restored.ok) {
    reject(restored.reason);
    await broadcastWorktrees(store, directoryPath);
    return null;
  }
  // Resumed from another office while git worked: that agent has it now.
  if ([...store].some(([, agent]) => agent.sessionId === resume.sessionId)) return null;

  const { entry } = restored;
  const launched = deps.launch({
    ...options,
    cwd: entry.path,
    worktree: { name: entry.name, path: entry.path, branch: entry.branch },
  });
  if (launched === null) {
    // No agent will run in it after all: a folder that was there goes back to
    // how it was; a rebuilt one gets the leave rules (its unsaved changes
    // make it wait on a decision, so nothing is lost).
    const prior = restored.priorState;
    if (!restored.rebuilt && (prior === 'kept' || prior === 'needsDecision')) {
      await markIdle(entry, prior);
    } else {
      await retireWhenUnused(store, entry);
    }
    reject(`The Worktree ${entry.branch} is back, but its agent's terminal could not start.`);
  }
  await broadcastWorktrees(store, directoryPath);
  return launched;
}
