import { facingDirection } from '../../../../core/src/layout/visitSpot.js';
import type { AgentMessageShow, AgentVisit } from '../../../../core/src/messages.js';
import type { OfficeState } from './officeState.js';

/**
 * Apply an `agentVisit` to the office: the character sets off for the tile
 * the server resolved, faces the given way there, and lingers before
 * wandering — or, with `stay`, holds there; `cleared` ends the visit (the
 * agent's next turn started, so a working agent heads for its seat).
 */
export function applyAgentVisit(os: OfficeState, msg: AgentVisit): void {
  if (msg.cleared || !msg.to || !msg.facing) {
    os.visits.end(msg.id);
    return;
  }
  os.visits.start(
    msg.id,
    [{ col: msg.to.col, row: msg.to.row, dir: facingDirection(msg.facing) }],
    msg.stay ? 'stay' : 'wander',
  );
}

/**
 * Apply an `agentMessageShow` to the office: the sender's character walks to
 * each recipient in turn, faces it with the gist in its speech bubble, then
 * goes back to its desk. `walk: false` (reduced motion) shows the gist where
 * the sender is, without the walk.
 */
export function applyAgentMessageShow(
  os: OfficeState,
  msg: AgentMessageShow,
  opts: { walk: boolean },
): void {
  os.visits.showMessage(msg.fromId, msg.toIds, msg.gist, opts);
}
