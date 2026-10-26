import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import {
  assignPaletteIfNeeded,
  getPaletteCount,
  setExternalCharacterCount,
} from '../src/paletteAssigner.js';
import type { AgentState } from '../src/types.js';

const PALETTE_COUNT = DEFAULT_CHARACTER_PROFILES.length;

const tempHomes: string[] = [];

/** A fresh $HOME whose characters.json holds `count` profiles (none = the defaults). */
function useHomeWithProfiles(count?: number): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-palette-'));
  tempHomes.push(home);
  process.env.HOME = home;
  if (count === undefined) return;
  const dir = path.join(home, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  const profiles = Array.from({ length: count }, (_, i) => ({
    name: `P${i}`,
    body: 'flat',
    v: 35,
  }));
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify(profiles));
}

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
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    useHomeWithProfiles();
    store = new AgentStateStore();
  });

  afterEach(() => {
    // Reset module-level state so tests don't leak into each other.
    process.env.HOME = originalHome;
    for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
    setExternalCharacterCount(0);
    vi.restoreAllMocks();
  });

  /** Make Math.random return `values` in turn (then the last one forever). */
  function randomReturns(...values: number[]): void {
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => values[Math.min(i++, values.length - 1)]);
  }

  describe('assignPaletteIfNeeded', () => {
    it('is a no-op when palette is already set', () => {
      const agent = createTestAgent({ id: 1, palette: 3, repeat: 10 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBe(3);
      expect(agent.repeat).toBe(10);
    });

    it('assigns a palette in [0, PALETTE_COUNT) as no repeat on an empty store', () => {
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBeGreaterThanOrEqual(0);
      expect(agent.palette).toBeLessThan(PALETTE_COUNT);
      expect(agent.repeat).toBe(0);
    });

    it('never repeats a character in the office while another is free', () => {
      for (let p = 0; p < PALETTE_COUNT - 1; p++) {
        store.set(100 + p, createTestAgent({ id: 100 + p, palette: p, repeat: 0 }));
      }
      randomReturns(0);
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBe(PALETTE_COUNT - 1);
      expect(agent.repeat).toBe(0);
    });

    it('repeats, as the first repeat, only once the whole cast is in the office', () => {
      for (let p = 0; p < PALETTE_COUNT; p++) {
        store.set(100 + p, createTestAgent({ id: 100 + p, palette: p, repeat: 0 }));
      }
      randomReturns(0, 0.5);
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBe(0);
      expect(agent.repeat).toBe(1);
    });

    it("leaves other Directories' default characters free when it can", () => {
      // Every character but 0 and 1 is some Directory's default.
      const cfg = readConfig();
      cfg.directories = [
        { name: 'A', path: '/a', characters: [2, 3] },
        {
          name: 'B',
          path: '/b',
          characters: Array.from({ length: PALETTE_COUNT - 4 }, (_, i) => i + 4),
        },
      ];
      writeConfig(cfg);
      store.set(100, createTestAgent({ id: 100, palette: 0, repeat: 0 }));
      randomReturns(0.99);
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBe(1);
      expect(agent.repeat).toBe(0);
    });

    it('wears an unworn pick exactly', () => {
      store.set(100, createTestAgent({ id: 100, palette: 0, repeat: 0 }));
      randomReturns(0.99);
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBe(PALETTE_COUNT - 1);
      expect(agent.repeat).toBe(0);
    });

    it('counts only agents with a defined in-range palette', () => {
      // Agents with an undefined or out-of-range palette wear no character of
      // the cast, so the first real assignment is no repeat and can pick any of [0..5].
      store.set(10, createTestAgent({ id: 10 })); // palette undefined
      store.set(11, createTestAgent({ id: 11, palette: 99 })); // out of range
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBeGreaterThanOrEqual(0);
      expect(agent.palette).toBeLessThan(PALETTE_COUNT);
      expect(agent.repeat).toBe(0);
    });

    it('does not mutate the store', () => {
      store.set(1, createTestAgent({ id: 1, palette: 2, repeat: 0 }));
      const before = new Map<number, AgentState>();
      for (const [id, a] of store) before.set(id, { ...a });

      const agent = createTestAgent({ id: 2 });
      assignPaletteIfNeeded(agent, store);

      for (const [id, a] of store) {
        const prev = before.get(id);
        expect(prev).toBeDefined();
        expect(a.palette).toBe(prev?.palette);
        expect(a.repeat).toBe(prev?.repeat);
      }
    });
  });

  describe('palette count', () => {
    it('counts the saved character profiles plus external sprites', () => {
      useHomeWithProfiles(10);
      setExternalCharacterCount(3);
      expect(getPaletteCount()).toBe(13);
    });

    it('counts the six defaults when no profiles are saved', () => {
      expect(getPaletteCount()).toBe(PALETTE_COUNT);
    });

    it('picks from [0, N) when the cast grows past the default 6', () => {
      useHomeWithProfiles(7);
      setExternalCharacterCount(1);
      // The top of the random range lands on palette 7: if the count were
      // still 6, it could never pick 6 or 7.
      randomReturns(0.99);
      const agent = createTestAgent({ id: 999 });
      assignPaletteIfNeeded(agent, store);
      expect(agent.palette).toBe(7);
      expect(agent.repeat).toBe(0);
    });
  });

  describe("a launch's look", () => {
    const dir = (characters: number[], characterOrder?: 'priority' | 'random') => ({
      name: 'D',
      path: '/d',
      source: 'user' as const,
      characters,
      characterOrder,
    });

    it('wears the first default nobody wears, exactly', () => {
      store.set(100, createTestAgent({ id: 100, palette: 4, repeat: 0 }));
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store, { directory: dir([4, 2, 1]) });
      expect(agent.palette).toBe(2);
      expect(agent.repeat).toBe(0);
    });

    it('falls back to a random free character when every priority default is worn', () => {
      store.set(100, createTestAgent({ id: 100, palette: 4, repeat: 0 }));
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store, { directory: dir([4]) });
      expect(agent.palette).not.toBe(4);
      expect(agent.repeat).toBe(0);
    });

    it('random order never repeats a default already in the office', () => {
      store.set(100, createTestAgent({ id: 100, palette: 4, repeat: 0 }));
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store, { directory: dir([4], 'random') });
      expect(agent.palette).not.toBe(4);
      expect(agent.repeat).toBe(0);
    });

    it('wears a roster pick already in the office as its next repeat', () => {
      store.set(100, createTestAgent({ id: 100, palette: 3, repeat: 0 }));
      store.set(101, createTestAgent({ id: 101, palette: 3, repeat: 1 }));
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store, { picked: 3 });
      expect(agent).toMatchObject({ palette: 3, repeat: 2 });
    });

    it("a roster pick wins over the Directory's defaults", () => {
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store, { picked: 3, directory: dir([1]) });
      expect(agent.palette).toBe(3);
    });

    it('skips defaults past the cast (a deleted character)', () => {
      const agent = createTestAgent({ id: 1 });
      assignPaletteIfNeeded(agent, store, { directory: dir([PALETTE_COUNT + 2, 1]) });
      expect(agent.palette).toBe(1);
    });
  });
});
