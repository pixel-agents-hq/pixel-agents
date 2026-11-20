/**
 * The Pixel Office MCP test harness: the ONE place the officeMcp*.test.ts
 * suites learn how an office with the MCP is composed (store, runtime,
 * terminals, the MCP, the server) and how its outside is driven — an office
 * on /ws, a launch from its drawer, mock-claude's logs, an agent's MCP client
 * with the token its config file holds, the agent's hook events.
 *
 * `useStandaloneOffice` / `useVscodeOffice` are called inside a `describe`:
 * they register the suite's beforeEach/afterEach and return a handle whose
 * fields are the current test's (read them inside tests, never at collection).
 * A suite's own afterEach runs before the harness's teardown (hooks unwind).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect } from 'vitest';
import { WebSocket } from 'ws';

import { createVscodeOfficeMcp } from '../../../adapters/vscode/vscodeOfficeMcp.js';
import type { CatalogSource } from '../../../core/src/layout/index.js';
import type { OfficeMcpChoice } from '../../../core/src/messages.js';
import type { HookProvider } from '../../../core/src/provider.js';
import type { TerminalHandle } from '../../../core/src/terminalAdapter.js';
import { AgentRuntime } from '../../src/agentRuntime.js';
import { AgentStateStore } from '../../src/agentStateStore.js';
import {
  loadCarpetTiles,
  type LoadedAssets,
  type LoadedPetSprites,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
} from '../../src/assetLoader.js';
import { watchCharacterProfiles } from '../../src/characterProfilesPersistence.js';
import { sharedCharacterRefsMessages } from '../../src/clientMessageHandler.js';
import { readConfig, writeConfig } from '../../src/configPersistence.js';
import {
  listDirectoryLocations,
  shownHostDirectories,
  userDirectoryDefaults,
} from '../../src/directories.js';
import { FileStateAdapter } from '../../src/fileStateAdapter.js';
import type { JsonFileWatcher } from '../../src/jsonFileWatcher.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../src/layoutPersistence.js';
import { composeOfficeMcp, type OfficeMcpFeature } from '../../src/mcp/composeOfficeMcp.js';
import { screenTokenGuard } from '../../src/mcp/messaging.js';
import type { AgentMcpAccess } from '../../src/mcp/officeMcp.js';
import type { AgentLaunch, OfficeOperations } from '../../src/mcp/officeOperations.js';
import type { OfficeTool } from '../../src/mcp/tool.js';
import type { OfficePlaceFacts } from '../../src/officeFacts.js';
import { claudeProvider, hookProviders } from '../../src/providers/index.js';
import { PixelAgentsServer } from '../../src/server.js';
import { ptyAgentTerminals } from '../../src/terminal/agentTerminals.js';
import { type ForegroundProbe, StandalonePcShells } from '../../src/terminal/pcShells.js';
import { type PtyHost, startPtyHost } from '../../src/terminal/ptyHost.js';
import { PtySessionManager } from '../../src/terminal/ptySessionManager.js';
import { RemotePtySessions } from '../../src/terminal/remotePtySessions.js';
import { reattachTerminalAgents } from '../../src/terminal/standaloneAgentLauncher.js';
import { closeStandaloneAgent } from '../../src/terminal/standaloneClose.js';
import { launchForOffice } from '../../src/terminal/standaloneLaunches.js';
import { standaloneTutorialSurface } from '../../src/terminal/standaloneTutorial.js';
import type { TerminalSessions } from '../../src/terminal/terminalSessions.js';
import { holdWorktreesOf } from '../../src/worktreeLeave.js';
import { removeTempDir } from './removeTempDir.js';

export type Json = Record<string, any>;
export type Message = Record<string, unknown>;

export const MOCK_CLAUDE = path.join(__dirname, '../../../e2e/fixtures/mock-claude');
export const BUNDLED = path.join(__dirname, '../../../webview-ui/public');

export async function waitFor<T>(
  read: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  what: string,
  timeoutMs = 15_000,
  pollMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ── Bundled assets ──────────────────────────────────────────

export interface OfficeAssetCounts {
  floorPatterns: number;
  wallSets: number;
  carpets: number;
}

/** The bundled furniture, pets and tile counts, as the office loads them. */
export async function loadBundledAssets(): Promise<{
  furniture: LoadedAssets;
  pets: LoadedPetSprites;
  counts: OfficeAssetCounts;
}> {
  return {
    furniture: (await loadFurnitureAssets(BUNDLED))!,
    pets: (await loadPetSprites(BUNDLED))!,
    counts: {
      floorPatterns: (await loadFloorTiles(BUNDLED))!.sprites.length,
      wallSets: (await loadWallTiles(BUNDLED))!.sets.length,
      carpets: (await loadCarpetTiles(BUNDLED))!.sets.length,
    },
  };
}

