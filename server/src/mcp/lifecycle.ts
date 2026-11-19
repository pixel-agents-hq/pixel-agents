/**
 * Agents coming and going at the Pixel Office MCP's word (launch_agent,
 * close_agent), on a surface that can do it: the character and seat a launch
 * names checked against the office, then the surface's own launch (the
 * drawer's); a close through the card's × rules (closeAgentAsking), the
 * surface ending the terminal. An agent closing itself is ended once its turn
 * is over (closeAfterTurn), so its CLI records the turn that closed it.
 */

import type { AgentStateStore } from '../agentStateStore.js';
import { SELF_CLOSE_FALLBACK_MS } from '../constants.js';
import type { AgentTerminals } from '../terminal/agentTerminals.js';
import type { AgentTurnStatus } from '../types.js';
import { closeAgentAsking } from '../worktreeLeave.js';
import { characterOf } from './agentsView.js';
import { paletteOf } from './charactersView.js';
import { type OfficeFacts, officeSnapshot } from './officeFacts.js';
import type {
  AgentLaunch,
  AgentLaunchOutcome,
  Closing,
  Launching,
  OfficeCloseOutcome,
} from './officeOperations.js';
import { noAgentReason } from './officeOperations.js';

export function createLaunching(
  facts: OfficeFacts,
  /** The surface's launch, waiting until the agent has joined. */
  launch: (request: AgentLaunch) => Promise<AgentLaunchOutcome>,
): Launching {
  const { store } = facts;
  return {
    async launchAgent(request) {
      const notes: string[] = [];
      let palette: number | undefined;
      if (request.character !== undefined) {
        const picked = paletteOf(request.character);
        if (!picked.ok) return picked;
        palette = picked.palette;
      }
      let seatId: string | undefined;
      if (request.seat !== undefined) {
        const office = officeSnapshot(facts);
        if (!office.layout) {
          // Nothing to check it against: asked for as it is, taken when an office finds it free.
          seatId = request.seat;
        } else if (!office.seats.has(request.seat)) {
          return {
            ok: false,
            reason: `There is no seat ${request.seat} in the layout: get_layout lists the seats and which are free.`,
          };
        } else {
          const holder = office.holders.get(request.seat);
          if (holder === undefined) seatId = request.seat;
          else
            notes.push(`Seat ${request.seat} is agent ${holder}'s, so the office picked another.`);
        }
      }
      const { character: _character, seat: _seat, asks, ...where } = request;
      const outcome = await launch({ ...where, palette, asks: { ...asks, seatId } });
      if (!outcome.ok) return outcome;
      const agent = store.get(outcome.id);
      return {
        ok: true,
        id: outcome.id,
        seat: officeSnapshot(facts).seatOf(outcome.id) ?? null,
        character: agent ? characterOf(agent) : null,
        session: agent?.sessionId ?? '',
        notes,
      };
    },
  };
}

/**
 * End agent `id` (`close`) once its turn is over: its next report that is not
 * `active` (its Stop, or the transcript's turn end), or `fallbackMs` after
 * this is called, whichever comes first. Nothing happens if it left by then.
 * Returns a cancel (shutdown).
 */
export function closeAfterTurn(
  store: AgentStateStore,
  id: number,
  close: (id: number) => void,
  fallbackMs = SELF_CLOSE_FALLBACK_MS,
): () => void {
  let done = false;
  const finish = (closeIt: boolean): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    store.off('agentStatus', onStatus);
    store.off('agentRemoved', onRemoved);
    if (closeIt && store.has(id)) close(id);
  };
  const onStatus = (agentId: number, status: AgentTurnStatus): void => {
    if (agentId === id && status !== 'active') finish(true);
  };
  const onRemoved = (agentId: number): void => {
    if (agentId === id) finish(false);
  };
  const timer = setTimeout(() => finish(true), fallbackMs);
  store.on('agentStatus', onStatus);
  store.on('agentRemoved', onRemoved);
  return () => finish(false);
}

export interface ClosingHandle extends Closing {
  /** Cancel the self-closes still waiting on their turn (shutdown). */
  dispose(): void;
}

export function createClosing(
  facts: OfficeFacts,
  /** How the surface ends an agent's terminal (its card's ×). */
  close: (id: number) => void,
  /** Its agents' terminals: one without a terminal of ours is only dismissed. */
  terminals: Pick<AgentTerminals, 'has'>,
): ClosingHandle {
  const { store } = facts;
  const selfCloses = new Set<() => void>();

  return {
    async closeAgent({ id, caller, worktreeChoice, confirmedFiles }): Promise<OfficeCloseOutcome> {
      const agent = store.get(id);
      if (!agent) {
        return {
          ok: false,
          reason: `${noAgentReason(id)} (A Sub-agent is not an agent of its own: it ends with its task, or with the agent that spawned it.)`,
        };
      }
      if (agent.leadAgentId !== undefined) {
        const lead = agent.leadAgentId;
        return {
          ok: false,
          reason: `Agent ${id} is a Teammate${agent.agentName ? ` (${agent.agentName})` : ''} of agent ${lead}: it is part of its lead's work and ends with it. Close agent ${lead} to end both, or leave it.`,
        };
      }
      if (worktreeChoice === 'discard' && confirmedFiles === undefined) {
        return {
          ok: false,
          reason:
            'Discarding needs confirmed_files: the number of uncommitted files the user agreed to lose.',
        };
      }
      const how = terminals.has(id) ? 'ended' : 'dismissed';
      const teammates = [...store]
        .filter(([, a]) => a.leadAgentId === id)
        .map(([otherId]) => otherId);
      // Closing yourself: the reply has to reach your CLI, and your CLI has to
      // record the turn, before it is ended (an agent with no terminal of ours
      // has no process here to end).
      const afterReply = id === caller && how === 'ended';
      const end = afterReply
        ? (closing: number) => {
            const cancel = closeAfterTurn(store, closing, (c) => {
              selfCloses.delete(cancel);
              close(c);
            });
            selfCloses.add(cancel);
          }
        : close;
      const attempt = await closeAgentAsking(store, id, { worktreeChoice, confirmedFiles }, end);
      if (attempt.closed) {
        const answered = attempt.answered;
        return {
          ok: true,
          id,
          how,
          afterReply,
          teammates,
          worktree: answered
            ? { name: answered.name, branch: answered.branch, choice: answered.decision.choice }
            : null,
        };
      }
      if ('gone' in attempt) return { ok: false, reason: noAgentReason(id) };
      const q = attempt.question;
      const files = `${q.uncommittedFiles} uncommitted file${q.uncommittedFiles === 1 ? '' : 's'}`;
      const where = `Worktree ${q.name} (branch ${q.branch}) of ${q.directoryPath}`;
      const why =
        worktreeChoice === 'discard'
          ? `${q.branch} now has ${files}, more than the ${confirmedFiles} you confirmed discarding, so agent ${id} was not closed. `
          : `Agent ${id} was not closed: it runs in ${where}, which has ${files} and no other agent in it. `;
      return {
        ok: false,
        reason:
          why +
          'Ask the user what to do with them, then call close_agent again with worktree_choice: ' +
          '"save" (commit them to the branch, then remove the folder), "keep" (leave the folder as it is), ' +
          `or "discard" with confirmed_files: ${q.uncommittedFiles} (delete them with the folder).`,
      };
    },

    dispose() {
      for (const cancel of [...selfCloses]) cancel();
      selfCloses.clear();
    },
  };
}
