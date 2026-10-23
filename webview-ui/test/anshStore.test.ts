/**
 * Ansh's brain in the webview (ansh/anshStore.ts): the state the thoughts
 * panel shows, the bubble a new thought puts up, and "Ask Ansh" settling when
 * the server answers -- with a thought, or with a state that says no.
 *
 * Run with: npm test
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { AnshBrainState, AnshThoughtEntry } from '../../core/src/messages.js';
import {
  clearAnshBubble,
  getAnshState,
  handleAnshMessage,
  initialAnshState,
  markAnshAsking,
  reduceAnshMessage,
  resetAnshStore,
} from '../src/ansh/anshStore.js';

const thought: AnshThoughtEntry = {
  at: 1,
  action: 'visit',
  targetId: 7,
  say: 'Need me?',
  aiWritten: true,
};
const brain = (over: Partial<AnshBrainState> = {}): AnshBrainState => ({
  type: 'anshBrainState',
  enabled: true,
  thinking: false,
  thoughtsToday: 1,
  dailyCap: 40,
  thoughts: [thought],
  ...over,
});

beforeEach(() => resetAnshStore());

describe('the Ansh store', () => {
  it('takes the brain state for the panel', () => {
    const s = reduceAnshMessage(initialAnshState(), brain(), 0);
    expect(s).toMatchObject({ supported: true, enabled: true, thoughtsToday: 1, dailyCap: 40 });
    expect(s.thoughts).toEqual([thought]);
    expect(s.bubble).toBeNull();
  });

  it('a new thought puts up the bubble and walks him (onThought)', () => {
    const walked: AnshThoughtEntry[] = [];
    expect(
      handleAnshMessage(
        { type: 'anshThought', thought },
        { onThought: (t) => walked.push(t) },
        123,
      ),
    ).toBe(true);
    expect(walked).toEqual([thought]);
    expect(getAnshState().bubble).toEqual({ thought, shownAt: 123 });
    clearAnshBubble();
    expect(getAnshState().bubble).toBeNull();
  });

  it('"Ask Ansh" settles on the thought, or on a state that is not thinking', () => {
    markAnshAsking();
    handleAnshMessage(brain({ thinking: true }));
    expect(getAnshState().asking).toBe(true);
    handleAnshMessage({ type: 'anshThought', thought });
    expect(getAnshState().asking).toBe(false);
    markAnshAsking();
    handleAnshMessage(brain({ thinking: false })); // refused: too soon or over the cap
    expect(getAnshState().asking).toBe(false);
  });

  it('ignores every other message', () => {
    expect(handleAnshMessage({ type: 'reportReady', date: '2026-10-18' })).toBe(false);
    expect(getAnshState()).toEqual(initialAnshState());
  });
});