// ── The agent's side (any surface) ──────────────────────────

/** A tool's reply: its JSON value, or its error text. */
export interface ToolReply {
  isError: boolean;
  value: Json | null;
  text: string;
  /** The images after the JSON (MCP image content), in order. */
  images: Array<{ data: string; mimeType: string }>;
}

export interface AgentSide {
  /** An MCP client on /mcp with an agent's token. */
  mcpClient(token: string, name?: string): Promise<Client>;
  /** A tool call; a thrown protocol error fails the caller. */
  callTool(client: Client, name: string, args?: Message): Promise<ToolReply>;
  /** A tool call; a thrown protocol error comes back as an error reply. */
  callToolCaught(client: Client, name: string, args?: Message): Promise<ToolReply>;
  /** A tool call's JSON value, or `{ error: text }`. */
  callJson(client: Client, name: string, args?: Json): Promise<Json>;
  /** list_agents' agents (asserted not an error). */
  listAgents(client: Client): Promise<Json[]>;
  /** send_message (gist "hello" unless given) — its per-recipient results. */
  sendMessage(client: Client, args: Message): Promise<Json[]>;
  /** A hook event from the agent's CLI session, as its hook script posts it. */
  hook(id: number, event: Message): Promise<void>;
}

interface AgentSideContext {
  port: number;
  token: string;
  store: AgentStateStore;
  workspace: string;
  clients: Client[];
}

function agentSide(ctx: () => AgentSideContext): AgentSide {
  const side: AgentSide = {
    async mcpClient(token, name = 'test-agent') {
      const client = new Client({ name, version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx().port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      ctx().clients.push(client);
      return client;
    },
    async callTool(client, name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      const text = content[0]?.text ?? '';
      const images = content
        .filter((c) => c.type === 'image')
        .map((c) => ({ data: c.data!, mimeType: c.mimeType! }));
      if (result.isError) return { isError: true, value: null, text, images };
      return { isError: false, value: JSON.parse(text) as Json, text, images };
    },
    async callToolCaught(client, name, args = {}) {
      try {
        return await side.callTool(client, name, args);
      } catch (err) {
        return { isError: true, value: null, text: String(err), images: [] };
      }
    },
    async callJson(client, name, args = {}) {
      const reply = await side.callTool(client, name, args);
      return reply.isError ? { error: reply.text } : reply.value!;
    },
    async listAgents(client) {
      const reply = await side.callTool(client, 'list_agents', {});
      expect(reply.isError, reply.text).toBe(false);
      return (reply.value as { agents: Json[] }).agents;
    },
    async sendMessage(client, args) {
      const reply = await side.callToolCaught(client, 'send_message', { gist: 'hello', ...args });
      expect(reply.isError, reply.text).toBe(false);
      return (reply.value as { results: Json[] }).results;
    },
    async hook(id, event) {
      const { port, token, store, workspace } = ctx();
      const res = await fetch(`http://127.0.0.1:${port}/api/hooks/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: store.get(id)!.sessionId, cwd: workspace, ...event }),
      });
      expect(res.status).toBe(200);
    },
  };
  return side;
}

// ── Temp HOME, workspace, env ───────────────────────────────

/** A fresh HOME and a workspace named `proj` (a launch into it is an agent of
 *  the Directory `proj`); `env` set on top, everything restored after. */
function useTempHome(
  name: string,
  env: Record<string, string>,
  prepare: (dirs: { home: string; workspace: string }) => void,
): { home: () => string; workspace: () => string } {
  let home = '';
  let workspace = '';
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ['HOME', 'PATH', ...Object.keys(env)]) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    process.env.HOME = home;
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    workspace = path.join(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-ws-`))),
      'proj',
    );
    fs.mkdirSync(workspace);
    prepare({ home, workspace });
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempDir(home);
    removeTempDir(path.dirname(workspace));
  });
  return { home: () => home, workspace: () => workspace };
}

