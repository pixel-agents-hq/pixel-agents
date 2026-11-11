/**
 * Visits (CONTEXT.md): the server's record of where each agent's character
 * was sent, so every office shows the same visit — the ones open now through
 * the `agentVisit` broadcast, the ones opened later through the connect
 * snapshot (visitSnapshot, sent after the agents' activity on both surfaces).
 *
 * A visit is kept on the agent (`AgentState.visit`) and holds until:
 * - the agent's NEXT turn starts (an `agentStatus: active` after a turn
 *   ended): broadcast as `{ id, cleared: true }`, and its character goes back
 *   to its seat. The turn that asked for the visit (an agent sending itself)
 *   does not end it;
 * - without `stay`, the walk and the linger are over (VISIT_LINGER_MS plus
 *   VISIT_WALK_ALLOWANCE_MS after it was asked): dropped silently, since every
 *   office open by then has already let its character wander off;
 * - the agent leaves (the record goes with it).
 *
 * Character positions are simulated per office, so the server never knows
 * where a character stands — only where it was sent.
 */

import type { Facing } from '../../core/src/layout/index.js';
import { VISIT_LINGER_MS } from '../../core/src/layout/index.js';
import type { AgentVisit as AgentVisitMessage } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { VISIT_WALK_ALLOWANCE_MS } from './constants.js';
import type { AgentState, AgentTurnStatus } from './types.js';

export interface AgentVisit {
  to: { col: number; row: number };
  facing: Facing;
  stay: boolean;
  /** When a visit without `stay` is over (epoch ms); null with `stay`. */
  expiresAt: number | null;
  /** True once a turn ended since the visit was asked: the next one ends it. */
  endsOnNextActive: boolean;
}

/** The visit an agent's character is on now, if any (an expired one is dropped). */
export function currentVisit(agent: AgentState, now = Date.now()): AgentVisit | undefined {
  const visit = agent.visit;
  if (visit && visit.expiresAt !== null && now >= visit.expiresAt) {
    agent.visit = undefined;
    return undefined;
  }
  return visit;
}

/** The `agentVisit` message for an agent's visit, or its `cleared` form. */
export function visitMessage(id: number, visit: AgentVisit | undefined): AgentVisitMessage {
  if (!visit) return { type: 'agentVisit', id, cleared: true };
  return { type: 'agentVisit', id, to: visit.to, facing: visit.facing, stay: visit.stay };
}

/**
 * Every agent's visit, or `cleared` for one on none — sent on connect after
 * the agents' activity, so a reconnecting office also drops a visit that
 * ended while it was away.
 */
export function visitSnapshot(store: AgentStateStore): AgentVisitMessage[] {
  return [...store].map(([id, agent]) => visitMessage(id, currentVisit(agent)));
}

/**
 * Send an agent's character on a visit and tell every office. `inTurn`: the
 * agent is working right now, so the turn under way doesn't end the visit —
 * only the next one does.
 */
export function startVisit(
  store: AgentStateStore,
  id: number,
  spot: { col: number; row: number; facing: Facing },
  opts: { stay: boolean; inTurn: boolean; now?: number },
): AgentVisit | null {
  const agent = store.get(id);
  if (!agent) return null;
  const now = opts.now ?? Date.now();
  const visit: AgentVisit = {
    to: { col: spot.col, row: spot.row },
    facing: spot.facing,
    stay: opts.stay,
    expiresAt: opts.stay ? null : now + VISIT_WALK_ALLOWANCE_MS + VISIT_LINGER_MS,
    endsOnNextActive: !opts.inTurn,
  };
  agent.visit = visit;
  store.broadcast({ ...visitMessage(id, visit) });
  return visit;
}

/** End an agent's visit, if it is on one, and tell every office. */
export function endVisit(store: AgentStateStore, id: number): void {
  const agent = store.get(id);
  if (!agent?.visit) return;
  agent.visit = undefined;
  store.broadcast({ ...visitMessage(id, undefined) });
}

/** Following the agents' turns for their visits (followTurnsForVisits). */
export interface VisitTurns {
  /** Stop following. */
  dispose(): void;
}

/** Follow the agents' turns (the store's `agentStatus` reports) so a visit
 *  ends when its agent's next turn starts. */
export function followTurnsForVisits(store: AgentStateStore): VisitTurns {
  const onStatus = (id: number, status: AgentTurnStatus): void => {
    const agent = store.get(id);
    const visit = agent && currentVisit(agent);
    if (!visit) return;
    if (status !== 'active') visit.endsOnNextActive = true;
    else if (visit.endsOnNextActive) endVisit(store, id);
  };
  store.on('agentStatus', onStatus);
  return {
    dispose() {
      store.off('agentStatus', onStatus);
    },
  };
}
