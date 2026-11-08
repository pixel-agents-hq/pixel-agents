import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { writeRoleSnapshot } from '../src/roleStorage.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { launchStandaloneAgent } from '../src/terminal/standaloneAgentLauncher.js';

/**
 * A launch that owns a Role snapshot must delete it on every path that ends
 * without a running agent. Each case below is one such path in
 * launchStandaloneAgent; the spawn-failure path is covered end to end in
 * roleClientMessages.test.ts.
 */
describe('launchStandaloneAgent with a Role snapshot', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let snapshotPath: string;

  const workingManager = () =>
    new PtySessionManager(() => ({
      module: {
        spawn: () => {
          throw new Error('spawn must not be reached');
        },
      },
      moduleId: 'fake-pty',
      reason: null,
    }));

  const launchWithSnapshot = (manager: PtySessionManager, provider = claudeProvider) =>
    launchStandaloneAgent(
      { store, runtime, ptyManager: manager, provider },
      { directoryPath: tempHome, role: { name: 'frontend', snapshotPath } },
    );

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-role-clean-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    snapshotPath = await writeRoleSnapshot(Buffer.from('# rules\n'));
    expect(fs.existsSync(snapshotPath)).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runtime.dispose();
    store.dispose();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function expectReleased(): void {
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(store.size).toBe(0);
    expect(store.nextAgentId.current).toBe(1);
  }

  it('removes the snapshot when the terminal is unavailable', () => {
    expect(launchWithSnapshot(PtySessionManager.disabled('no pty here'))).toBeNull();
    expectReleased();
  });

  it('removes the snapshot when the provider has no launch command', () => {
    const provider = { ...claudeProvider, buildLaunchCommand: undefined };
    expect(launchWithSnapshot(workingManager(), provider)).toBeNull();
    expectReleased();
  });

  it('removes the snapshot, then rethrows, when session dirs cannot be resolved', () => {
    const provider = {
      ...claudeProvider,
      getSessionDirs: () => {
        throw new Error('no home');
      },
    };
    expect(() => launchWithSnapshot(workingManager(), provider as typeof claudeProvider)).toThrow(
      'no home',
    );
    expectReleased();
  });

  it('removes the snapshot when the provider returns no session dirs', () => {
    const provider = { ...claudeProvider, getSessionDirs: () => [] };
    expect(launchWithSnapshot(workingManager(), provider as typeof claudeProvider)).toBeNull();
    expectReleased();
  });
});
