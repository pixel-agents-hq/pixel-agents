import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import { readConfig } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import type { AgentState } from '../src/types.js';

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

/**
 * Terminal control plane: how the handler wires PtySessionManager into the
 * protocol. The data plane (frames over /terminal/:agentId) is covered by
 * terminalRoutes.test.ts; the launch mechanics by standaloneAgentLauncher.
 * test.ts. What's asserted here is the dispatch glue: availability broadcast
 * on webviewReady, live-session re-announcement for reloading browsers, and
 * launch/close routing.
 */
describe('clientMessageHandler: standalone terminal control plane', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;

  class FakePty implements IPty {
    readonly pid = 4242;
    killSignals: Array<string | undefined> = [];
    onData(): void {}
    onExit(): void {}
    write(): void {}
    resize(): void {}
    kill(signal?: string): void {
      this.killSignals.push(signal);
    }
  }

  function workingPtyManager(): { manager: PtySessionManager; spawned: FakePty[] } {
    const spawned: FakePty[] = [];
    const module: PtyModule = {
      spawn: () => {
        const pty = new FakePty();
        spawned.push(pty);
        return pty;
      },
    };
    const manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
    return { manager, spawned };
  }

  /** Minimal store agent; only identity fields matter to the control plane. */
  function makeAgent(id: number): AgentState {
    return {
      id,
      sessionId: `session-${id}`,
      terminalRef: undefined,
      isExternal: false,
      projectDir: path.join(tempHome, 'nowhere'),
      jsonlFile: path.join(tempHome, 'nowhere', `session-${id}.jsonl`),
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
      inputTokens: 0,
      outputTokens: 0,
      providerId: 'claude',
    };
  }

  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, cache: null, ...overrides };
  }

  function dispatch(msg: Record<string, unknown>, context: ClientMessageContext): void {
    handleClientMessage(msg, (m) => sent.push(m), context);
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-term-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    sent = [];
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    runtime.dispose();
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── webviewReady: availability ───────────────────────────────

  it('webviewReady announces terminal availability after capabilities, before existingAgents', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    const types = sent.map((m) => m.type);
    const availabilityIndex = types.indexOf('terminalAvailability');
    expect(sent[availabilityIndex]).toEqual({
      type: 'terminalAvailability',
      available: true,
      reason: undefined,
    });
    expect(availabilityIndex).toBeGreaterThan(types.indexOf('providerCapabilities'));
    expect(availabilityIndex).toBeLessThan(types.indexOf('existingAgents'));
  });

  it('webviewReady reports the unavailable reason (e.g. --no-terminal)', () => {
    const manager = PtySessionManager.disabled('Terminal disabled with --no-terminal.');

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    expect(sent).toContainEqual({
      type: 'terminalAvailability',
      available: false,
      reason: 'Terminal disabled with --no-terminal.',
    });
  });

  it('webviewReady omits every terminal message without a ptyManager (VS Code mode)', () => {
    store.set(1, makeAgent(1));

    dispatch({ type: 'webviewReady' }, ctx());

    const types = sent.map((m) => m.type);
    expect(types).not.toContain('terminalAvailability');
    expect(types).not.toContain('terminalSessionOpened');
  });

  // ── webviewReady: live-session re-announcement ───────────────

  it('webviewReady re-announces live terminals after existingAgents, and only those', () => {
    const { manager } = workingPtyManager();
    store.set(1, makeAgent(1));
    store.set(2, makeAgent(2));
    manager.create({ agentId: 1, command: 'claude', args: [], cwd: tempHome });

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    const opened = sent.filter((m) => m.type === 'terminalSessionOpened');
    expect(opened).toEqual([{ type: 'terminalSessionOpened', agentId: 1 }]);
    const types = sent.map((m) => m.type);
    expect(types.indexOf('terminalSessionOpened')).toBeGreaterThan(types.indexOf('existingAgents'));
  });

  // ── launchAgent ──────────────────────────────────────────────

  it('launchAgent spawns a PTY-backed agent and announces its terminal', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'launchAgent' }, ctx({ runtime, ptyManager: manager }));

    expect(store.size).toBe(1);
    const id = [...store][0][0];
    expect(manager.has(id)).toBe(true);
    expect(broadcasts).toContainEqual({ type: 'terminalSessionOpened', agentId: id });
  });

  it('launchAgent is ignored without a ptyManager', () => {
    dispatch({ type: 'launchAgent' }, ctx({ runtime }));

    expect(store.size).toBe(0);
    expect(broadcasts).toHaveLength(0);
  });

  // ── closeAgent ───────────────────────────────────────────────

  it('closeAgent kills the PTY and removes the agent', () => {
    const { manager, spawned } = workingPtyManager();
    store.set(5, makeAgent(5));
    manager.create({ agentId: 5, command: 'claude', args: [], cwd: tempHome });

    dispatch({ type: 'closeAgent', id: 5 }, ctx({ runtime, ptyManager: manager }));

    expect(spawned[0].killSignals.length).toBeGreaterThan(0);
    expect(manager.has(5)).toBe(false);
    expect(store.has(5)).toBe(false);
  });

  it('closeAgent removes an observed agent that has no PTY', () => {
    store.set(7, makeAgent(7));

    dispatch(
      { type: 'closeAgent', id: 7 },
      ctx({ runtime, ptyManager: workingPtyManager().manager }),
    );

    expect(store.has(7)).toBe(false);
  });
});
