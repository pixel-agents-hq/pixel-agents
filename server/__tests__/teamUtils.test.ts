import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { getInlineTeammates, hasInlineTeammates, isInlineTeammateOf } from '../src/teamUtils.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing -- only the fields teamUtils actually reads. */
function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 0,
    leadAgentId: undefined,
    teamUsesTmux: false,
    ...overrides,
  } as AgentState;
}

/** Create an AgentStateStore from [id, agent] entries. */
function storeFrom(entries: Array<[number, AgentState]>): AgentStateStore {
  const s = new AgentStateStore();
  for (const [id, a] of entries) s.set(id, a);
  return s;
}

describe('teamUtils', () => {
  describe('isInlineTeammateOf', () => {
    it('returns true when leadAgentId matches and teamUsesTmux is false', () => {
      expect(isInlineTeammateOf(agent({ leadAgentId: 5, teamUsesTmux: false }), 5)).toBe(true);
    });

    it('returns true when leadAgentId matches and teamUsesTmux is undefined', () => {
      expect(isInlineTeammateOf(agent({ leadAgentId: 5 }), 5)).toBe(true);
    });

    it('returns false when leadAgentId does not match', () => {
      expect(isInlineTeammateOf(agent({ leadAgentId: 5 }), 6)).toBe(false);
    });

    it('returns false when teamUsesTmux is true (tmux teammate)', () => {
      expect(isInlineTeammateOf(agent({ leadAgentId: 5, teamUsesTmux: true }), 5)).toBe(false);
    });

    it('returns false when leadAgentId is undefined (not a teammate)', () => {
      expect(isInlineTeammateOf(agent({ leadAgentId: undefined }), 5)).toBe(false);
    });
  });

  describe('getInlineTeammates', () => {
    it('returns only inline teammates of the given lead', () => {
      const agents = storeFrom([
        [1, agent({ id: 1 })], // lead
        [2, agent({ id: 2, leadAgentId: 1 })], // inline teammate of lead 1
        [3, agent({ id: 3, leadAgentId: 1, teamUsesTmux: true })], // tmux teammate
        [4, agent({ id: 4, leadAgentId: 99 })], // teammate of a different lead
        [5, agent({ id: 5, leadAgentId: 1 })], // another inline teammate
      ]);
      const result = getInlineTeammates(1, agents);
      expect(result.map(([id]) => id).sort()).toEqual([2, 5]);
    });

    it('returns empty array when no teammates exist', () => {
      const agents = storeFrom([[1, agent({ id: 1 })]]);
      expect(getInlineTeammates(1, agents)).toEqual([]);
    });

    it('returns [id, agent] pairs preserving agent references', () => {
      const teammate = agent({ id: 2, leadAgentId: 1 });
      const agents = storeFrom([[2, teammate]]);
      const result = getInlineTeammates(1, agents);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual([2, teammate]);
      expect(result[0][1]).toBe(teammate);
    });
  });

  describe('hasInlineTeammates', () => {
    it('returns true when at least one inline teammate exists', () => {
      const agents = storeFrom([
        [1, agent({ id: 1 })],
        [2, agent({ id: 2, leadAgentId: 1 })],
      ]);
      expect(hasInlineTeammates(1, agents)).toBe(true);
    });

    it('returns false when only tmux teammates exist', () => {
      const agents = storeFrom([
        [1, agent({ id: 1 })],
        [2, agent({ id: 2, leadAgentId: 1, teamUsesTmux: true })],
      ]);
      expect(hasInlineTeammates(1, agents)).toBe(false);
    });

    it('returns false when lead has no teammates', () => {
      const agents = storeFrom([[1, agent({ id: 1 })]]);
      expect(hasInlineTeammates(1, agents)).toBe(false);
    });

    it('short-circuits on first match (performance, not behavioral)', () => {
      const agents = storeFrom([
        [1, agent({ id: 1 })],
        [2, agent({ id: 2, leadAgentId: 1 })],
        [3, agent({ id: 3, leadAgentId: 1 })],
        [4, agent({ id: 4, leadAgentId: 1 })],
      ]);
      expect(hasInlineTeammates(1, agents)).toBe(true);
    });
  });
});