// ── Standalone ──────────────────────────────────────────────

export interface StandaloneOfficeOptions {
  /** Temp dir prefix. */
  name?: string;
  /** Extra env for the test (e.g. PIXEL_AGENTS_MOCK_STDIN). */
  env?: Record<string, string>;
  /** Runs with HOME and the workspace made, before the office boots. */
  prepare?: (dirs: { home: string; workspace: string }) => void;
  /** What the office reads as its layout: a function, or 'file' (layout.json). Default: none. */
  layout?: 'file' | (() => Record<string, unknown> | null);
  /** The furniture catalogue the office reads. Default: none. */
  catalog?: () => readonly CatalogSource[];
  /** The loaded asset counts and pets (get_layout's / list_catalog's). */
  assets?: () => OfficeAssetCounts & { pets: LoadedPetSprites['manifests'] };
  /** launch_agent launches standalone agents (else it isn't offered). */
  launch?: boolean;
  /** close_agent closes standalone agents (else it isn't offered). */
  close?: boolean;
  /** The tutorial can be started (the Guide launched into `proj`, as cli.ts composes it). */
  tutorial?: boolean;
  /** Worktrees are held while their agents live (as cli.ts holds them). */
  holdWorktrees?: boolean;
  /** The MCP's tool table (default: every tool). */
  tools?: readonly OfficeTool[];
  /** Hook events posted to the server reach the runtime. */
  forwardHooks?: boolean;
  /** After the handshake, the office answers the MCP ask with allow. */
  grant?: boolean;
  /** The CLI the MCP writes agents' config files for, and the tutorial's
   *  Guide is launched with. Default: Claude's. */
  provider?: HookProvider;
  /** The office runs no terminals (`--no-terminal`). */
  noTerminal?: boolean;
  /** What the PC shells' × sees running (default: the real `ps` probe). */
  foreground?: ForegroundProbe;
  /** The terminals live in a PTY host (`--pty-host`, real PTYs, its socket in
   *  the test's HOME) that outlives `restart()`; the test ends it. */
  ptyHost?: boolean;
}

export interface Launched {
  id: number;
  sessionId: string;
  /** The invocations.log line mock-claude wrote. */
  line: string;
  /** The CLI's args, as logged. */
  args: string;
}

export interface StandaloneOffice extends AgentSide {
  readonly home: string;
  readonly workspace: string;
  readonly store: AgentStateStore;
  readonly runtime: AgentRuntime;
  /** The in-process terminals (throws under `ptyHost`: use `terminals`). */
  readonly ptyManager: PtySessionManager;
  /** The terminals, in process or the PTY host's client. */
  readonly terminals: TerminalSessions;
  /** The PC shells, composed as cli.ts composes them over the test's layout and catalogue. */
  readonly pcShells: StandalonePcShells;
  readonly office: OfficeOperations;
  readonly officeMcp: OfficeMcpFeature;
  readonly server: PixelAgentsServer;
  readonly port: number;
  /** The server token (privileged offices and hook posts carry it). */
  readonly token: string;
  /** The first office's socket and everything it was sent. */
  readonly socket: WebSocket;
  readonly received: Json[];

