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
import type { HookProvider } from '../../../core/src/provider.js';
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
import { readConfig, writeConfig } from '../../src/configPersistence.js';
import { FileStateAdapter } from '../../src/fileStateAdapter.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../src/layoutPersistence.js';
import { composeOfficeMcp, type OfficeMcpFeature } from '../../src/mcp/composeOfficeMcp.js';
import type { OfficeOperations } from '../../src/mcp/officeOperations.js';
import type { OfficeTool } from '../../src/mcp/tool.js';
import { claudeProvider } from '../../src/providers/index.js';
import { PixelAgentsServer } from '../../src/server.js';
import { PtySessionManager } from '../../src/terminal/ptySessionManager.js';

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
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      if (result.isError) return { isError: true, value: null, text };
      return { isError: false, value: JSON.parse(text) as Json, text };
    },
    async callToolCaught(client, name, args = {}) {
      try {
        return await side.callTool(client, name, args);
      } catch (err) {
        return { isError: true, value: null, text: String(err) };
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
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });
  return { home: () => home, workspace: () => workspace };
}

// ── Standalone ──────────────────────────────────────────────

export interface StandaloneOfficeOptions {
  /** Temp dir prefix. */
  name?: string;
  /** Runs with HOME and the workspace made, before the office boots. */
  prepare?: (dirs: { home: string; workspace: string }) => void;
  /** What the office reads as its layout: a function, or 'file' (layout.json). Default: none. */
  layout?: 'file' | (() => Record<string, unknown> | null);
  /** The furniture catalogue the office reads. Default: none. */
  catalog?: () => readonly CatalogSource[];
  /** The loaded asset counts and pets (get_layout's / list_catalog's). */
  assets?: () => OfficeAssetCounts & { pets: LoadedPetSprites['manifests'] };
  /** The MCP's tool table (default: every tool). */
  tools?: readonly OfficeTool[];
  /** After the handshake, the office answers the MCP ask with allow. */
  grant?: boolean;
  /** The CLI the MCP writes agents' config files for. Default: Claude's. */
  provider?: HookProvider;
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
  readonly ptyManager: PtySessionManager;
  readonly office: OfficeOperations;
  readonly officeMcp: OfficeMcpFeature;
  readonly server: PixelAgentsServer;
  readonly port: number;
  /** The server token (privileged offices and hook posts carry it). */
  readonly token: string;
  /** The first office's socket and everything it was sent. */
  readonly socket: WebSocket;
  readonly received: Json[];

  /** Another office on /ws, handshake done (privileged unless told not). */
  connectOffice(opts?: { privileged?: boolean }): Promise<{ socket: WebSocket; received: Json[] }>;
  /** A message from the first office (or the given socket). */
  send(message: Message, ws?: WebSocket): void;
  /** The office's answer to the MCP ask, once the status comes back. */
  answer(choice: 'allow' | 'decline'): Promise<void>;
  /** mock-claude's invocations.log lines. */
  invocations(): string[];
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
}

export function useStandaloneOffice(options: StandaloneOfficeOptions = {}): StandaloneOffice {
  const dirs = useTempHome(options.name ?? 'pxl-office-mcp', {}, (d) => {
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
  let ptyManager: PtySessionManager;
  let officeMcp: OfficeMcpFeature;
  let server: PixelAgentsServer;
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
      return ptyManager;
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
    invocations: () => mockLog('invocations.log'),
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
  };

  beforeEach(async () => {
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
    ptyManager = new PtySessionManager();
    const counts = options.assets;
    // Composed as cli.ts composes it, over the test's layout, catalogue and assets.
    officeMcp = composeOfficeMcp({
      facts: {
        store,
        provider: options.provider ?? claudeProvider,
        layout: layout === 'file' ? () => readLayoutFromFile() : (layout ?? (() => null)),
        writeLayout: writeLayoutToFile,
        catalog,
        assets: counts ?? (() => ({ floorPatterns: 0, wallSets: 0, carpets: 0, pets: [] })),
        directories: () => directories,
        seats: () => adapter.loadSeats(),
        readAreaMappings: () => readConfig().standalone.areaMappings,
        writeAreaMappings: (mappings) => {
          const cfg = readConfig();
          cfg.standalone.areaMappings = mappings;
          writeConfig(cfg);
        },
      },
      ...(options.tools ? { tools: options.tools } : {}),
    });
    server = new PixelAgentsServer();
    const config = await server.start({
      store,
      runtime,
      embedded: false,
      ptyManager,
      officeMcp,
    });
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
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    for (const ws of sockets.splice(0)) ws.close();
    await ptyManager.shutdown();
    officeMcp.dispose();
    runtime.dispose();
    server.stop();
    store.dispose();
  });

  return h;
}

// ── VS Code ─────────────────────────────────────────────────

export interface VscodeOfficeOptions {
  /** Runs with HOME and the workspace made, before the office boots. */
  prepare?: (dirs: { home: string; workspace: string }) => void;
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
      defaultLayout: () => null,
      assets: () => null,
      directories: () => [{ name: 'proj', path: workspace }],
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
