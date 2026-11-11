#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as fs from 'fs';
import * as path from 'path';

import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import { CapabilityRegistry } from './capabilities.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
} from './configPersistence.js';
import {
  MAX_PORT,
  MIN_PORT,
  TASK_DISPATCH_SHIM_FILE_NAME,
  TERMINAL_DISABLED_BY_FLAG_REASON,
} from './constants.js';
import { CuratorBindingStore } from './curatorBindings.js';
import { CuratorTable } from './curators.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import {
  areHooksInstalled as claudeInstallerAreHooksInstalled,
  isHookScriptPresent,
  isPreToolUseHookInstalled,
} from './providers/hook/claude/claudeHookInstaller.js';
import { claudeProvider, copyHookScript, hookProviderById } from './providers/index.js';
import { removeStaleRoleSnapshots } from './roleStorage.js';
import { PixelAgentsServer } from './server.js';
import { PtySessionManager } from './terminal/ptySessionManager.js';
import { ensureWorkspacesFile } from './workspaces.js';
import { GuardStatusReporter } from './writeGuard/guardStatusReporter.js';
import { WriteGuard } from './writeGuard/writeGuard.js';
import { isLoopbackHost } from './wsAuth.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
  /** False when --no-terminal was passed: the office only watches agents; the
   *  browser can neither launch them nor attach to their terminals. */
  terminal: boolean;
  /** False when --no-static was passed: the server answers the API, /ws and the
   *  terminal sockets only, and does not serve the bundled web UI. */
  serveWebUi: boolean;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    host: '127.0.0.1',
    terminal: true,
    serveWebUi: true,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--no-terminal') {
      args.terminal = false;
    } else if (argv[i] === '--no-static') {
      args.serveWebUi = false;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --no-terminal         Disable the embedded terminal (watch agents only; no
                        launching or attaching from the browser)
  --no-static           Do not serve the bundled web UI (API and WebSocket
                        only, for running the backend by itself)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Hooks consent ─────────────────────────────────────────────
// First-run consent is asked IN THE APP, not here: the server sends a
// hooksConsentRequest during the webviewReady handshake
// (clientMessageHandler.ts), and the browser renders the dialog — the same UX
// the VS Code webview shows. The CLI itself never
// prompts; a headless run just starts without hooks until consent is granted
// through the UI. The one exception that needs no dialog is the silent-grant
// migration below (our hooks already installed by a pre-consent version).

/**
 * Copy the bundled hook script into ~/.pixel-agents/hooks/, reporting failure.
 *
 * Callers run this BEFORE installing the settings.json entries and abort when
 * it returns false: an entry whose command points at a missing script makes
 * Claude Code spawn a dead `node` process for every event, which is strictly
 * worse than no hooks at all.
 */
function copyHookScriptOrReport(packageRoot: string, context = ''): boolean {
  if (copyHookScript(packageRoot)) return true;
  console.error(`[Pixel Agents] Hooks NOT installed${context}: hook script missing.`);
  return false;
}

// ── Task dispatch ─────────────────────────────────────────────

/**
 * The bundled stdio shim for the curator's `dispatch_task` MCP tool, or
 * undefined (feature off) when it was not built. Without the shim the launcher
 * must not issue a capability or add --mcp-config: claude would fail to start
 * the server and the token would sit in an env nobody reads.
 */
function taskDispatchShimPathOrReport(distRoot: string): string | undefined {
  const shimPath = path.join(distRoot, 'hooks', TASK_DISPATCH_SHIM_FILE_NAME);
  if (fs.existsSync(shimPath)) return shimPath;
  console.warn(`[Pixel Agents] Task dispatch disabled: ${TASK_DISPATCH_SHIM_FILE_NAME} not built.`);
  return undefined;
}

// ── Terminal status reporting ─────────────────────────────────

/**
 * Log one clear line about terminal availability, plus a security warning when
 * a working terminal is bound to a non-loopback address.
 *
 * The reason string matters: the most likely failure (npm >=11.16 gating
 * node-pty's install scripts, so it imports but can't spawn) is invisible
 * otherwise -- the user would just see a + Agent button that does nothing.
 *
 * Opting out with --no-terminal is not a failure, so it gets a quiet
 * confirmation instead of the reinstall hint, and skips the non-loopback shell
 * warning (there is no shell surface to warn about).
 */
function reportTerminalStatus(
  ptyManager: PtySessionManager,
  host: string,
  enabledByFlag: boolean,
): void {
  if (!enabledByFlag) {
    console.log(
      '[Pixel Agents] Terminal disabled (--no-terminal): agents can be watched but not launched from the browser.',
    );
    return;
  }

  if (!ptyManager.isAvailable()) {
    console.warn(
      `[Pixel Agents] Terminal disabled: ${ptyManager.unavailableReason()}\n` +
        `[Pixel Agents] The office still works; you just can't launch agents from the browser.\n` +
        `[Pixel Agents] To enable it, reinstall so the optional PTY module is present.`,
    );
    return;
  }

  console.log(`[Pixel Agents] Terminal enabled (via ${ptyManager.moduleId()})`);

  if (!isLoopbackHost(host)) {
    console.warn(
      `[Pixel Agents] WARNING: bound to ${host}, not loopback. The terminal is a shell:\n` +
        `[Pixel Agents] anyone who can reach this port can run commands as you.`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const packageRoot = path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);
  // First start creates workspaces.json (default Workspace only); an existing
  // file, valid or not, is never touched here.
  ensureWorkspacesFile();
  // A server that died without cleaning up (crash, SIGKILL) leaves the Role
  // snapshots its agents launched with; only dead pids' directories go.
  await removeStaleRoleSnapshots();

  // ── Create server ──
  const server = new PixelAgentsServer();

  // Terminals for agents this server launches. Construction is cheap -- the
  // native module is resolved (and probed) lazily on first use, so a user who
  // never opens a terminal never pays for it. With --no-terminal, a disabled
  // manager reports "unavailable" through the same plumbing (availability
  // broadcast, session route, launcher), so nothing downstream special-cases it.
  const ptyManager = args.terminal
    ? new PtySessionManager()
    : PtySessionManager.disabled(TERMINAL_DISABLED_BY_FLAG_REASON);

  // Per-agent capabilities and Workspace curators: memory only, gone on
  // restart. Created before anything else subscribes to the store, so the
  // registry hears every removal first. Capabilities are issued only through
  // task dispatch (D1, see taskDispatchShimPath below): launches into a
  // non-default Workspace. Curators (P2) need none: any agent this host
  // launched into a Workspace is eligible, and the table clears itself from the
  // store's removal / Workspace-change / clear events.
  const capabilities = new CapabilityRegistry({ store, ptyManager });
  // KB Writer 綁定（~/.pixel-agents/curator-bindings.json）：重啟後由操作者在綁定的
  // Directory 啟動 agent 時自動恢復。讀檔任何失敗都只是「沒有綁定」，不會中止啟動。
  const curatorBindings = new CuratorBindingStore({
    broadcast: (message) => store.broadcast(message),
  });
  await curatorBindings.load();
  const curators = new CuratorTable({
    store,
    ptyManager,
    broadcast: (message) => store.broadcast(message),
    bindings: curatorBindings,
  });

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, claudeProvider);

    // 阻擋式裁決：只認本行程以 PTY 啟動的 Agent，清單由 server.start 發佈。
    // 受保護區的正式來源（P2）：工作空間根目錄（~/.pixel-agents/workspaces.json）
    // 與已知 Agent 啟動時記錄的 Directory realpath、roleId；curator 由 CuratorTable 提供。
    // 沒有任何工作空間設定根目錄時，KB 規則與 F17 都不啟用，行為與現況相同。
    const writeGuard = new WriteGuard({ store, ptyManager, sessions: runtime, curators });

    // agentGuardStatus（P4）：必須在 writeGuard 之後建立，事件順序才會先更新規則快照。
    // 鏈檢查（settings.json 與腳本檔）只在固定間隔與 hooks 狀態變更時讀檔。
    const guardStatus = new GuardStatusReporter({
      store,
      ptyManager,
      guard: writeGuard,
      curators,
      sessions: runtime,
      broadcast: (message) => store.broadcast(message),
      probeChain: () => ({
        hooksInstalled: claudeInstallerAreHooksInstalled(),
        preToolUsePresent: isPreToolUseHookInstalled(),
        scriptPresent: isHookScriptPresent(),
      }),
    });
    guardStatus.start();

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall the named provider's
    // hooks when the user toggles in the UI (or answers the consent ask).
    // Captures config from the outer scope after server.start().
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (providerId: string, enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      const provider = hookProviderById(providerId);
      if (!provider) return; // unknown id: nothing to install into
      if (enabled) {
        // An explicit toggle in the UI IS the consent to modify the
        // provider's settings file. The bundled claude-hook.js script belongs
        // to the Claude provider alone; another provider's install must
        // neither copy it nor be blocked by it.
        grantHooksConsent(provider.id);
        if (
          provider.id === claudeProvider.id &&
          !copyHookScriptOrReport(packageRoot, ' (user toggle)')
        ) {
          return;
        }
        try {
          await provider.installHooks(
            `http://127.0.0.1:${currentConfig.port}`,
            currentConfig.token,
          );
        } catch (err) {
          console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        console.log('[Pixel Agents] Hooks installed (user toggle)');
      } else {
        try {
          await provider.uninstallHooks();
          console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
        } catch (err) {
          console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    // onReloadAssets side effect: re-run the shared loaders (bundled + external
    // dirs) after an external-asset-directory change, then re-broadcast the
    // updated sprites to the requesting client. Mutates the assetCache object in
    // place so already-open sockets (which captured the same reference) and
    // future webviewReady handshakes both observe the new assets. Only
    // characters/pets/furniture can come from external dirs, so only those three
    // are reloaded and re-sent (mirrors the VS Code reload path).
    const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
      const externalDirs = readConfig().externalAssetDirectories;
      const [characters, pets, furniture] = await Promise.all([
        loadAllCharacters(distRoot, externalDirs),
        loadAllPets(distRoot, externalDirs),
        loadAllFurniture(distRoot, externalDirs),
      ]);
      assetCache.characters = characters;
      assetCache.pets = pets;
      assetCache.furniture = furniture;
      if (characters) {
        send({ type: 'characterSpritesLoaded', characters: characters.characters });
      }
      if (pets) {
        send({
          type: 'petSpritesLoaded',
          pets: pets.pets,
          petNames: pets.manifests.map((m) => m.name),
        });
      }
      if (furniture) {
        send({
          type: 'furnitureAssetsLoaded',
          catalog: furniture.catalog,
          sprites: Object.fromEntries(furniture.sprites),
        });
      }
      console.log('[Pixel Agents] Assets reloaded (external directory change)');
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir: args.serveWebUi ? staticDir : undefined,
      assetCache,
      onSetHooksEnabled,
      onReloadAssets,
      ptyManager,
      capabilities,
      curators,
      writeGuard,
      guardStatus,
      taskDispatchShimPath: taskDispatchShimPathOrReport(distRoot),
    });
    currentConfig = { port: config.port, token: config.token };

    reportTerminalStatus(ptyManager, args.host, args.terminal);

    // Sync runtime refs with persisted settings BEFORE first scan tick. The
    // runtime's single hooksEnabled ref follows the Claude provider until the
    // scanners grow per-provider awareness alongside the Settings UI.
    runtime.hooksEnabled.current = getHooksEnabled(claudeProvider.id);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so — gated on the
    // one-time consent to modify ~/.claude/settings.json.
    if (runtime.hooksEnabled.current) {
      let consent = getHooksConsent(claudeProvider.id) === 'granted';
      if (!consent && (await claudeProvider.areHooksInstalled())) {
        // Our hooks are already installed and already firing — a pre-consent
        // version put them there. Grant and continue with NO prompt: the
        // install below is the 14 -> 12 migration, and it only ever REDUCES
        // scope (it drops UserPromptSubmit and TaskCreated, the two events that
        // forwarded prompt text and were consumed by nothing). Asking would buy
        // this user no protection they do not already have, so they are not
        // asked. A fresh install still is, in full — in the browser UI, when a
        // client connects (clientMessageHandler's webviewReady).
        grantHooksConsent(claudeProvider.id);
        consent = true;
      }
      if (!consent) {
        console.log(
          '[Pixel Agents] Hooks not installed: modifying ~/.claude/settings.json needs one-time approval — open the URL below to review and approve it.',
        );
      } else if (copyHookScriptOrReport(packageRoot)) {
        try {
          await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          console.log('[Pixel Agents] Hooks installed');
        } catch (err) {
          console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      // Without this line, a persisted hooks-off makes startup skip the entire
      // consent/install flow with zero output — indistinguishable from a bug.
      console.log(
        '[Pixel Agents] Hooks disabled — enable "Instant Detection (Hooks)" in the UI settings to install them.',
      );
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    // The URL the operator opens has to be REACHABLE: a wildcard bind address
    // is a bind target, not an address you can browse to — `--host 0.0.0.0`
    // used to print a dead `http://0.0.0.0:PORT`.
    const displayHost =
      args.host === '0.0.0.0' || args.host === '::' || args.host === '' ? '127.0.0.1' : args.host;
    console.log(`\n  Pixel Agents server running at http://${displayHost}:${config.port}/\n`);

    // ── Graceful shutdown ──
    let shuttingDown = false;
    async function shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nShutting down...');
      // Kill child terminals before the runtime tears their agents down, and
      // wait for them: exiting now would cancel the SIGKILL escalation and
      // leave a child that ignores SIGHUP orphaned on a dead server.
      await ptyManager.disposeAll();
      runtime.dispose();
      guardStatus.dispose();
      // 已排定的綁定寫入（例如剛解除的 KB Writer）寫完再結束。
      await curatorBindings.flush();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