  /**
   * Stop the server as cli.ts's shutdown does (in process: its terminals
   * killed; with the PTY host: disconnected, the terminals left running), run
   * `meanwhile`, then start a new one on the same HOME as cli.ts starts it
   * (agents and PC shells reattached) and connect a first office to it.
   */
  restart(meanwhile?: () => Promise<void> | void): Promise<void>;
  /** Another office on /ws, handshake done (privileged unless told not). */
  connectOffice(opts?: { privileged?: boolean }): Promise<{ socket: WebSocket; received: Json[] }>;
  /** A message from the first office (or the given socket). */
  send(message: Message, ws?: WebSocket): void;
  /** The office's answer to the MCP ask, once the status comes back. */
  answer(choice: OfficeMcpChoice): Promise<void>;
  /** What `claude` on the PATH runs from now on. */
  useClaude(script: string): void;
  /** mock-claude's invocations.log lines. */
  invocations(): string[];
  /** Every mock-claude start, its argv exactly (argv.log). */
  starts(): Array<{ sessionId: string; cwd: string; args: string[] }>;
  /** The chunks typed into a session's terminal, as the mock read them. */
  typedInto(sessionId: string): string[];
  /** Launch from the office's drawer (into a new Worktree of `repo` when
   *  given) and wait for the CLI to start. */
  launchFromOffice(opts?: { repo?: string }): Promise<Launched>;
  /** The --mcp-config path in a launch's args, or null. */
  mcpConfigPath(args: string): string | null;
  /** The agent token an MCP config file holds. */
  tokenIn(configPath: string): string;
  /** An MCP client as a launched agent (its config file's token). */
  connectAs(launched: Launched, clientName?: string): Promise<Client>;
  /** Launch from the office and connect as the agent. */
  launchAgent(opts?: {
    repo?: string;
    clientName?: (id: number) => string;
  }): Promise<Launched & { client: Client }>;
  /** read_agent_terminal (asserted not an error). */
  readTerminal(
    client: Client,
    agentId?: number,
  ): Promise<{ status: string; screen: string; screen_token: string; agent_id: number }>;
  /** A screen the mock is done drawing (its scenario ended), and its token. */
  settled(client: Client, agentId: number): Promise<{ screen: string; token: string }>;
}

