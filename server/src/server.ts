import * as crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import {
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SERVER_REGISTRY_PROTOCOL_VERSION,
  SERVERS_DIR,
} from './constants.js';
import { createHttpServer } from './httpServer.js';
import type { ServerConfig } from './serverConfig.js';
import { isServerConfig, isServerTarget } from './serverConfig.js';

export type { ServerConfig } from './serverConfig.js';

/** Callback invoked when a hook event is received from a provider's hook script. */
type HookEventCallback = (providerId: string, event: Record<string, unknown>) => void;

/**
 * Pixel Agents server: receives hook events, broadcasts state via WebSocket,
 * and optionally serves the SPA in standalone mode.
 *
 * Routes (via Fastify in httpServer.ts):
 * - `POST /api/hooks/:providerId` -- hook event (auth required, 64KB body limit)
 * - `GET /api/health` -- health check (no auth)
 * - `GET /ws` -- WebSocket for real-time agent state (auth required)
 *
 * Discovery: writes `~/.pixel-agents/server.json` (legacy single-target pointer)
 * and `~/.pixel-agents/servers/<pid>-<port>.json` (multi-server registry entry)
 * with port, PID, auth token, and capability flags.
 * Multi-window / multi-surface: a second instance detects running servers via
 * the registry and reuses one only when it offers the same capability
 * (embedded reuses embedded, standalone reuses standalone) -- an embedded
 * VS Code server and a standalone `npx pixel-agents` server can run at once,
 * each owning its own registry entry, both reachable by hook fan-out.
 */
export class PixelAgentsServer {
  private app: FastifyInstance | null = null;
  private config: ServerConfig | null = null;
  private ownsServer = false;
  private callback: HookEventCallback | null = null;

  /** Register a callback for incoming hook events from any provider. */
  onHookEvent(callback: HookEventCallback): void {
    this.callback = callback;
  }

  /**
   * Start the server. If a compatible instance is already running (detected via
   * the multi-server registry), reuses its config without starting a new one.
   */
  async start(options?: {
    store?: AgentStateStore;
    runtime?: AgentRuntime;
    embedded?: boolean;
    host?: string;
    port?: number;
    staticDir?: string;
    assetCache?: AssetCache;
    onSetHooksEnabled?: SetHooksEnabledSideEffect;
    onReloadAssets?: ReloadAssetsSideEffect;
  }): Promise<ServerConfig> {
    const embedded = options?.embedded ?? true;
    const wantsSpa = !embedded;

    // Capability-based reuse: an embedded (VS Code) caller only reuses another
    // embedded server (today's multi-window sharing); a standalone caller only
    // reuses another standalone -- never across the boundary, which is what
    // used to leave a standalone attached to VS Code's SPA-less embedded
    // server (blank page). Prune dead entries first so a crashed server's
    // stale file never blocks discovery of a live one.
    const registry = this.readAndPruneRegistry();
    const candidate = registry.find((e) => e.servesSpa === wantsSpa);
    if (candidate) {
      this.config = candidate;
      this.ownsServer = false;
      console.log(
        `[Pixel Agents] Reusing existing ${wantsSpa ? 'standalone' : 'embedded'} server on port ${candidate.port} (PID ${candidate.pid})`,
      );
      return candidate;
    }

    // Start our own server
    const token = crypto.randomUUID();
    const store = options?.store;

    const { app, port } = await createHttpServer({
      embedded,
      host: options?.host,
      port: options?.port,
      token,
      store: store!,
      runtime: options?.runtime,
      staticDir: options?.staticDir,
      assetCache: options?.assetCache,
      onHookEvent: (providerId, event) => this.callback?.(providerId, event),
      onSetHooksEnabled: options?.onSetHooksEnabled,
      onReloadAssets: options?.onReloadAssets,
    });

    this.app = app;
    this.config = {
      port,
      pid: process.pid,
      token,
      startedAt: Date.now(),
      servesSpa: wantsSpa,
      protocol: SERVER_REGISTRY_PROTOCOL_VERSION,
      // Diagnostic-only: forward the debug-log path to the hook script via
      // server.json (env vars don't reach the spawned hook reliably).
      ...(process.env['PIXEL_AGENTS_DEBUG_LOG']
        ? { debugLog: process.env['PIXEL_AGENTS_DEBUG_LOG'] }
        : {}),
    };
    this.ownsServer = true;
    // Dual-write: legacy single-target pointer (old hook scripts) + registry
    // entry (new hook scripts fan out to every entry here).
    this.writeServerJson(this.config);
    this.writeRegistryEntry(this.config);
    console.log(`[Pixel Agents] Server: listening on 127.0.0.1:${port}`);

    return this.config;
  }

