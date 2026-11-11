import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CapabilityRegistry } from '../src/capabilities.js';
import { KEY_BYPASS_PERMISSIONS } from '../src/clientMessageHandler.js';
import { CAPABILITY_ENV_NAME } from '../src/constants.js';
import { CuratorTable } from '../src/curators.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { TaskDispatchLaunch } from '../src/taskDispatch/launchConfig.js';
import { TaskDispatcher } from '../src/taskDispatch/taskDispatcher.js';
import { OperatorInputTracker } from '../src/terminal/operatorInput.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { launchStandaloneAgent } from '../src/terminal/standaloneAgentLauncher.js';
import { createStoppedAgent, startStoppedAgent } from '../src/terminal/standaloneAgentRecords.js';
import { saveWorkspace } from '../src/workspaces.js';
import type { HookChainCheck } from '../src/writeGuard/guardStatus.js';
import { GuardStatusReporter } from '../src/writeGuard/guardStatusReporter.js';
import type { KbState } from '../src/writeGuard/kbState.js';
import type { PermissionRoles } from '../src/writeGuard/permissionRoles.js';

/**
 * Shared harness for the task-dispatch suites: a real store, runtime,
 * capability registry, curator table, guard-status reporter and PTY manager
 * (with its real headless mirror) under a temp $HOME. Only the PTY process is
 * fake: it records what is written to it and can emit output.
 */

export const DISPATCH_TEST_PORT = 43_210;
export const DISPATCH_TEST_SHIM = '/opt/pixel-agents/dist/hooks/pixel-agents-mcp.js';

/** Turn bracketed paste on / off, enter / leave the alternate screen. */
export const ENABLE_BRACKETED_PASTE = '\u001b[?2004h';
export const DISABLE_BRACKETED_PASTE = '\u001b[?2004l';
export const ENTER_ALT_SCREEN = '\u001b[?1049h';
export const LEAVE_ALT_SCREEN = '\u001b[?1049l';

export class RecordingPty implements IPty {
  readonly pid = 5151;
  readonly written: string[] = [];
  /** Optional hook run on every write (structure assertions). */
  onWrite: ((data: string) => void) | null = null;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written.push(data);
    this.onWrite?.(data);
  }
  resize(): void {}
  kill(): void {}

  /** Test driver: the process prints a chunk. */
  emit(data: string): void {
    this.dataListener?.(data);
  }
  /** Test driver: the process exits on its own. */
  exit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }
}

export interface Spawn {
  file: string;
  args: string[];
  options: PtySpawnOptions;
  pty: RecordingPty;
}

export interface DispatchLaunchInput {
  directoryPath?: string;
  bypassPermissions?: boolean;
  permissionRoles?: PermissionRoles;
  /** Omit the task-dispatch switch (a launch as before D1). */
  withoutSwitch?: boolean;
  provider?: Partial<HookProvider>;
  role?: { name: string; roleId: string; snapshotPath: string };
}

export class DispatchHarness {
  readonly tempHome: string;
  readonly projectDir: string;
  readonly store: AgentStateStore;
  readonly runtime: AgentRuntime;
  readonly manager: PtySessionManager;
  readonly capabilities: CapabilityRegistry;
  readonly curators: CuratorTable;
  readonly guardStatus: GuardStatusReporter;
  readonly operatorInput: OperatorInputTracker;
  readonly dispatcher: TaskDispatcher;
  readonly spawned: Spawn[] = [];
  readonly audit: string[] = [];
  readonly broadcasts: Array<Record<string, unknown>> = [];
  readonly seenVerdicts = new Set<string>();
  chain: HookChainCheck = { hooksInstalled: true, preToolUsePresent: true, scriptPresent: true };
  readonly launchSwitch: TaskDispatchLaunch = {
    port: DISPATCH_TEST_PORT,
    shimPath: DISPATCH_TEST_SHIM,
  };
  nowMs = 1_000_000;
  /** Agent id -> the spawn of its current PTY session. */
  private readonly spawnOf = new Map<number, Spawn>();
  private readonly originalHome: string | undefined;

