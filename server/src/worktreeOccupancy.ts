/**
 * Who still runs in a Worktree: the one answer every "never from under a
 * live agent" guard in this process asks (the leave path, a decision, the
 * startup sweep, the holder claim). Another process's agents are the
 * registry `holder`'s business (worktreeRegistry.ts `heldElsewhere`).
 *
 * An agent holds a Worktree when it runs in it (`worktree`, also copied onto
 * its own-session Teammates), or when its session was run there — the
 * registry records every session a Worktree of ours was created or resumed
 * for (`sessionIds`), and the session an agent had when it moved out of one
 * (agentMoves.ts) or became after a /clear (`carrySession`). So an agent that
 * moved itself out of our Worktree mid-session still holds it, across a
 * reload too, with nothing kept on the agent.
 */

import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AgentStateStore } from './agentStateStore.js';
import { realPathKey, sameFolder } from './pathKey.js';
import { readRegistry, recordSession, type WorktreeEntry } from './worktreeRegistry.js';

/** What holding needs to know of an agent, live or saved. */
export interface WorktreeOccupant {
  sessionId: string;
  worktree?: { path: string };
}

/** A Worktree as holding reads it: ours carry the sessions run in them,
 *  Claude Code's don't. */
export interface OccupiedWorktree {
  path: string;
  sessionIds?: readonly string[];
}

/** Whether `agent` holds `worktree`: it runs there, or its session was run there. */
export function holdsWorktree(agent: WorktreeOccupant, worktree: OccupiedWorktree): boolean {
  if (sameFolder(agent.worktree?.path, worktree.path)) return true;
  return agent.sessionId !== '' && (worktree.sessionIds?.includes(agent.sessionId) ?? false);
}

/** The live agent holding `worktree`, if any: one running there now before
 *  one whose session only ran there once (an agent that cd'd in and out of
 *  another agent's Worktree must not stand for it). */
export function occupantOf(store: AgentStateStore, worktree: OccupiedWorktree): number | undefined {
  let holder: number | undefined;
  for (const [id, agent] of store) {
    if (sameFolder(agent.worktree?.path, worktree.path)) return id;
    if (holder === undefined && holdsWorktree(agent, worktree)) holder = id;
  }
  return holder;
}

/** Whether any live agent holds `worktree`. */
export function worktreeInUse(store: AgentStateStore, worktree: OccupiedWorktree): boolean {
  return occupantOf(store, worktree) !== undefined;
}

/** The Worktrees of ours `agent` holds. */
export function entriesHeldBy(
  agent: WorktreeOccupant,
  registry: readonly WorktreeEntry[] = readRegistry(),
): WorktreeEntry[] {
  return registry.filter((entry) => holdsWorktree(agent, entry));
}

/** The folders `agents` hold (as realPathKeys): each one's own Worktree, and
 *  every one of ours its session was run in. */
export function heldPaths(
  agents: Iterable<WorktreeOccupant>,
  registry: readonly WorktreeEntry[] = readRegistry(),
): Set<string> {
  const held = new Set<string>();
  for (const agent of agents) {
    if (agent.worktree && typeof agent.worktree.path === 'string') {
      held.add(realPathKey(agent.worktree.path));
    }
    for (const entry of entriesHeldBy({ sessionId: agent.sessionId }, registry)) {
      held.add(realPathKey(entry.path));
    }
  }
  return held;
}

/** A saved agent as an occupant (an older save may carry fields it no longer
 *  needs, such as `homeWorktree`; they are ignored). */
export function savedOccupant(saved: PersistedAgent): WorktreeOccupant {
  return { sessionId: saved.sessionId ?? '', worktree: saved.worktree };
}

/** An agent's session became `next` (a /clear): the Worktrees its old
 *  session held are held by the new one too. */
export function carrySession(previous: string, next: string): void {
  if (previous === '' || previous === next) return;
  for (const entry of readRegistry()) {
    if (entry.sessionIds.includes(previous)) recordSession(entry, next);
  }
}
