import { useCallback, useEffect, useMemo, useReducer } from 'react';

import type { PermissionAnswer, PermissionBehavior } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import {
  agentsWithPending,
  APPROVAL_OUTCOME_SHOW_MS,
  approvalsReducer,
  INITIAL_APPROVALS,
} from './approvalState.js';

/**
 * Pending permission requests for the board (permissionPending /
 * permissionResolved), the open approval card, and the answer it sends. Its
 * own transport subscription, so the office's message hook stays untouched.
 *
 * `autoOpen` (TV mode on a board that may answer): with no card open, the
 * oldest pending request opens its own card — nothing on a TV invites the
 * click that would open it. A card the viewer closes stays closed.
 */
export function usePermissionApprovals(autoOpen = false) {
  const [state, dispatch] = useReducer(approvalsReducer, INITIAL_APPROVALS);

  useEffect(() => transport.onMessage((msg) => dispatch({ type: 'message', msg })), []);

  // A resolved card shows its outcome briefly, then closes.
  const outcome = state.card?.outcome;
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => dispatch({ type: 'close' }), APPROVAL_OUTCOME_SHOW_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const hasCard = state.card !== null;
  useEffect(() => {
    if (autoOpen && !hasCard) dispatch({ type: 'autoOpen' });
  }, [autoOpen, hasCard, state.pending]);

  const agentIds = useMemo(() => agentsWithPending(state.pending), [state.pending]);
  const open = useCallback((agentId: number) => dispatch({ type: 'open', agentId }), []);
  const close = useCallback(() => dispatch({ type: 'close' }), []);
  const card = state.card;
  const answer = useCallback(
    (behavior: PermissionBehavior, answers?: PermissionAnswer[]) => {
      if (!card || card.answering || card.outcome) return;
      dispatch({ type: 'answer', behavior });
      transport.send({
        type: 'answerPermission',
        requestId: card.request.requestId,
        behavior,
        ...(answers ? { answers } : {}),
      });
    },
    [card],
  );

  return { card, agentIds, open, close, answer };
}
