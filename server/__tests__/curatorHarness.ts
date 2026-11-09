import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CapabilityRegistry } from '../src/capabilities.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { CAPABILITY_ENV_NAME } from '../src/constants.js';
import { CuratorTable } from '../src/curators.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { launchStandaloneAgent } from '../src/terminal/standaloneAgentLauncher.js';
import { saveWorkspace } from '../src/workspaces.js';

/**
 * Shared harness for the capability and curator suites: a real store, runtime,
 * registry and curator table under a temp $HOME, and a fake PTY module that
 * records every spawn. An "eligible" agent is only ever made the production
 * way: launchStandaloneAgent with isKbEnabled injected.
 */

export class FakePty implements IPty {
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

export interface Spawned {
  file: string;
  args: string[];
  options: PtySpawnOptions;
  pty: FakePty;
}

export interface LaunchInput {
  directoryPath?: string;
  /** true/false, or a per-Workspace predicate. Undefined = not injected. */
  kb?: boolean | ((workspaceId: string) => boolean);
  /** Pass no registry at all (the launch must then issue nothing). */
  withoutRegistry?: boolean;
  provider?: Partial<HookProvider>;
  /** Launch with a Role (already validated by the caller in production). */
  role?: { name: string; roleId: string; snapshotPath: string };
}

export interface Launched {
  id: number | null;
  spawn: Spawned | undefined;
  token: string | undefined;
}

export class KbHarness {
  readonly tempHome: string;
  readonly projectDir: string;
  readonly store: AgentStateStore;
  readonly runtime: AgentRuntime;
  readonly manager: PtySessionManager;
  readonly capabilities: CapabilityRegistry;
  readonly curators: CuratorTable;
  readonly spawned: Spawned[] = [];
  readonly broadcasts: Array<Record<string, unknown>> = [];
  spawnShouldThrow = false;
  private readonly originalHome: string | undefined;

  constructor() {
    this.tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kb-')));
    this.originalHome = process.env.HOME;
    process.env.HOME = this.tempHome;
    this.projectDir = path.join(this.tempHome, 'project-sessions');
    fs.mkdirSync(this.projectDir, { recursive: true });

    this.store = new AgentStateStore();
    this.store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    const module: PtyModule = {
      spawn: (file, args, options) => {
        if (this.spawnShouldThrow) throw new Error('posix_spawnp failed');
        const pty = new FakePty();
        this.spawned.push({ file, args: [...args], options, pty });
        return pty;
      },
    };
    this.manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
    // Same order as cli.ts: the registry subscribes before anything else.
    this.capabilities = new CapabilityRegistry({ store: this.store, ptyManager: this.manager });
    this.curators = new CuratorTable({
      store: this.store,
      ptyManager: this.manager,
      broadcast: (message) => this.store.broadcast(message),
    });
    this.runtime = new AgentRuntime(this.store, claudeProvider);
    this.store.on('broadcast', (message) => this.broadcasts.push(message));
  }

  /** A Directory under $HOME owned by a new Workspace; returns both. */
  workspace(name: string): { id: string; dir: string } {
    const dir = path.join(this.tempHome, name);
    fs.mkdirSync(dir, { recursive: true });
    const result = saveWorkspace({ name, directoryPaths: [dir] });
    if (!result.ok || !result.id) throw new Error(`workspace ${name} not saved`);
    return { id: result.id, dir };
  }

  launch(input: LaunchInput = {}): Launched {
    const before = this.spawned.length;
    const kb = input.kb;
    const id = launchStandaloneAgent(
      {
        store: this.store,
        runtime: this.runtime,
        ptyManager: this.manager,
        provider: {
          ...claudeProvider,
          getSessionDirs: () => [this.projectDir],
          ...input.provider,
        },
        capabilities: input.withoutRegistry ? undefined : this.capabilities,
        isKbEnabled: kb === undefined ? undefined : typeof kb === 'function' ? kb : () => kb,
      },
      { directoryPath: input.directoryPath, role: input.role },
    );
    const spawn = this.spawned.length > before ? this.spawned[this.spawned.length - 1] : undefined;
    return { id, spawn, token: spawn?.options.env?.[CAPABILITY_ENV_NAME] };
  }

  ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return {
      store: this.store,
      cache: null,
      privileged: true,
      runtime: this.runtime,
      ptyManager: this.manager,
      capabilities: this.capabilities,
      curators: this.curators,
      isKbEnabled: () => true,
      ...overrides,
    };
  }

  /** Dispatch one client message; returns what was replied to the sender. */
  send(
    msg: Record<string, unknown>,
    context: ClientMessageContext = this.ctx(),
  ): Array<Record<string, unknown>> {
    const replies: Array<Record<string, unknown>> = [];
    handleClientMessage(msg, (m) => replies.push(m), context);
    return replies;
  }

  curatorBroadcasts(): Array<Record<string, unknown>> {
    return this.broadcasts.filter((m) => m.type === 'workspaceCuratorChanged');
  }

  dispose(): void {
    this.runtime.dispose();
    this.store.dispose();
    if (this.originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = this.originalHome;
    fs.rmSync(this.tempHome, { recursive: true, force: true });
  }
}