  /** Stop the server and clean up its discovery records (only if we own them). */
  stop(): void {
    if (this.app) {
      this.app.close();
      this.app = null;
    }
    if (this.ownsServer) {
      this.deleteServerJson();
      this.deleteRegistryEntry();
    }
    this.config = null;
    this.ownsServer = false;
  }

  /** Returns the current server config, or null if not started. */
  getConfig(): ServerConfig | null {
    return this.config;
  }

  /** Returns the absolute path to ~/.pixel-agents/server.json. */
  private getServerJsonPath(): string {
    return path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
  }

  /** Write server.json atomically (tmp + rename) with mode 0o600. */
  private writeServerJson(config: ServerConfig): void {
    const filePath = this.getServerJsonPath();
    const dir = path.dirname(filePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      console.error(`[Pixel Agents] Failed to write server.json: ${e}`);
    }
  }

  /**
   * Delete the legacy server.json only if the PID inside matches our process
   * (safe for multi-window / multi-server: never removes another server's
   * pointer). Known gap during mixed-version skew (A2): because this file is
   * a single pointer, whichever server most recently (re)claimed it "owns"
   * it -- if that server later stops while a DIFFERENT, still-live server
   * coexists, this deletes the only pointer an old (pre-registry) hook
   * script can find, even though a compatible server is still running. The
   * registry (servers/) doesn't have this problem -- each entry is deleted
   * strictly self-only (D6) and a new hook script always prefers it over
   * this legacy file. Accepted: A2 already treats "an old script reaches at
   * most one server" as the baseline degradation for this skew window.
   */
  private deleteServerJson(): void {
    try {
      const filePath = this.getServerJsonPath();
      if (!fs.existsSync(filePath)) return;
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (isServerTarget(existing) && existing.pid === process.pid) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // File may already be gone
    }
  }

  /** Returns the absolute path to ~/.pixel-agents/servers/. */
  private getRegistryDir(): string {
    return path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);
  }

  /** Returns the absolute path to this config's registry entry file. Keyed on
   *  pid+port (not pid alone) so two servers started in the same process --
   *  which happens in tests, never in production where pids are unique per
   *  process -- still get distinct, non-colliding registry files. */
  private getRegistryFilePath(config: Pick<ServerConfig, 'pid' | 'port'>): string {
    return path.join(this.getRegistryDir(), `${config.pid}-${config.port}.json`);
  }

  /**
   * Read every registry entry, pruning (deleting) any whose owning PID is no
   * longer alive -- so a crashed server's stale file never blocks discovery
   * or gets fanned out to by the hook script. Malformed/mid-write files are
   * treated the same as dead entries and removed. Returns only live entries.
   */
  private readAndPruneRegistry(): ServerConfig[] {
    const dir = this.getRegistryDir();
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return []; // Directory doesn't exist yet -- no live servers registered.
    }

    const live: ServerConfig[] = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
        if (!isServerConfig(entry)) {
          fs.unlinkSync(filePath);
          continue;
        }
        if (isProcessRunning(entry.pid)) {
          live.push(entry);
        } else {
          fs.unlinkSync(filePath);
        }
      } catch {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* already gone */
        }
      }
    }
    return live;
  }

  /** Write this server's registry entry atomically (tmp + rename) with mode 0o600. */
  private writeRegistryEntry(config: ServerConfig): void {
    const dir = this.getRegistryDir();
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const filePath = this.getRegistryFilePath(config);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      console.error(`[Pixel Agents] Failed to write registry entry: ${e}`);
    }
  }

  /** Delete this server's own registry entry (self-only cleanup, mirrors deleteServerJson). */
  private deleteRegistryEntry(): void {
    if (!this.config) return;
    try {
      const filePath = this.getRegistryFilePath(this.config);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // File may already be gone
    }
  }
}

/** Check if a process is alive by sending signal 0 (no-op, just checks existence). */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
