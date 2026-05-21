import * as crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AssetCache, SetHooksEnabledSideEffect } from './clientMessageHandler.js';
import { SERVER_JSON_DIR, SERVER_JSON_NAME } from './constants.js';
import { createHttpServer } from './httpServer.js';

/** Discovery file written to ~/.pixel-agents/server.json so hook scripts can find the server. */
export interface ServerConfig {
  /** Port the HTTP server is listening on */
  port: number;
  /** PID of the process that owns the server */
  pid: number;
  /** Auth token required in Authorization header for hook requests */
  token: string;
  /** Timestamp (ms) when the server started */
  startedAt: number;
}

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
 * Discovery: writes `~/.pixel-agents/server.json` with port, PID, and auth token.
 * Multi-window: second VS Code window detects running server via server.json and
 * reuses it (does not start a second server).
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
   * Start the server. If another instance is already running (detected via
   * server.json PID check), reuses that server's config without starting a new one.
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
  }): Promise<ServerConfig> {
    // Check if another instance already has a server running
    const existing = this.readServerJson();
    if (existing && isProcessRunning(existing.pid)) {
      this.config = existing;
      this.ownsServer = false;
      console.log(
        `[Pixel Agents] Reusing existing server on port ${existing.port} (PID ${existing.pid})`,
      );
      return existing;
    }

    // Start our own server
    const token = crypto.randomUUID();
    const store = options?.store;

    const { app, port } = await createHttpServer({
      embedded: options?.embedded ?? true,
      host: options?.host,
      port: options?.port,
      token,
      store: store!,
      runtime: options?.runtime,
      staticDir: options?.staticDir,
      assetCache: options?.assetCache,
      onHookEvent: (providerId, event) => this.callback?.(providerId, event),
      onSetHooksEnabled: options?.onSetHooksEnabled,
    });

    this.app = app;
    this.config = {
      port,
      pid: process.pid,
      token,
      startedAt: Date.now(),
    };
    this.ownsServer = true;
    this.writeServerJson(this.config);
    console.log(`[Pixel Agents] Server: listening on 127.0.0.1:${port}`);

    return this.config;
  }

  /** Stop the server and clean up server.json (only if we own it). */
  stop(): void {
    if (this.app) {
      this.app.close();
      this.app = null;
    }
    if (this.ownsServer) {
      this.deleteServerJson();
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

  /** Read and parse server.json. Returns null if missing or malformed. */
  private readServerJson(): ServerConfig | null {
    try {
      const filePath = this.getServerJsonPath();
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ServerConfig;
    } catch {
      return null;
    }
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

  /** Delete server.json only if the PID inside matches our process (safe for multi-window). */
  private deleteServerJson(): void {
    try {
      const filePath = this.getServerJsonPath();
      if (!fs.existsSync(filePath)) return;
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ServerConfig;
      if (existing.pid === process.pid) {
        fs.unlinkSync(filePath);
      }
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
