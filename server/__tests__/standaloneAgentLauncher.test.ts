import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { JSONL_POLL_INTERVAL_MS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { launchStandaloneAgent } from '../src/terminal/standaloneAgentLauncher.js';

/**
 * launchStandaloneAgent is the standalone counterpart of the VS Code adapter's
 * launchNewTerminal: it must register a store agent, spawn the provider's
 * launch command in a PTY, and clean everything up when that process exits.
 * These tests drive it with a REAL AgentRuntime + AgentStateStore (the launcher
 * mutates runtime maps directly, so faking them would just restate the
 * implementation) and a fake PTY module (spawning real processes would be slow
 * and platform-dependent -- see ptySessionManager.test.ts).
 */

class FakePty implements IPty {
  readonly pid = 4242;
  killSignals: Array<string | undefined> = [];
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  onData(): void {}
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.killSignals.push(signal);
  }

  /** Test driver: simulate the process exiting on its own. */
  exit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }
}

interface PtyHarness {
  manager: PtySessionManager;
  spawned: FakePty[];
  spawnArgs: Array<{ file: string; args: string[]; options: PtySpawnOptions }>;
}

function workingPtyManager(): PtyHarness {
  const spawned: FakePty[] = [];
  const spawnArgs: PtyHarness['spawnArgs'] = [];
  const module: PtyModule = {
    spawn: (file, args, options) => {
      spawnArgs.push({ file, args, options });
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
  };
  const manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
  return { manager, spawned, spawnArgs };
}

describe('launchStandaloneAgent', () => {
  let tempDir: string;
  let projectDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let broadcasts: Array<Record<string, unknown>>;

  /** Real Claude provider with only the session-dir lookup redirected into the
   *  test's temp dir, so buildLaunchCommand stays the production one and the
   *  test asserts the actual launched command shape. */
  function provider(overrides: Partial<HookProvider> = {}): HookProvider {
    return { ...claudeProvider, getSessionDirs: () => [projectDir], ...overrides };
  }

  function launch(harness: PtyHarness, options = {}): number | null {
    return launchStandaloneAgent(
      { store, runtime, ptyManager: harness.manager, provider: provider() },
      options,
    );
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launcher-test-'));
    projectDir = path.join(tempDir, 'project-sessions');
    fs.mkdirSync(projectDir, { recursive: true });
    store = new AgentStateStore();
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

  // ── Successful launch ────────────────────────────────────────

  it('spawns the provider launch command in a PTY and registers the agent', () => {
    const harness = workingPtyManager();
    const cwd = path.join(tempDir, 'workspace');
    fs.mkdirSync(cwd);

    const id = launch(harness, { folderPath: cwd });

    expect(id).toBe(1);
    const agent = store.get(1);
    expect(agent).toBeDefined();
    expect(agent?.isExternal).toBe(false);
    expect(agent?.projectDir).toBe(projectDir);
    expect(agent?.providerId).toBe(claudeProvider.id);
    expect(agent?.jsonlFile).toBe(path.join(projectDir, `${agent?.sessionId}.jsonl`));

    // The real claude launch command, spawned in the requested cwd.
    expect(harness.spawnArgs).toHaveLength(1);
    expect(harness.spawnArgs[0].file).toBe('claude');
    expect(harness.spawnArgs[0].args).toEqual(['--session-id', agent?.sessionId]);
    expect(harness.spawnArgs[0].options.cwd).toBe(cwd);
    expect(harness.manager.has(1)).toBe(true);

    // Pre-registered so the project scanner won't mistake the new JSONL for /clear.
    expect(runtime.knownJsonlFiles.has(agent!.jsonlFile)).toBe(true);
    expect(runtime.activeAgentId.current).toBe(1);

    // The UI learns a terminal exists so the drawer opens a tab.
    expect(broadcasts).toContainEqual({ type: 'terminalSessionOpened', agentId: 1 });
  });

  it('passes bypassPermissions through to the launch command', () => {
    const harness = workingPtyManager();

    launch(harness, { bypassPermissions: true });

    expect(harness.spawnArgs[0].args).toContain('--dangerously-skip-permissions');
  });

  // ── Refusal paths (each must leave the store and id counter untouched) ──

  it('returns null without burning an agent id when the terminal is unavailable', () => {
    const manager = PtySessionManager.disabled('no terminal in this test');

    const id = launchStandaloneAgent({ store, runtime, ptyManager: manager, provider: provider() });

    expect(id).toBeNull();
    expect(store.size).toBe(0);
    expect(store.nextAgentId.current).toBe(1);
    expect(broadcasts).toHaveLength(0);
  });

  it('returns null when the provider cannot build a launch command', () => {
    const harness = workingPtyManager();

    const id = launchStandaloneAgent(
      {
        store,
        runtime,
        ptyManager: harness.manager,
        provider: provider({ buildLaunchCommand: undefined }),
      },
      {},
    );

    expect(id).toBeNull();
    expect(store.size).toBe(0);
    expect(harness.spawnArgs).toHaveLength(0);
  });

  it('returns null when the provider returns no session dirs', () => {
    const harness = workingPtyManager();

    const id = launchStandaloneAgent(
      {
        store,
        runtime,
        ptyManager: harness.manager,
        provider: provider({ getSessionDirs: () => [] }),
      },
      {},
    );

    expect(id).toBeNull();
    expect(store.size).toBe(0);
    expect(harness.spawnArgs).toHaveLength(0);
  });

  it('rolls back the agent id when the PTY spawn throws', () => {
    const module: PtyModule = {
      spawn: () => {
        throw new Error('posix_spawnp failed');
      },
    };
    const manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));

    const id = launchStandaloneAgent({ store, runtime, ptyManager: manager, provider: provider() });

    expect(id).toBeNull();
    expect(store.size).toBe(0);
    expect(store.nextAgentId.current).toBe(1);
  });

  // ── Process exit cleanup ─────────────────────────────────────

  it('removes the agent and announces the close when the process exits', () => {
    const harness = workingPtyManager();
    const id = launch(harness)!;

    harness.spawned[0].exit(3);

    expect(broadcasts).toContainEqual({ type: 'terminalSessionClosed', agentId: id, exitCode: 3 });
    expect(store.has(id)).toBe(false);
    expect(harness.manager.has(id)).toBe(false);
  });

  // ── JSONL adoption poll ──────────────────────────────────────

  it('starts watching the session JSONL once it appears', () => {
    vi.useFakeTimers();
    const harness = workingPtyManager();
    const id = launch(harness)!;
    const agent = store.get(id)!;

    // File not there yet: the poll stays armed.
    vi.advanceTimersByTime(JSONL_POLL_INTERVAL_MS);
    expect(runtime.jsonlPollTimers.has(id)).toBe(true);

    fs.writeFileSync(agent.jsonlFile, '');
    vi.advanceTimersByTime(JSONL_POLL_INTERVAL_MS);

    expect(runtime.jsonlPollTimers.has(id)).toBe(false);
    expect(runtime.pollingTimers.has(id)).toBe(true);
  });

  it('does not adopt the JSONL of an agent that was closed while polling', () => {
    vi.useFakeTimers();
    const harness = workingPtyManager();
    const id = launch(harness)!;
    const agent = store.get(id)!;

    runtime.removeAgent(id);
    fs.writeFileSync(agent.jsonlFile, '');
    vi.advanceTimersByTime(JSONL_POLL_INTERVAL_MS);

    expect(runtime.jsonlPollTimers.has(id)).toBe(false);
    expect(runtime.pollingTimers.has(id)).toBe(false);
  });
});
