import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import { readConfig } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
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
    backgroundAgentToolIds: new Set(),
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

/**
 * These tests exercise the area-related dispatch branches and the load-order
 * invariant in handleWebviewReady. They isolate the on-disk config + state
 * files by redirecting $HOME to a fresh temp dir for every test, so the
 * standalone adapter writes its config.json there.
 */
describe('clientMessageHandler: areas + carpet wire ordering', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── saveAreaMappings ─────────────────────────────────────────

  describe('saveAreaMappings', () => {
    it('persists a valid mapping payload to cfg.standalone.areaMappings', () => {
      handleClientMessage(
        {
          type: 'saveAreaMappings',
          mappings: { frontend: ['Engineering'], design: ['Engineering', 'Design'] },
        },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({
        frontend: ['Engineering'],
        design: ['Engineering', 'Design'],
      });
    });

    it('is a no-op when mappings is missing or not an object', () => {
      handleClientMessage({ type: 'saveAreaMappings' }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: 'not-an-object' },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('does not leak into the vscode namespace', () => {
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(cfg.vscode.areaMappings).toEqual({});
    });
  });

  // ── setShowAreas ─────────────────────────────────────────────

  describe('setShowAreas', () => {
    it('persists the boolean via the adapter (standalone namespace)', () => {
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);

      const adapter = store.getAdapter()!;
      expect(adapter.getSetting('pixel-agents.showAreas', false)).toBe(true);

      handleClientMessage({ type: 'setShowAreas', enabled: false }, (m) => sent.push(m), ctx);
      expect(adapter.getSetting('pixel-agents.showAreas', true)).toBe(false);
    });
  });

  // ── hooksStatus (actual install state, not the hooksEnabled setting) ──

  describe('hooksStatus', () => {
    it('webviewReady reports installed: false when no hooks are in settings.json', async () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      // The provider check is async; the message lands after the sync handshake.
      await new Promise((r) => setTimeout(r, 0));

      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', installed: false });
    });

    it('setHooksEnabled reports the actual outcome after the side effect settles', async () => {
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = async () => {
        sideEffectRan = true;
      };
      handleClientMessage({ type: 'setHooksEnabled', enabled: true }, (m) => sent.push(m), ctx);
      await new Promise((r) => setTimeout(r, 0));

      expect(sideEffectRan).toBe(true);
      // The side effect installed nothing (stub), so the truthful answer is false
      // even though the user just toggled the setting ON.
      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', installed: false });
    });
  });

  // ── handleWebviewReady ordering ──────────────────────────────

  describe('handleWebviewReady ordering', () => {
    it('emits settingsLoaded with showAreas before areaMappingsLoaded before existingAgents', () => {
      // Seed config so the assertion proves the values round-trip via the
      // dispatch rather than just relying on hard-coded defaults.
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );
      sent = [];

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);

      const iSettings = types.indexOf('settingsLoaded');
      const iAreaMappings = types.indexOf('areaMappingsLoaded');
      const iExistingAgents = types.indexOf('existingAgents');

      expect(iSettings).toBeGreaterThanOrEqual(0);
      expect(iAreaMappings).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iSettings).toBeLessThan(iAreaMappings);
      expect(iAreaMappings).toBeLessThan(iExistingAgents);

      const settings = sent[iSettings] as { showAreas?: boolean };
      expect(settings.showAreas).toBe(true);

      const mappings = sent[iAreaMappings] as { mappings?: Record<string, string[]> };
      expect(mappings.mappings).toEqual({ frontend: ['Engineering'] });
    });

    it('emits layoutLoaded after existingAgents so buffered agents materialize', () => {
      // The webview buffers agents from existingAgents and only materializes
      // them on the next layoutLoaded. If layout arrives first, a client
      // connecting after agents were created never renders their characters.
      store.set(1, createTestAgent({ id: 1 }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iExistingAgents = types.indexOf('existingAgents');
      const iLayout = types.indexOf('layoutLoaded');

      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeLessThan(iLayout);

      const existing = sent[iExistingAgents] as { agents?: number[] };
      expect(existing.agents).toEqual([1]);
    });

    it('emits carpetTilesLoaded after wallTilesLoaded when both are present in the cache', () => {
      // Hex placeholders are test fixtures, not UI tokens — disable the
      // centralized-color rule just for this cache literal.
      /* eslint-disable pixel-agents/no-inline-colors */
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: [[['#000000']]],
        wallTiles: [[[['#aabbcc']]]],
        carpetTiles: [[[['#112233']]]],
        furniture: null,
        defaultLayout: null,
      };
      /* eslint-enable pixel-agents/no-inline-colors */
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iWalls = types.indexOf('wallTilesLoaded');
      const iCarpets = types.indexOf('carpetTilesLoaded');

      expect(iWalls).toBeGreaterThanOrEqual(0);
      expect(iCarpets).toBeGreaterThanOrEqual(0);
      expect(iWalls).toBeLessThan(iCarpets);
    });

    it('skips carpetTilesLoaded when the cache has no carpet sprites', () => {
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: null,
        wallTiles: null,
        carpetTiles: null,
        furniture: null,
        defaultLayout: null,
      };
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const carpetMsgs = sent.filter((m) => m.type === 'carpetTilesLoaded');
      expect(carpetMsgs).toHaveLength(0);
    });

    it('always emits areaMappingsLoaded, even with no persisted mappings (sends {})', () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const areaMsgs = sent.filter((m) => m.type === 'areaMappingsLoaded');
      expect(areaMsgs).toHaveLength(1);
      expect((areaMsgs[0] as { mappings: Record<string, string[]> }).mappings).toEqual({});
    });
  });
});

