import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import {
  createStoppedAgent,
  normalizeAgentName,
  startStoppedAgent,
} from '../src/terminal/standaloneAgentRecords.js';
import type { PersistedAgent } from '../src/types.js';

/**
 * A record is an agent with no process: `createAgent` makes one, `startAgent`
 * gives it Claude Code. These tests use a real AgentRuntime and store, a fake
 * PTY module, and an in-memory adapter for what survives a restart.
 */

class FakePty implements IPty {
  readonly pid = 4242;
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(): void {}
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  exit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }
}

interface PtyHarness {
  manager: PtySessionManager;
  spawned: FakePty[];
  spawnArgs: Array<{ file: string; args: string[]; options: PtySpawnOptions }>;
}

function ptyManager(options: { failSpawn?: boolean } = {}): PtyHarness {
  const spawned: FakePty[] = [];
  const spawnArgs: PtyHarness['spawnArgs'] = [];
  const module: PtyModule = {
    spawn: (file, args, spawnOptions) => {
      if (options.failSpawn) throw new Error('spawn failed');
      spawnArgs.push({ file, args, options: spawnOptions });
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
  };
  const manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
  return { manager, spawned, spawnArgs };
}

function memoryAdapter(
  initial: PersistedAgent[] = [],
): StateAdapter & { current: PersistedAgent[] } {
  const adapter = {
    current: initial,
    loadAgents: () => adapter.current,
    saveAgents: (agents: PersistedAgent[]) => {
      adapter.current = agents;
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: vi.fn<(key: string, value: unknown) => void>(),
  };
  return adapter;
}

describe('agent records (create, start, restore)', () => {
  let tempDir: string;
  let projectDir: string;
  let cwd: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let adapter: ReturnType<typeof memoryAdapter>;
  let broadcasts: Array<Record<string, unknown>>;

  function provider(): HookProvider {
    return { ...claudeProvider, getSessionDirs: () => [projectDir] };
  }

  function create(options: Partial<Parameters<typeof createStoppedAgent>[1]> = {}) {
    return createStoppedAgent({ store, provider: provider() }, { directoryPath: cwd, ...options });
  }

  function start(harness: PtyHarness, id: number) {
    return startStoppedAgent(
      { store, runtime, ptyManager: harness.manager, provider: provider() },
      id,
    );
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-records-test-'));
    projectDir = path.join(tempDir, 'project-sessions');
    cwd = path.join(tempDir, 'workspace');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(cwd);
    adapter = memoryAdapter();
    store = new AgentStateStore();
    store.setAdapter(adapter);
    runtime = new AgentRuntime(store, claudeProvider);
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime.dispose();
    store.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createStoppedAgent', () => {
    it('registers a stopped record and spawns nothing', () => {
      const harness = ptyManager();
      const id = create({ name: 'backend' });

      expect(id).toBe(1);
      const agent = store.get(1);
      expect(agent).toMatchObject({
        isExternal: false,
        stopped: true,
        displayName: 'backend',
        launchDirectory: cwd,
      });
      expect(agent?.jsonlFile).toBe(path.join(projectDir, `${agent?.sessionId}.jsonl`));
      expect(agent?.palette).toBeTypeOf('number');
      expect(harness.spawned).toHaveLength(0);
      expect(harness.manager.has(1)).toBe(false);
    });

    it('persists what a restart needs to start it later', () => {
      create({ name: 'backend', permissionRoles: ['R', 'E'] });

      expect(adapter.current).toHaveLength(1);
      expect(adapter.current[0]).toMatchObject({
        id: 1,
        stopped: true,
        displayName: 'backend',
        launchDirectory: cwd,
        permissionRoles: ['R', 'E'],
      });
    });

    it('refuses a path that is not a directory without burning an agent id', () => {
      expect(create({ directoryPath: path.join(tempDir, 'missing') })).toBeNull();
      expect(store.size).toBe(0);
      expect(create()).toBe(1);
    });
  });

  describe('startStoppedAgent', () => {
    it('starts a fresh session when no transcript exists yet', () => {
      const harness = ptyManager();
      const id = create()!;
      const sessionId = store.get(id)!.sessionId;

      expect(start(harness, id)).toBe(true);

      expect(harness.spawnArgs[0].args).toEqual(['--session-id', sessionId]);
      expect(harness.spawnArgs[0].options.cwd).toBe(cwd);
      expect(harness.manager.has(id)).toBe(true);
      const agent = store.get(id)!;
      expect(agent.stopped).toBe(false);
      expect(agent.launchDirectory).toBeUndefined();
      expect(runtime.knownJsonlFiles.has(agent.jsonlFile)).toBe(true);
      expect(broadcasts).toContainEqual({ type: 'terminalSessionOpened', agentId: id });
    });

    it('resumes the same session when its transcript already exists', () => {
      const harness = ptyManager();
      const id = create()!;
      const agent = store.get(id)!;
      fs.writeFileSync(agent.jsonlFile, '{"type":"user"}\n');

      expect(start(harness, id)).toBe(true);

      expect(harness.spawnArgs[0].args).toEqual(['--resume', agent.sessionId]);
      // Watching starts at the end, so the history does not replay as live activity.
      expect(agent.fileOffset).toBe(fs.statSync(agent.jsonlFile).size);
    });

    it('applies the permission roles stored on the record', () => {
      const harness = ptyManager();
      const id = create({ permissionRoles: ['R'] })!;

      start(harness, id);

      expect(store.get(id)?.permissionRoles).toEqual(['R']);
    });

    it('does nothing for an agent that is already running', () => {
      const harness = ptyManager();
      const id = create()!;
      expect(start(harness, id)).toBe(true);

      expect(start(harness, id)).toBe(false);
      expect(harness.spawned).toHaveLength(1);
    });

    it('does nothing for an unknown id', () => {
      const harness = ptyManager();
      expect(start(harness, 99)).toBe(false);
      expect(harness.spawned).toHaveLength(0);
    });

    it('leaves the record stopped when the spawn fails', () => {
      const harness = ptyManager({ failSpawn: true });
      const id = create()!;

      expect(start(harness, id)).toBe(false);

      const agent = store.get(id);
      expect(agent?.stopped).toBe(true);
      expect(agent?.launchDirectory).toBe(cwd);
      expect(store.nextAgentId.current).toBe(2);
    });

    it('removes the agent when its process exits', () => {
      const harness = ptyManager();
      const id = create()!;
      start(harness, id);

      harness.spawned[0].exit(0);

      expect(store.has(id)).toBe(false);
    });
  });

  describe('restore after a restart', () => {
    it('brings a stopped record back, ready to start', () => {
      const id = create({ name: 'backend', permissionRoles: null })!;
      const record = store.get(id)!;
      const persisted = adapter.current;

      const restartedStore = new AgentStateStore();
      restartedStore.setAdapter(memoryAdapter(persisted));
      const restarted = new AgentRuntime(restartedStore, claudeProvider);
      try {
        restarted.restoreExternalAgents();

        const restored = restartedStore.get(id);
        expect(restored).toMatchObject({
          stopped: true,
          isExternal: false,
          displayName: 'backend',
          launchDirectory: cwd,
          sessionId: record.sessionId,
          permissionRoles: null,
        });
        expect(restartedStore.nextAgentId.current).toBe(id + 1);

        const harness = ptyManager();
        expect(
          startStoppedAgent(
            {
              store: restartedStore,
              runtime: restarted,
              ptyManager: harness.manager,
              provider: provider(),
            },
            id,
          ),
        ).toBe(true);
        expect(harness.spawnArgs[0].args).toEqual(['--session-id', record.sessionId]);
      } finally {
        restarted.dispose();
        restartedStore.dispose();
      }
    });

    it('does not bring back a running PTY agent', () => {
      const harness = ptyManager();
      const id = create()!;
      start(harness, id);

      expect(adapter.current[0]?.stopped).toBeUndefined();

      const restartedStore = new AgentStateStore();
      restartedStore.setAdapter(memoryAdapter(adapter.current));
      const restarted = new AgentRuntime(restartedStore, claudeProvider);
      try {
        restarted.restoreExternalAgents();
        expect(restartedStore.has(id)).toBe(false);
      } finally {
        restarted.dispose();
        restartedStore.dispose();
      }
    });
  });
});

describe('normalizeAgentName', () => {
  it('trims and limits the name', () => {
    expect(normalizeAgentName('  backend  ')).toBe('backend');
    expect(normalizeAgentName('x'.repeat(100))).toHaveLength(64);
  });

  it('ignores empty and non-string values', () => {
    expect(normalizeAgentName('   ')).toBeUndefined();
    expect(normalizeAgentName(42)).toBeUndefined();
    expect(normalizeAgentName(undefined)).toBeUndefined();
  });
});