export function useStandaloneOffice(options: StandaloneOfficeOptions = {}): StandaloneOffice {
  const dirs = useTempHome(options.name ?? 'pxl-office-mcp', options.env ?? {}, (d) => {
    // mock-claude first on PATH (before the server tests' real-claude guard).
    const bin = path.join(d.home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${MOCK_CLAUDE}" "$@"\n`, {
      mode: 0o755,
    });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
    options.prepare?.(d);
  });

  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let ptyManager: TerminalSessions;
  let ptyHost: PtyHost | null = null;
  let pcShells: StandalonePcShells;
  let officeMcp: OfficeMcpFeature;
  let server: PixelAgentsServer;
  let unhold: (() => void) | undefined;
  let profilesWatcher: JsonFileWatcher;
  let port: number;
  let token: string;
  let socket: WebSocket;
  let received: Json[];
  let clients: Client[] = [];
  let sockets: WebSocket[] = [];

  const side = agentSide(() => ({ port, token, store, workspace: dirs.workspace(), clients }));
  const mockLog = (file: string): string[] => {
    try {
      return fs
        .readFileSync(path.join(dirs.home(), '.claude-mock', file), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const h: StandaloneOffice = {
    ...side,
    get home() {
      return dirs.home();
    },
    get workspace() {
      return dirs.workspace();
    },
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    get ptyManager() {
      if (!(ptyManager instanceof PtySessionManager)) {
        throw new Error('ptyManager is the in-process manager: use terminals under ptyHost');
      }
      return ptyManager;
    },
    get terminals() {
      return ptyManager;
    },
    get pcShells() {
      return pcShells;
    },
    get office() {
      return officeMcp.office;
    },
    get officeMcp() {
      return officeMcp;
    },
    get server() {
      return server;
    },
    get port() {
      return port;
    },
    get token() {
      return token;
    },
    get socket() {
      return socket;
    },
    get received() {
      return received;
    },

    async restart(meanwhile) {
      await stop();
      await meanwhile?.();
      await boot();
    },
    async connectOffice({ privileged = true } = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${privileged ? `?token=${token}` : ''}`);
      sockets.push(ws);
      const messages: Json[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(String(data)) as Json));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ type: 'webviewReady' }));
      await waitFor(() => messages.some((m) => m.type === 'layoutLoaded'), 'the handshake');
      return { socket: ws, received: messages };
    },
    send(message, ws = socket) {
      ws.send(JSON.stringify(message));
    },
    async answer(choice) {
      const before = received.length;
      h.send({ type: 'officeMcpConsentResponse', choice });
      await waitFor(
        () => received.slice(before).some((m) => m.type === 'officeMcpStatus'),
        'the answer',
      );
    },
    useClaude(script) {
      fs.writeFileSync(path.join(dirs.home(), 'bin', 'claude'), script, { mode: 0o755 });
    },
    invocations: () => mockLog('invocations.log'),
    starts: () =>
      mockLog('argv.log').map(
        (line) => JSON.parse(line) as { sessionId: string; cwd: string; args: string[] },
      ),
    typedInto: (sessionId) =>
      mockLog(`stdin-${sessionId}.log`).map((line) => JSON.parse(line) as string),
    async launchFromOffice({ repo } = {}) {
      const ids = new Set(store.keys());
      const before = h.invocations().length;
      h.send(
        repo
          ? { type: 'launchAgent', directoryPath: repo, worktree: true }
          : { type: 'launchAgent', directoryPath: dirs.workspace() },
      );
      const line = await waitFor(() => h.invocations()[before], 'mock-claude to start');
      const id = [...store.keys()].find((k) => !ids.has(k));
      if (id === undefined) throw new Error('no agent joined');
      return {
        id,
        line,
        sessionId: /session-id=(\S+)/.exec(line)?.[1] ?? '',
        args: line.slice(line.indexOf('args=') + 5),
      };
    },
    mcpConfigPath(args) {
      const match = /--mcp-config (\S+)/.exec(args);
      return match ? match[1] : null;
    },
    tokenIn(configPath) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, { headers: { Authorization: string } }>;
      };
      return config.mcpServers['pixel-office'].headers.Authorization.slice('Bearer '.length);
    },
    connectAs(launched, clientName) {
      return side.mcpClient(h.tokenIn(h.mcpConfigPath(launched.line)!), clientName);
    },
    async launchAgent({ repo, clientName } = {}) {
      const launched = await h.launchFromOffice({ repo });
      const client = await h.connectAs(launched, clientName?.(launched.id));
      return { ...launched, client };
    },
    async readTerminal(client, agentId) {
      const reply = await side.callToolCaught(
        client,
        'read_agent_terminal',
        agentId === undefined ? {} : { agent_id: agentId },
      );
      expect(reply.isError, reply.text).toBe(false);
      return reply.value as {
        status: string;
        screen: string;
        screen_token: string;
        agent_id: number;
      };
    },
    async settled(client, agentId) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { screen, screen_token } = await h.readTerminal(client, agentId);
        if (screen.includes('holding session open')) return { screen, token: screen_token };
        if (Date.now() > deadline) throw new Error(`agent ${agentId} never settled:\n${screen}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };

  const ptyHostSocket = () => path.join(dirs.home(), 'h.sock');

  /** The office composed as cli.ts composes it, and a first office connected. */
  async function boot(): Promise<void> {
    clients = [];
    sockets = [];
    const workspace = dirs.workspace();
    const layout = options.layout;
    const catalog = options.catalog ?? (() => []);
    const directories = [{ name: 'proj', path: workspace }];

    store = new AgentStateStore();
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    store.setAdapter(adapter);
    runtime = new AgentRuntime(store, claudeProvider);
    unhold = options.holdWorktrees ? holdWorktreesOf(store) : undefined;
    ptyManager = options.noTerminal
      ? PtySessionManager.disabled('Terminal disabled with --no-terminal.')
      : options.ptyHost
        ? await RemotePtySessions.connect({ socketPath: ptyHostSocket() })
        : new PtySessionManager();
    // Agents whose terminals outlived the last server, as cli.ts brings them back.
    reattachTerminalAgents({ store, runtime, ptyManager, provider: claudeProvider });
    const counts = options.assets;
    const terminals = ptyAgentTerminals(ptyManager);
    // Composed as cli.ts composes it, over the test's layout, catalogue and assets.
    // The office's layout and places, read alike by the MCP and the PC shells.
    // As cli.ts: the host's folder and the user's own (config.json).
    const places: OfficePlaceFacts = {
      layout: layout === 'file' ? () => readLayoutFromFile() : (layout ?? (() => null)),
      catalog,
      directories: () => listDirectoryLocations(directories),
      readAreaMappings: () => readConfig().standalone.areaMappings,
    };
    pcShells = new StandalonePcShells({
      ptyManager,
      saves: adapter,
      facts: places,
      // As cli.ts: the Directories every office is shown.
      directories: () => listDirectoryLocations(shownHostDirectories(adapter, directories)),
      broadcast: (message) => store.broadcast({ ...message }),
      providers: hookProviders,
      ...(options.foreground ? { foreground: options.foreground } : {}),
    });
    officeMcp = composeOfficeMcp({
      facts: {
        ...places,
        store,
        provider: options.provider ?? claudeProvider,
        writeLayout: writeLayoutToFile,
        assets: counts ?? (() => ({ floorPatterns: 0, wallSets: 0, carpets: 0, pets: [] })),
        userDirectories: userDirectoryDefaults,
        seats: () => adapter.loadSeats(),
        writeAreaMappings: (mappings) => {
          const cfg = readConfig();
          cfg.standalone.areaMappings = mappings;
          writeConfig(cfg);
        },
        characterRefsChanged: () => {
          for (const m of sharedCharacterRefsMessages({ store, ptyManager })) store.broadcast(m);
        },
      },
      terminals,
      deliveryGuard: screenTokenGuard(terminals),
      ...(options.launch
        ? {
            launch: (request: AgentLaunch, mcp: AgentMcpAccess) =>
              launchForOffice(
                {
                  store,
                  runtime,
                  ptyManager,
                  provider: claudeProvider,
                  mcp,
                  hostDirectories: directories,
                },
                request,
              ),
          }
        : {}),
      ...(options.close
        ? { close: (id: number) => closeStandaloneAgent(ptyManager, runtime, id) }
        : {}),
      // As cli.ts: the PC shell tools over this office's shells.
      pcShells,
      ...(options.tutorial
        ? {
            tutorial: standaloneTutorialSurface(
              {
                store,
                runtime,
                ptyManager,
                provider: options.provider ?? claudeProvider,
                hostDirectories: directories,
              },
              (id: number) => closeStandaloneAgent(ptyManager, runtime, id),
            ),
          }
        : {}),
      ...(options.tools ? { tools: options.tools } : {}),
    });
    // characters.json changed on disk: followed as cli.ts follows it.
    profilesWatcher = watchCharacterProfiles((message) => {
      store.broadcast(message);
      officeMcp.charactersChanged();
    }, store);
    pcShells.restore();
    server = new PixelAgentsServer();
    const config = await server.start({
      store,
      runtime,
      embedded: false,
      ptyManager,
      pcShells,
      pcShellControl: pcShells,
      officeMcp,
    });
    if (options.forwardHooks) {
      server.onHookEvent((providerId, event) => runtime.handleHookEvent(providerId, event));
    }
    port = config.port;
    token = config.token;
    ({ socket, received } = await h.connectOffice());
    if (options.grant) {
      h.send({ type: 'officeMcpConsentResponse', choice: 'allow' });
      await waitFor(
        () => received.find((m) => m.type === 'officeMcpStatus' && m.consent === 'granted'),
        'the grant',
      );
    }
  }

  /** The office stopped as cli.ts's shutdown stops it. */
  async function stop(): Promise<void> {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    for (const ws of sockets.splice(0)) ws.close();
    await ptyManager.shutdown();
    profilesWatcher.dispose();
    officeMcp.dispose();
    unhold?.();
    // With the PTY host the saved agents stay for the next server (cli.ts).
    if (options.ptyHost) runtime.stop();
    else runtime.dispose();
    server.stop();
    store.dispose();
  }

  beforeEach(async () => {
    if (options.ptyHost) ptyHost = await startPtyHost({ socketPath: ptyHostSocket() });
    await boot();
  });

  afterEach(async () => {
    await stop();
    // The PTY host and every terminal still in it.
    await ptyHost?.close();
    ptyHost = null;
  });

  return h;
}

// ── VS Code ─────────────────────────────────────────────────

export interface VscodeOfficeOptions {
  /** Runs with HOME and the workspace made, before the office boots. */
  prepare?: (dirs: { home: string; workspace: string }) => void;
  /** What VS Code's terminal adapter does with text sent to a terminal. */
  sendText: (terminal: TerminalHandle, text: string) => void;
}

export interface VscodeOffice extends AgentSide {
  readonly home: string;
  readonly workspace: string;
  readonly store: AgentStateStore;
  readonly runtime: AgentRuntime;
  readonly mcp: OfficeMcpFeature;
  readonly server: PixelAgentsServer;
  readonly port: number;
  readonly token: string;
  /** Everything the store broadcast (what the webview and /ws offices hear). */
  readonly broadcasts: Message[];
}

/** A VS Code office: the adapter's own MCP composition on the embedded server. */
export function useVscodeOffice(options: VscodeOfficeOptions): VscodeOffice {
  const dirs = useTempHome('pxl-office-vscode', {}, (d) => options.prepare?.(d));
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let mcp: OfficeMcpFeature;
  let server: PixelAgentsServer;
  let port: number;
  let token: string;
  let broadcasts: Message[];
  let clients: Client[] = [];

  const side = agentSide(() => ({ port, token, store, workspace: dirs.workspace(), clients }));
  const h: VscodeOffice = {
    ...side,
    get home() {
      return dirs.home();
    },
    get workspace() {
      return dirs.workspace();
    },
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    get mcp() {
      return mcp;
    },
    get server() {
      return server;
    },
    get port() {
      return port;
    },
    get token() {
      return token;
    },
    get broadcasts() {
      return broadcasts;
    },
  };

  beforeEach(async () => {
    clients = [];
    const workspace = dirs.workspace();
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'vscode' }));
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    runtime = new AgentRuntime(store, claudeProvider);
    mcp = createVscodeOfficeMcp({
      store,
      sendText: options.sendText,
      places: {
        layout: () => null,
        catalog: () => [],
        directories: () => [{ name: 'proj', path: workspace }],
        readAreaMappings: () => readConfig().vscode.areaMappings ?? {},
      },
      assets: () => null,
      characterRefsChanged: () => {},
    });
    server = new PixelAgentsServer();
    server.onHookEvent((providerId, event) => runtime.handleHookEvent(providerId, event));
    const config = await server.start({
      store,
      runtime,
      embedded: true,
      officeMcp: mcp,
    });
    port = config.port;
    token = config.token;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    mcp.dispose();
    runtime.dispose();
    server.stop();
    store.dispose();
  });

  return h;
}