describe('clientMessageHandler: saveAgentSeats palette sync', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-seats-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('syncs in-range palette/hueShift onto the matching AgentState', () => {
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2, palette: 0, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: {
          '1': { palette: 4, hueShift: 120, seatId: 'seat-a' },
          '2': { palette: 2, hueShift: 60, seatId: 'seat-b' },
        },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(4);
    expect(store.get(1)?.hueShift).toBe(120);
    expect(store.get(2)?.palette).toBe(2);
    expect(store.get(2)?.hueShift).toBe(60);
  });

  it('drops an out-of-range palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 1, hueShift: 10 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 99, hueShift: 50, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(1);
    // hueShift 50 is in range → still synced.
    expect(store.get(1)?.hueShift).toBe(50);
  });

  it('drops a negative hue shift and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 0, hueShift: 30 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2, hueShift: -5, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    // palette 2 is in range → synced.
    expect(store.get(1)?.palette).toBe(2);
    expect(store.get(1)?.hueShift).toBe(30);
  });

  it('drops a non-integer palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 5, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2.5, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(5);
    expect(store.get(1)?.hueShift).toBe(90);
  });

  it('accepts the upper hue boundary (360) and lower palette boundary (0)', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 0, hueShift: 360, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(0);
    expect(store.get(1)?.hueShift).toBe(360);
  });

  it('silently skips seat entries for unknown agent ids', () => {
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '999': { palette: 3, hueShift: 100, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(999)).toBeUndefined();
  });

  it('accepts palette 7 when the cache has 8 character sprites', () => {
    // The guard reads ctx.cache?.characters?.characters.length instead
    // of hardcoding PALETTE_COUNT. With 8 sprites, palette 7 is valid.
    const cache: AssetCache = {
      characters: {
        characters: [
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
        ],
      },
      pets: null,
      floorTiles: null,
      wallTiles: null,
      carpetTiles: null,
      furniture: null,
      defaultLayout: null,
    };
    ctx = freshCtx(cache);
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 7, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(7);
    // palette 8 is still out of range for 8 sprites → dropped.
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 8, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );
    expect(store.get(1)?.palette).toBe(7);
  });
});