  constructor() {
    this.tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-dispatch-')));
    this.originalHome = process.env.HOME;
    process.env.HOME = this.tempHome;
    this.projectDir = path.join(this.tempHome, 'project-sessions');
    fs.mkdirSync(this.projectDir, { recursive: true });

    this.store = new AgentStateStore();
    this.store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    const module: PtyModule = {
      spawn: (file, args, options) => {
        const pty = new RecordingPty();
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
    this.guardStatus = new GuardStatusReporter({
      store: this.store,
      ptyManager: this.manager,
      guard: {
        hasSeenVerdict: (sessionId) => this.seenVerdicts.has(sessionId),
        onFirstVerdict: () => () => {},
        getKbState: () => ({ agents: new Map() }) as unknown as KbState,
      },
      curators: this.curators,
      probeChain: () => this.chain,
      broadcast: () => {},
    });
    this.operatorInput = new OperatorInputTracker(() => this.nowMs);
    this.dispatcher = new TaskDispatcher({
      store: this.store,
      ptyManager: this.manager,
      capabilities: this.capabilities,
      curators: this.curators,
      guard: this.guardStatus,
      operatorInput: this.operatorInput,
      hostBypassEnabled: () =>
        this.store.getAdapter()?.getSetting(KEY_BYPASS_PERMISSIONS, false) !== false,
      now: () => this.nowMs,
      audit: (line) => this.audit.push(line),
    });
    this.store.on('broadcast', (message) => this.broadcasts.push(message));
  }

  /** A Directory under $HOME owned by a new Workspace. */
  workspace(name: string): { id: string; dir: string } {
    const dir = path.join(this.tempHome, name);
    fs.mkdirSync(dir, { recursive: true });
    const result = saveWorkspace({ name, directoryPaths: [dir] });
    if (!result.ok || !result.id) throw new Error(`workspace ${name} not saved`);
    return { id: result.id, dir };
  }

  private launchDeps(input: DispatchLaunchInput) {
    return {
      store: this.store,
      runtime: this.runtime,
      ptyManager: this.manager,
      provider: {
        ...claudeProvider,
        getSessionDirs: () => [this.projectDir],
        ...input.provider,
      } as HookProvider,
      capabilities: this.capabilities,
      taskDispatch: input.withoutSwitch ? undefined : this.launchSwitch,
    };
  }

  /** Launch through the production launcher; returns the id and its spawn. */
  launch(input: DispatchLaunchInput = {}): { id: number; spawn: Spawn; token?: string } {
    const before = this.spawned.length;
    const id = launchStandaloneAgent(this.launchDeps(input), {
      directoryPath: input.directoryPath,
      bypassPermissions: input.bypassPermissions,
      role: input.role,
      ...(input.permissionRoles !== undefined ? { permissionRoles: input.permissionRoles } : {}),
    });
    if (id === null || this.spawned.length === before) throw new Error('launch failed');
    const spawn = this.spawned[this.spawned.length - 1];
    this.spawnOf.set(id, spawn);
    return { id, spawn, token: spawn.options.env?.[CAPABILITY_ENV_NAME] };
  }

  /** A stopped record, then started through the production path. */
  createAndStart(
    directoryPath: string,
    input: DispatchLaunchInput & { beforeStart?: (id: number) => void } = {},
  ): { id: number; spawn: Spawn; token?: string } {
    const id = createStoppedAgent(
      { store: this.store, provider: this.launchDeps(input).provider },
      { directoryPath },
    );
    if (id === null) throw new Error('create failed');
    input.beforeStart?.(id);
    const before = this.spawned.length;
    const started = startStoppedAgent(this.launchDeps(input), id, {
      bypassPermissions: input.bypassPermissions,
    });
    if (!started || this.spawned.length === before) throw new Error('start failed');
    const spawn = this.spawned[this.spawned.length - 1];
    this.spawnOf.set(id, spawn);
    return { id, spawn, token: spawn.options.env?.[CAPABILITY_ENV_NAME] };
  }

  /** The PTY of an agent's live session (its newest spawn). */
  ptyOf(id: number): RecordingPty {
    const spawn = this.spawnOf.get(id);
    if (!spawn || !this.manager.has(id)) throw new Error(`no pty for agent ${id}`);
    return spawn.pty;
  }

  /** Make an agent dispatchable: bracketed paste on, guard verdict seen, one
   *  completed turn (a real Stop hook through the runtime). */
  makeReady(id: number): void {
    const agent = this.store.get(id);
    if (!agent) throw new Error(`no agent ${id}`);
    this.ptyOf(id).emit(ENABLE_BRACKETED_PASTE);
    this.seenVerdicts.add(agent.sessionId);
    this.completeTurn(id);
  }

  /** A real Stop hook for the agent's session (a turn completed). */
  completeTurn(id: number): void {
    const agent = this.store.get(id);
    if (!agent) throw new Error(`no agent ${id}`);
    this.runtime.handleHookEvent('claude', {
      session_id: agent.sessionId,
      hook_event_name: 'Stop',
    });
  }

  setHostBypass(enabled: boolean): void {
    this.store.getAdapter()?.setSetting(KEY_BYPASS_PERMISSIONS, enabled);
  }

  lastAuditOutcome(): string | undefined {
    const line = this.audit[this.audit.length - 1];
    return line?.match(/outcome=(\S+)/)?.[1];
  }

  dispose(): void {
    this.dispatcher.dispose();
    this.guardStatus.dispose();
    this.runtime.dispose();
    this.store.dispose();
    if (this.originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = this.originalHome;
    fs.rmSync(this.tempHome, { recursive: true, force: true });
  }
}
