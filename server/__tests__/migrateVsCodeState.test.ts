import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the `vscode` module so migrateVsCodeState.ts is importable from a non-VS Code test env.
// vi.hoisted pattern is required because vi.mock is hoisted above imports.
const { showWarningMessage } = vi.hoisted(() => ({ showWarningMessage: vi.fn() }));
vi.mock('vscode', () => ({
  window: { showWarningMessage },
}));

import { migrateVsCodeState } from '../../adapters/vscode/migrateVsCodeState.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { readLayoutFromFile, writeLayoutToFile } from '../src/layoutPersistence.js';

/** Lightweight in-memory Memento for workspaceState/globalState simulation. */
function createMemento(seed: Record<string, unknown> = {}): {
  store: Record<string, unknown>;
  memento: {
    get: (k: string, d?: unknown) => unknown;
    update: (k: string, v: unknown) => Thenable<void>;
  };
} {
  const store: Record<string, unknown> = { ...seed };
  return {
    store,
    memento: {
      get: (key: string, d?: unknown) => (store[key] !== undefined ? store[key] : d),
      update: (key: string, value: unknown) => {
        if (value === undefined) delete store[key];
        else store[key] = value;
        return Promise.resolve();
      },
    },
  };
}

function makeContext(globalSeed = {}, workspaceSeed = {}) {
  const global = createMemento(globalSeed);
  const workspace = createMemento(workspaceSeed);
  return {
    context: {
      globalState: global.memento,
      workspaceState: workspace.memento,
    } as unknown as Parameters<typeof migrateVsCodeState>[0],
    globalStore: global.store,
    workspaceStore: workspace.store,
  };
}

describe('migrateVsCodeState', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-migrate-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    showWarningMessage.mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('migrates all 6 legacy globalState settings to the vscode namespace and clears them', () => {
    const { context, globalStore } = makeContext({
      'pixel-agents.soundEnabled': false,
      'pixel-agents.lastSeenVersion': '1.2.0',
      'pixel-agents.alwaysShowLabels': true,
      'pixel-agents.watchAllSessions': true,
      'pixel-agents.hooksEnabled': false,
      'pixel-agents.hooksInfoShown': true,
    });
    const adapter = new FileStateAdapter({ namespace: 'vscode' });

    migrateVsCodeState(context, adapter);

    expect(adapter.getSetting('pixel-agents.soundEnabled', true)).toBe(false);
    expect(adapter.getSetting('pixel-agents.lastSeenVersion', '')).toBe('1.2.0');
    expect(adapter.getSetting('pixel-agents.alwaysShowLabels', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.watchAllSessions', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.hooksEnabled', true)).toBe(false);
    expect(adapter.getSetting('pixel-agents.hooksInfoShown', false)).toBe(true);
    expect(globalStore).toEqual({});
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('migrates legacy agents + seats from workspaceState to the vscode-state.json file', () => {
    const legacyAgents = [
      {
        id: 1,
        sessionId: 'sess-1',
        terminalName: 'Claude Code #1',
        jsonlFile: '/tmp/sess-1.jsonl',
        projectDir: '/tmp/proj',
      },
    ];
    const legacySeats = { '1': { palette: 2, seatId: 'chair-1' } };
    const { context, workspaceStore } = makeContext(
      {},
      {
        'pixel-agents.agents': legacyAgents,
        'pixel-agents.agentSeats': legacySeats,
      },
    );
    const adapter = new FileStateAdapter({ namespace: 'vscode' });

    migrateVsCodeState(context, adapter);

    expect(adapter.loadAgents()).toEqual(legacyAgents);
    expect(adapter.loadSeats()).toEqual(legacySeats);
    expect(workspaceStore).toEqual({});
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when no legacy state exists (silent)', () => {
    const { context } = makeContext({}, {});
    const adapter = new FileStateAdapter({ namespace: 'vscode' });
    migrateVsCodeState(context, adapter);
    expect(adapter.loadAgents()).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('idempotent: running twice with pre-cleared legacy state does nothing', () => {
    const { context } = makeContext({ 'pixel-agents.soundEnabled': false }, {});
    const adapter = new FileStateAdapter({ namespace: 'vscode' });

    migrateVsCodeState(context, adapter);
    migrateVsCodeState(context, adapter);
    expect(adapter.getSetting('pixel-agents.soundEnabled', true)).toBe(false);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('migrates legacy layout from workspaceState to ~/.pixel-agents/layout.json', () => {
    const legacyLayout = {
      version: 1,
      cols: 20,
      rows: 11,
      tiles: [0, 1, 2],
      furniture: [{ type: 'desk', uid: 'd1', col: 0, row: 0 }],
    };
    const { context, workspaceStore } = makeContext({}, { 'pixel-agents.layout': legacyLayout });
    const adapter = new FileStateAdapter({ namespace: 'vscode' });

    migrateVsCodeState(context, adapter);

    expect(readLayoutFromFile()).toEqual(legacyLayout);
    expect(workspaceStore).toEqual({});
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('does not clobber an existing layout.json file when migrating legacy layout', () => {
    const legacyLayout = { version: 1, cols: 20, rows: 11, tiles: [0], furniture: [] };
    const existingLayout = { version: 1, cols: 30, rows: 15, tiles: [9], furniture: [] };
    writeLayoutToFile(existingLayout);
    const { context, workspaceStore } = makeContext({}, { 'pixel-agents.layout': legacyLayout });
    const adapter = new FileStateAdapter({ namespace: 'vscode' });

    migrateVsCodeState(context, adapter);

    // File preserved (not overwritten); legacy key cleared.
    expect(readLayoutFromFile()).toEqual(existingLayout);
    expect(workspaceStore).toEqual({});
  });

  it('warns + keeps legacy keys if file write fails (simulated via read-only HOME)', () => {
    // Make ~/.pixel-agents/ unwritable by pointing HOME at a non-writable path.
    // Simulate by replacing with a file (so mkdirSync fails on subpath).
    const blocker = path.join(tempHome, 'blocker');
    fs.writeFileSync(blocker, 'x');
    process.env.HOME = blocker; // HOME is now a file; can't mkdir inside

    const { context, globalStore } = makeContext({
      'pixel-agents.soundEnabled': false,
    });
    const adapter = new FileStateAdapter({ namespace: 'vscode' });
    migrateVsCodeState(context, adapter);

    // Legacy key remains because the write silently failed -> verify !== legacy
    expect(globalStore['pixel-agents.soundEnabled']).toBe(false);
    expect(showWarningMessage).toHaveBeenCalledOnce();
  });
});
