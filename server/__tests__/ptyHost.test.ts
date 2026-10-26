import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyHost } from '../src/terminal/ptyHost.js';
import { startPtyHost } from '../src/terminal/ptyHost.js';
import { encodeLine, LineDecoder, PTY_HOST_PROTOCOL } from '../src/terminal/ptyHostProtocol.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../src/terminal/ptyModule.js';
import { RemotePtySessions } from '../src/terminal/remotePtySessions.js';
import {
  launchStandaloneAgent,
  reattachTerminalAgents,
} from '../src/terminal/standaloneAgentLauncher.js';

/**
 * The PTY host (development only, `--pty-host`) over a real Unix socket: a host
 * in this process with a fake PTY module, and the server's client of it. What
 * it must guarantee is the reason it exists — a server going away leaves the
 * terminals running, and the next server gets them back, agents and all.
 */

class FakePty implements IPty {
  private static nextPid = 5000;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  constructor(readonly options: PtySpawnOptions) {}

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.exitListener?.({ exitCode: 0, signal: 1 }));
  }

  emit(data: string): void {
    this.dataListener?.(data);
  }
  exit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }
}

/** Resolves once `check` passes (socket traffic is asynchronous). */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('PTY host', () => {
  let dir: string;
  let socketPath: string;
  let host: PtyHost | null;
  let spawned: FakePty[];
  const clients: RemotePtySessions[] = [];

  async function startHost(): Promise<PtyHost> {
    const module: PtyModule = {
      spawn: (_file, _args, options) => {
        const pty = new FakePty(options);
        spawned.push(pty);
        return pty;
      },
    };
    host = await startPtyHost({
      socketPath,
      resolve: () => ({ module, moduleId: 'fake-pty', reason: null }),
    });
    return host;
  }

  async function connect(): Promise<RemotePtySessions> {
    const client = await RemotePtySessions.connect({ socketPath });
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    // Short: macOS caps a socket path at 104 bytes.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxh-'));
    socketPath = path.join(dir, 'h.sock');
    spawned = [];
    host = null;
    await startHost();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.shutdown();
    await host?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('spawns with exactly the env the server sends, and reports the pid', async () => {
    const client = await connect();
    const session = client.create({
      agentId: 3,
      command: 'claude',
      args: [],
      cwd: dir,
      env: { PIXEL_TEST_VAR: 'yes' },
    });
    expect(session.pid).toBeNull();
    await until(() => session.pid !== null);
    expect(session.pid).toBe(spawned[0].pid);
    expect(spawned[0].options.env.PIXEL_TEST_VAR).toBe('yes');
    expect(spawned[0].options.env.TERM).toBe('xterm-256color');
    // Nothing of the host's own env leaks in (a host may outlive many servers).
    expect(spawned[0].options.env.PATH).toBeUndefined();
    expect(spawned[0].options.cwd).toBe(dir);
  });

  it('streams numbered output, and replays the screen up to a number', async () => {
    const client = await connect();
    const session = client.create({ agentId: 1, command: 'claude', args: [], cwd: dir, env: {} });
    await until(() => spawned.length === 1);
    const seen: Array<[string, number]> = [];
    session.onData((chunk, seq) => seen.push([chunk, seq]));

    spawned[0].emit('hello ');
    spawned[0].emit('world');
    await until(() => seen.length === 2);
    expect(seen).toEqual([
      ['hello ', 1],
      ['world', 2],
    ]);

    const replay = await session.replay();
    expect(replay.data).toContain('hello world');
    expect(replay.seq).toBe(2);

    session.write('ls\r');
    session.resize(100, 30);
    await until(() => spawned[0].written.length === 1 && spawned[0].resizes.length === 1);
    expect(spawned[0].written).toEqual(['ls\r']);
    expect(spawned[0].resizes).toEqual([[100, 30]]);
  });

  it('keeps terminals running across a server disconnect, and hands them to the next one', async () => {
    const first = await connect();
    first.create({
      agentId: 7,
      command: 'claude',
      args: [],
      cwd: dir,
      env: {},
    });
    await until(() => spawned.length === 1);
    spawned[0].emit('before');
    await first.shutdown();
    clients.splice(clients.indexOf(first), 1);

    // Output while no server is connected still reaches the screen.
    spawned[0].emit(' during');
    expect(spawned[0].killed).toBe(false);

    const second = await connect();
    const [survivor] = second.survivors();
    expect(survivor.agentId).toBe(7);
    expect(second.has(7)).toBe(true);
    expect((await survivor.replay()).data).toContain('before during');

    const seen: string[] = [];
    survivor.onData((chunk) => seen.push(chunk));
    spawned[0].emit(' after');
    await until(() => seen.length === 1);
    expect(seen).toEqual([' after']);
  });

  it('kills on dispose, and an exit reaches the server and is forgotten by the host', async () => {
    const client = await connect();
    const a = client.create({ agentId: 1, command: 'claude', args: [], cwd: dir, env: {} });
    const b = client.create({ agentId: 2, command: 'claude', args: [], cwd: dir, env: {} });
    await until(() => spawned.length === 2);
    const exits: number[] = [];
    a.onExit(() => exits.push(1));
    b.onExit((e) => exits.push(e.exitCode));

    client.dispose(1);
    await until(() => spawned[0].killed);
    spawned[1].exit(3);
    await until(() => exits.includes(3));
    expect(client.has(2)).toBe(false);

    const next = await connect();
    expect(next.survivors()).toEqual([]);
  });

  it('ends every session when the host goes away', async () => {
    const client = await connect();
    const session = client.create({ agentId: 1, command: 'claude', args: [], cwd: dir, env: {} });
    await until(() => spawned.length === 1);
    const exits: number[] = [];
    session.onExit((e) => exits.push(e.exitCode));

    await host?.close();
    host = null;
    await until(() => exits.length === 1);
    expect(exits).toEqual([-1]);
    expect(client.isAvailable()).toBe(false);
    expect(client.unavailableReason()).toMatch(/PTY host stopped/);
  });

  it('tells a server speaking another protocol only its own, and nothing else', async () => {
    const client = await connect();
    client.create({ agentId: 1, command: 'claude', args: [], cwd: dir, env: {} });
    await until(() => spawned.length === 1);

    const raw = net.connect(socketPath);
    raw.setEncoding('utf8');
    const decoder = new LineDecoder();
    const got: Array<Record<string, unknown>> = [];
    raw.on('data', (chunk: string) => got.push(...(decoder.push(chunk) as never[])));
    raw.write(encodeLine({ t: 'hello', protocol: PTY_HOST_PROTOCOL + 1 }));
    raw.write(encodeLine({ t: 'kill', agentId: 1 }));
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ t: 'hello', protocol: PTY_HOST_PROTOCOL, sessions: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned[0].killed).toBe(false);
    raw.destroy();
  });

  it('refuses to start beside a live host on the same socket', async () => {
    await expect(startPtyHost({ socketPath })).rejects.toThrow(/already listening/);
  });

  describe('reattaching agents after a server restart', () => {
    let projectDir: string;
    const runtimes: AgentRuntime[] = [];

    function provider(): HookProvider {
      return { ...claudeProvider, getSessionDirs: () => [projectDir] };
    }

    function office(): { store: AgentStateStore; runtime: AgentRuntime; broadcasts: unknown[] } {
      const store = new AgentStateStore();
      store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      const runtime = new AgentRuntime(store, claudeProvider);
      runtimes.push(runtime);
      const broadcasts: unknown[] = [];
      store.on('broadcast', (m) => broadcasts.push(m));
      return { store, runtime, broadcasts };
    }

    beforeEach(() => {
      projectDir = path.join(dir, 'sessions');
      fs.mkdirSync(projectDir);
    });

    afterEach(() => {
      for (const runtime of runtimes.splice(0)) runtime.stop();
    });

    it('brings a running agent back with its id, look and Directory, reading from the transcript end', async () => {
      const before = office();
      const first = await connect();
      const id = launchStandaloneAgent(
        { store: before.store, runtime: before.runtime, ptyManager: first, provider: provider() },
        { directoryPath: dir, palette: 2 },
      );
      expect(id).toBe(1);
      const launched = before.store.get(1);
      await until(() => spawned.length === 1);
      fs.writeFileSync(launched!.jsonlFile, '{"type":"user"}\n');
      // A stopping server: disconnect, stop the runtime (which keeps the saved list).
      await first.shutdown();
      clients.splice(clients.indexOf(first), 1);
      before.runtime.stop();

      const after = office();
      const second = await connect();
      const restored = reattachTerminalAgents({
        store: after.store,
        runtime: after.runtime,
        ptyManager: second,
        provider: provider(),
      });

      expect(restored).toEqual([1]);
      const agent = after.store.get(1);
      expect(agent?.sessionId).toBe(launched?.sessionId);
      expect(agent?.palette).toBe(2);
      expect(agent?.directoryName).toBe(launched?.directoryName);
      expect(agent?.isExternal).toBe(false);
      expect(agent?.fileOffset).toBe(fs.statSync(launched!.jsonlFile).size);
      expect(after.store.nextAgentId.current).toBe(2);
      expect(after.broadcasts).toContainEqual({ type: 'terminalSessionOpened', agentId: 1 });
      expect(after.runtime.knownJsonlFiles.has(launched!.jsonlFile)).toBe(true);

      // Its process ending still closes it in the new office.
      spawned[0].exit(0);
      await until(() => !after.store.has(1));
    });

    it('finds a transcript the saved record misplaced (filed under the symlink-resolved Directory)', async () => {
      const before = office();
      const first = await connect();
      launchStandaloneAgent(
        { store: before.store, runtime: before.runtime, ptyManager: first, provider: provider() },
        { directoryPath: dir },
      );
      const launched = before.store.get(1)!;
      await until(() => spawned.length === 1);
      // The CLI filed it elsewhere under the session root, not where the record says.
      const resolvedDir = path.join(dir, 'resolved-sessions');
      fs.mkdirSync(resolvedDir);
      const actual = path.join(resolvedDir, path.basename(launched.jsonlFile));
      fs.writeFileSync(actual, '{"type":"user"}\n');
      await first.shutdown();
      clients.splice(clients.indexOf(first), 1);
      before.runtime.stop();

      const after = office();
      const second = await connect();
      reattachTerminalAgents({
        store: after.store,
        runtime: after.runtime,
        ptyManager: second,
        provider: { ...provider(), getAllSessionRoots: () => [dir] },
      });

      const agent = after.store.get(1);
      expect(agent?.jsonlFile).toBe(actual);
      expect(agent?.projectDir).toBe(resolvedDir);
      // Its past is history: read from the end, like any reattached transcript.
      expect(agent?.fileOffset).toBe(fs.statSync(actual).size);
      expect(after.runtime.knownJsonlFiles.has(actual)).toBe(true);
      spawned[0].exit(0);
      await until(() => !after.store.has(1));
    });

    it('checks saved background spawns against the transcript where it really is', async () => {
      const before = office();
      const first = await connect();
      launchStandaloneAgent(
        { store: before.store, runtime: before.runtime, ptyManager: first, provider: provider() },
        { directoryPath: dir },
      );
      const launched = before.store.get(1)!;
      await until(() => spawned.length === 1);
      await first.shutdown();
      clients.splice(clients.indexOf(first), 1);
      before.runtime.stop();
      // The record names a spawn; the transcript (filed elsewhere, where the
      // record doesn't say) holds its launch and, written while no server
      // ran, its completion notice.
      const adapter = new FileStateAdapter({ namespace: 'standalone' });
      adapter.saveAgents(
        adapter
          .loadAgents()
          .map((p) => ({ ...p, backgroundSpawns: [{ toolId: 'toolu_bg', taskId: 'a1b2' }] })),
      );
      const resolvedDir = path.join(dir, 'resolved-sessions');
      fs.mkdirSync(resolvedDir);
      const actual = path.join(resolvedDir, path.basename(launched.jsonlFile));
      fs.writeFileSync(
        actual,
        [
          JSON.stringify({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_bg',
                  content: 'Async agent launched successfully. agentId: a1b2',
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            content:
              '<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>',
          }),
          '',
        ].join('\n'),
      );

      const after = office();
      const second = await connect();
      reattachTerminalAgents({
        store: after.store,
        runtime: after.runtime,
        ptyManager: second,
        provider: { ...provider(), getAllSessionRoots: () => [dir] },
      });

      const agent = after.store.get(1);
      expect(agent?.jsonlFile).toBe(actual);
      expect(agent?.backgroundSpawns.size).toBe(0);
      spawned[0].exit(0);
      await until(() => !after.store.has(1));
    });

    it('leaves out a terminal with no saved record, and keeps its id from new launches', async () => {
      const before = office();
      const first = await connect();
      launchStandaloneAgent(
        { store: before.store, runtime: before.runtime, ptyManager: first, provider: provider() },
        { directoryPath: dir },
      );
      await until(() => spawned.length === 1);
      await first.shutdown();
      clients.splice(clients.indexOf(first), 1);
      new FileStateAdapter({ namespace: 'standalone' }).saveAgents([]);

      const after = office();
      const second = await connect();
      const restored = reattachTerminalAgents({
        store: after.store,
        runtime: after.runtime,
        ptyManager: second,
        provider: provider(),
      });
      expect(restored).toEqual([]);
      expect(after.store.has(1)).toBe(false);
      expect(after.store.nextAgentId.current).toBe(2);
    });
  });
});