// ── Seeded layouts ──────────────────────────────────────────

export const BLUE = ['#', '3b82f6'].join('');
export const RED = ['#', 'ef4444'].join('');
const WALL_TILE = 0;
const VOID_TILE = 255;

/** The bundled default office (21x22: rooms on rows 11-20, void above and in the last
 *  column) with two Areas: "Blue room" (cols 1-9, the left room) and "API" (cols 11-18,
 *  the right one); the doorway column between them stays unassigned. */
export function seededLayout(): Json {
  const layout = JSON.parse(
    fs.readFileSync(path.join(BUNDLED, 'assets', 'default-layout-1.json'), 'utf8'),
  ) as Json;
  const { cols, rows, tiles } = layout as { cols: number; rows: number; tiles: number[] };
  const areaTiles: Array<string | null> = new Array(cols * rows).fill(null);
  for (let row = 11; row <= 20; row++) {
    for (let col = 1; col <= 18; col++) {
      if (tiles[row * cols + col] === WALL_TILE || tiles[row * cols + col] === VOID_TILE) continue;
      if (col <= 9) areaTiles[row * cols + col] = 'Blue room';
      if (col >= 11) areaTiles[row * cols + col] = 'API';
    }
  }
  return {
    ...layout,
    areas: [
      { label: 'Blue room', color: BLUE },
      { label: 'API', color: RED },
    ],
    areaTiles,
  };
}

/** Write `layout` as ~/.pixel-agents/layout.json (a StandaloneOfficeOptions.prepare step). */
export function seedLayoutFile(home: string, layout: Json): void {
  fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pixel-agents', 'layout.json'), JSON.stringify(layout));
}
