/**
 * A tutorial run's progress, as a pure reducer: which quests are open, done
 * or skipped. The owner (tutorial.ts) turns what the server sees and the
 * user's skips into these events; nothing here knows the store or the wire.
 */

import type { TutorialQuestState } from '../../../core/src/messages.js';
import { TUTORIAL_QUESTS } from '../../../core/src/tutorial/quests.js';

export interface TutorialRunState {
  /** The agent running it (the Guide). */
  agentId: number;
  quests: ReadonlyArray<{ id: string; state: TutorialQuestState }>;
}

/** No run: the tutorial is off (never started, quit, or its agent left). */
export type TutorialProgress = TutorialRunState | null;

export type TutorialProgressEvent =
  | { kind: 'started'; agentId: number }
  /** The server saw a quest done. */
  | { kind: 'questDone'; questId: string }
  | { kind: 'questSkipped'; questId: string }
  /** The user quit, or the run's agent left the office. */
  | { kind: 'ended' };

export function reduceTutorialProgress(
  state: TutorialProgress,
  event: TutorialProgressEvent,
): TutorialProgress {
  switch (event.kind) {
    case 'started':
      return {
        agentId: event.agentId,
        quests: TUTORIAL_QUESTS.map((q) => ({ id: q.id, state: 'open' as const })),
      };
    case 'questDone':
      return settle(state, event.questId, 'done');
    case 'questSkipped':
      return settle(state, event.questId, 'skipped');
    case 'ended':
      return null;
  }
}

/** Close an OPEN quest; anything else (no run, unknown, already closed) is unchanged. */
function settle(
  state: TutorialProgress,
  questId: string,
  to: Exclude<TutorialQuestState, 'open'>,
): TutorialProgress {
  if (!state) return state;
  const index = state.quests.findIndex((q) => q.id === questId);
  if (index < 0 || state.quests[index].state !== 'open') return state;
  const quests = state.quests.map((q, i) => (i === index ? { ...q, state: to } : q));
  return { ...state, quests };
}

/** Every quest done or skipped. */
export function isTutorialFinished(state: TutorialProgress): boolean {
  return state !== null && state.quests.every((q) => q.state !== 'open');
}
