import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HUE_SHIFT_MAX_DEG, PALETTE_COUNT } from '../src/constants.js';
import { assignPaletteIfNeeded, setPaletteCount } from '../src/paletteAssigner.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundSpawns: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

describe('paletteAssigner', () => {
  let store: AgentStateStore;

  beforeEach(() => {
    store = new AgentStateStore();
  });

  afterEach(() => {
    // Reset module-level count so tests don't leak into each other.
    setPaletteCount(PALETTE_COUNT);
  });

  describe('assignPaletteIfNeeded', () => {
    it('is a no-op when palette is already set', () => {
      const agent = createTestAgent({ id: 1, palette: 3, hueShift: 10 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBe(3);
      expect(agent.hueShift).toBe(10);
    });

    it('assigns a palette in [0, PALETTE_COUNT) with no hue shift on an empty store (first round)', () => {
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBeGreaterThanOrEqual(0);
      expect(agent.palette).toBeLessThan(PALETTE_COUNT);
      expect(agent.hueShift).toBe(0);
    });

    it('picks a least-used palette (one of the palettes at the minimum count)', () => {
      // Seed counts: 0->3, 1->2, 2->1, 3->1, 4->1, 5->1. minCount=1,
      // available = [2, 3, 4, 5].
      const palettes = [0, 0, 0, 1, 1, 2, 3, 4, 5];
      for (let i = 0; i < palettes.length; i++) {
        store.set(100 + i, createTestAgent({ id: 100 + i, palette: palettes[i], hueShift: 0 }));
      }
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect([2, 3, 4, 5]).toContain(agent.palette);
      // minCount > 0 → hue shift in [45, 315].
      expect(agent.hueShift).toBeGreaterThanOrEqual(45);
      expect(agent.hueShift).toBeLessThanOrEqual(HUE_SHIFT_MAX_DEG);
    });

    it('counts only agents with a defined in-range palette', () => {
      // Two agents with undefined palette and one out-of-range must not move
      // the minCount, so the first real assignment stays in the first round
      // (hueShift === 0) and can pick any of [0..5].
      store.set(10, createTestAgent({ id: 10 })); // palette undefined
      store.set(11, createTestAgent({ id: 11, palette: 99 })); // out of range
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBeGreaterThanOrEqual(0);
      expect(agent.palette).toBeLessThan(PALETTE_COUNT);
      expect(agent.hueShift).toBe(0);
    });

    it('does not mutate the store', () => {
      store.set(1, createTestAgent({ id: 1, palette: 2, hueShift: 0 }));
      const before = new Map<number, AgentState>();
      for (const [id, a] of store) before.set(id, { ...a });

      const agent = createTestAgent({ id: 2 });
      assignPaletteIfNeeded(agent, store);

      for (const [id, a] of store) {
        const prev = before.get(id);
        expect(prev).toBeDefined();
        expect(a.palette).toBe(prev?.palette);
        expect(a.hueShift).toBe(prev?.hueShift);
      }
    });
  });

  describe('setPaletteCount', () => {
    it('picks from [0, N) when set above the default 6', () => {
      setPaletteCount(8);
      // Six agents get 0..5; the seventh must pick from [0, 8) -- if the
      // count were still 6, it would re-pick 0..5 and never 6 or 7.
      for (let i = 0; i < 6; i++) {
        store.set(100 + i, createTestAgent({ id: 100 + i, palette: i, hueShift: 0 }));
      }
      // minCount across 0..5 is 1, and palettes 6,7 are at count 0 -- the
      // least-used set is {6, 7}, so the pick must be 6 or 7.
      const agent = createTestAgent({ id: 999 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBeGreaterThanOrEqual(6);
      expect(agent.palette).toBeLessThan(8);
      expect(agent.hueShift).toBe(0); // minCount === 0 for 6 and 7
    });
  });
});
