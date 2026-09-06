import type { HookProvider } from '../../core/src/provider.js';
import { resendAgentActivity } from './agentActivityResend.js';
import { buildAgentDiagnostics } from './agentDiagnostics.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import {
  getHooksConsent,
  getHooksEnabled,
  readConfig,
  setHooksEnabled,
  writeConfig,
} from './configPersistence.js';
import { HUE_SHIFT_MAX_DEG, PALETTE_COUNT, TERMINAL_REQUIRES_TOKEN_REASON } from './constants.js';
import {
  handleDirectoryClientMessage,
  type HostDirectoryEntry,
  listDirectories,
} from './directories.js';
import { collectDirectorySuggestions } from './directorySuggestions.js';
import { hostDirectory } from './hostDirectory.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';
import type { ConsentEffects } from './providers/hook/consentExecutor.js';
import { applyConsentChoice } from './providers/hook/consentExecutor.js';
import { hooksConsentRequest } from './providers/hook/consentGate.js';
import { claudeProvider, hookProviderById, hookProviders } from './providers/index.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import { launchStandaloneAgent } from './terminal/standaloneAgentLauncher.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (
  providerId: string,
  enabled: boolean,
) => Promise<void> | void;

/**
 * Reload server-side assets after an external-asset-directory change and
 * re-broadcast the updated sprites to the requesting client. Provided by cli.ts,
 * which owns the dist root needed to re-run the loaders.
 */
export type ReloadAssetsSideEffect = (send: WsSend) => Promise<void> | void;

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  pets: LoadedPetSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  carpetTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export interface ClientMessageContext {
  store: AgentStateStore;
  runtime?: AgentRuntime;
  cache: AssetCache | null;
  /** Install/uninstall hooks side effect. Needs server url+token known only to cli.ts. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Reload assets after an external-asset-directory change. Needs the dist root, known only to cli.ts. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /**
   * Whether this client may send messages that reach OUTSIDE `~/.pixel-agents/`
   * — today only `setHooksEnabled`, which grants machine-wide consent to modify
   * `~/.claude/settings.json`. Decided per-connection by the transport
   * (httpServer's standaloneTokenValid, or the embedded Bearer token); defaults
   * to false so a caller that forgets to pass it gets the safe answer.
   */
  privileged?: boolean;
  /** PTY terminals for standalone-launched agents. Absent in VS Code embedded
   *  mode, where the editor owns terminal lifecycle. */
  ptyManager?: PtySessionManager;
}

// ── Setting key constants (mirror adapters/vscode/constants.ts) ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
const KEY_GHOST_HEADLESS_AGENTS = 'pixel-agents.ghostHeadlessAgents';
const KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
const KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';
const KEY_SHOW_AREAS = 'pixel-agents.showAreas';
const KEY_BYPASS_PERMISSIONS = 'pixel-agents.bypassPermissions';

/**
 * This host's own Directory contribution: the directory the server was started
 * from. Gated on ptyManager for the same reason directoriesLoaded is — no
 * ptyManager means VS Code embedded mode, whose adapter contributes its
 * workspace folders instead and must not have this server's cwd added to them.
 */
function hostDirectoriesFor(ctx: ClientMessageContext): HostDirectoryEntry[] {
  return ctx.ptyManager ? [hostDirectory()] : [];
}

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'launchAgent': {
      // Standalone can launch: the agent runs in a server-side PTY streamed to
      // the browser drawer. That PTY is a shell running as the operator, so only
      // a privileged (tokened) connection may open one -- the same rule as the
      // hooks toggle, for the same reason: an untokened viewer on the network
      // may watch the office, not act on this machine.
      if (!runtime || !ctx.ptyManager) break;
      if (!ctx.privileged) {
        console.warn(
          '[Pixel Agents] Ignoring launchAgent from an untokened client — launching a terminal needs the tokened URL the CLI printed.',
        );
        break;
      }
      // Permission posture is a persisted per-host setting, never a per-launch
      // field: the client sends only where to launch. Every launch comes from a
      // drawer row and carries its Directory's path; no directoryPath falls
      // back to the server cwd (launchStandaloneAgent's own default).
      launchStandaloneAgent(
        { store, runtime, ptyManager: ctx.ptyManager, provider: claudeProvider },
        {
          directoryPath: msg.directoryPath as string | undefined,
          bypassPermissions: adapter?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false,
        },
      );
      break;
    }

    case 'closeAgent': {
      // Two shapes now: a PTY-backed agent we launched (kill the process -- the
      // counterpart of VS Code's terminalRef.dispose()), or an external agent we
      // merely observed (dismiss the file so the scanner doesn't re-adopt it,
      // then remove). removeAgent fires agentRemoved, which httpServer maps to
      // an agentClosed broadcast.
      const id = msg.id as number;
      const agent = store.get(id);
      if (agent && runtime) {
        // Killing a PTY we launched is an action on this machine, gated like
        // launching it was. Dismissing a merely-observed agent only touches
        // ~/.pixel-agents/ state and stays open to every viewer.
        if (ctx.ptyManager?.has(id) && !ctx.privileged) {
          console.warn(
            '[Pixel Agents] Ignoring closeAgent for a PTY-backed agent from an untokened client.',
          );
          break;
        }
        // dispose() is a no-op for agents with no terminal, so this is safe for
        // both shapes. The PTY's onExit handler does the store cleanup for
        // PTY-backed agents; do it here too so external agents (and a PTY that
        // never exits) are still removed promptly.
        ctx.ptyManager?.dispose(id);
        runtime.dismissalTracker.dismiss(agent.jsonlFile);
        runtime.removeAgent(id);
      }
      break;
    }

    case 'requestDiagnostics':
      // Point-to-point reply to the requesting socket (NOT a broadcast).
      send({ type: 'agentDiagnostics', agents: buildAgentDiagnostics(store) });
      break;

    case 'saveLayout':
      if (msg.layout) {
        writeLayoutToFile(msg.layout as Record<string, unknown>);
      }
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        const seats = msg.seats as Record<
          string,
          { palette?: number; hueShift?: number; seatId?: string }
        >;
        // Sync palette/hueShift back to AgentState so existingAgents stays
        // consistent across reconnects. Validate ranges to keep a remote
        // client (or a hand-edited payload) from corrupting the stored
        // values with out-of-range inputs that would render as a glitch.
        // Palette ceiling is dynamic: external asset directories can add
        // char_N.png beyond the bundled 6, so read the count from the asset
        // cache instead of hardcoding PALETTE_COUNT.
        const paletteCount = cache?.characters?.characters.length ?? PALETTE_COUNT;
        for (const [idStr, meta] of Object.entries(seats)) {
          const id = Number(idStr);
          const agent = store.get(id);
          if (agent) {
            if (
              meta.palette !== undefined &&
              Number.isInteger(meta.palette) &&
              meta.palette >= 0 &&
              meta.palette < paletteCount
            ) {
              agent.palette = meta.palette;
            }
            if (
              meta.hueShift !== undefined &&
              Number.isInteger(meta.hueShift) &&
              meta.hueShift >= 0 &&
              meta.hueShift <= HUE_SHIFT_MAX_DEG
            ) {
              agent.hueShift = meta.hueShift;
            }
          }
        }
        adapter?.saveSeats(seats);
      }
      break;

    case 'setSoundEnabled':
      adapter?.setSetting(KEY_SOUND_ENABLED, msg.enabled);
      break;

    case 'setLastSeenVersion':
      adapter?.setSetting(KEY_LAST_SEEN_VERSION, msg.version as string);
      break;

    case 'setAlwaysShowLabels':
      adapter?.setSetting(KEY_ALWAYS_SHOW_LABELS, msg.enabled);
      break;

    case 'setGhostHeadlessAgents':
      adapter?.setSetting(KEY_GHOST_HEADLESS_AGENTS, msg.enabled);
      break;

    case 'setWatchAllSessions': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_WATCH_ALL_SESSIONS, enabled);
      if (runtime) runtime.watchAllSessions.current = enabled;
      break;
    }

    case 'setHooksEnabled': {
      const enabled = msg.enabled as boolean;
      // The provider id is echoed by the client, never originated: an unknown
      // id names nothing to install into, so it is dropped like a junk choice.
      const provider = hookProviderById(msg.providerId);
      if (!provider) break;
      if (!ctx.privileged) {
        // No server token on this connection: the toggle would grant durable
        // consent to modify a settings file on THIS machine, and only the
        // operator — who was handed the tokened URL — gets to decide that.
        // Answer with the truth so the checkbox still shows reality instead of
        // silently appearing to have worked.
        console.warn(
          '[Pixel Agents] Ignoring setHooksEnabled from an untokened client — installing hooks needs approval from this machine (open the tokened URL the CLI printed).',
        );
        void provider
          .areHooksInstalled()
          .then((installed) => send({ type: 'hooksStatus', providerId: provider.id, installed }));
        break;
      }
      void applyHooksPreference(ctx, send, provider, enabled);
      break;
    }

    case 'hooksConsentResponse': {
      // Privilege: the request is only ever sent to tokened connections, so a
      // response from an untokened one is a crafted message — ignored, same
      // reasoning as setHooksEnabled above.
      if (!ctx.privileged) {
        console.warn(
          '[Pixel Agents] Ignoring hooksConsentResponse from an untokened client — installing hooks needs approval from this machine (open the tokened URL the CLI printed).',
        );
        break;
      }
      // Fail-closed on the provider exactly like on the choice: an id naming
      // no registered provider writes nothing.
      const provider = hookProviderById(msg.providerId);
      if (!provider) break;
      void applyConsentChoice(
        provider.id,
        msg.choice,
        standaloneConsentEffects(ctx, send, provider),
      );
      break;
    }

    case 'setHooksInfoShown':
      adapter?.setSetting(KEY_HOOKS_INFO_SHOWN, true);
      break;

    case 'addExternalAssetDirectory': {
      const newPath = msg.path as string | undefined;
      if (!newPath) break;
      const cfg = readConfig();
      if (!cfg.externalAssetDirectories.includes(newPath)) {
        cfg.externalAssetDirectories.push(newPath);
        writeConfig(cfg);
      }
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void ctx.onReloadAssets?.(send);
      break;
    }

    case 'removeExternalAssetDirectory': {
      const removePath = msg.path as string | undefined;
      if (!removePath) break;
      const cfg = readConfig();
      cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter((d) => d !== removePath);
      writeConfig(cfg);
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void ctx.onReloadAssets?.(send);
      break;
    }

    case 'saveAreaMappings': {
      const rawMappings = msg.mappings;
      if (!rawMappings || typeof rawMappings !== 'object') {
        break;
      }
      const cfg = readConfig();
      cfg.standalone.areaMappings = rawMappings as Record<string, string[]>;
      writeConfig(cfg);
      break;
    }

    case 'setShowAreas': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_SHOW_AREAS, enabled);
      break;
    }

    case 'setBypassPermissions': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_BYPASS_PERMISSIONS, enabled);
      break;
    }

    case 'saveDirectory':
    case 'removeDirectory':
    case 'requestDirectorySuggestions':
      // Shared with the VS Code adapter: same validation, same union, same
      // machine-wide config. Success rebroadcasts to every connected office
      // (store.broadcast fans out to all sockets); a rejection — and the
      // suggestion list — answers only the client that asked.
      handleDirectoryClientMessage(msg, {
        hostDirectories: () => hostDirectoriesFor(ctx),
        broadcast: (message) => store.broadcast(message),
        reply: send,
        suggestions: () => collectDirectorySuggestions(claudeProvider, hostDirectoriesFor(ctx)),
      });
      break;

    default:
      // focusAgent is handled entirely client-side in standalone (it focuses the
      // drawer tab, which the server has no say in). exportLayout / importLayout
      // still require IDE-specific handling.
      break;
  }
}

/**
 * Run the install/uninstall side effect, then persist the provider's preference — only after it settled and only when
 * the on-disk result agrees. Writing it first strands the user when an uninstall fails: entries keep firing while the
 * persisted hooks-off makes the next startup skip the gate entirely. Shared by the Settings toggle and the consent
 * dialog's Install (both are grants). Never rejects — it is fire-and-forget and bound by the ConsentEffects contract,
 * so a failure surfaces on the console here or nowhere.
 */
async function applyHooksPreference(
  ctx: ClientMessageContext,
  send: WsSend,
  provider: HookProvider,
  enabled: boolean,
): Promise<void> {
  try {
    await ctx.onSetHooksEnabled?.(provider.id, enabled);
    const installed = await provider.areHooksInstalled();
    if (installed === enabled) {
      setHooksEnabled(provider.id, enabled);
      // The runtime's single hooksEnabled ref gates the CLAUDE scanners; it
      // follows only the Claude provider until the scanners grow per-provider
      // awareness alongside the Settings UI.
      if (ctx.runtime && provider.id === claudeProvider.id) {
        ctx.runtime.hooksEnabled.current = enabled;
      }
    }
    // Always report the ACTUAL install state — the toggle expresses intent,
    // not outcome (the installer refuses to touch an unparseable file).
    send({ type: 'hooksStatus', providerId: provider.id, installed });
  } catch (err) {
    console.error('[Pixel Agents] Applying the hooks preference failed:', err);
  }
}

/**
 * This surface's half of carrying out a consent answer for one provider. The choice→action rule and the write order
 * live in the shared consent modules; only these effects are standalone-specific (console, socket), each bound to the
 * one provider being answered.
 */
function standaloneConsentEffects(
  ctx: ClientMessageContext,
  send: WsSend,
  provider: HookProvider,
): ConsentEffects {
  return {
    setHooksEnabled: (enabled) => applyHooksPreference(ctx, send, provider, enabled),
    uninstallHooks: async () => {
      // The same side effect the toggle runs, minus the preference write. The
      // catch keeps the never-reject contract true by construction — the host
      // callback's own contract is unstated.
      try {
        await ctx.onSetHooksEnabled?.(provider.id, false);
      } catch (err) {
        console.error('[Pixel Agents] Hook uninstall failed:', err);
      }
    },
    areHooksInstalled: () => provider.areHooksInstalled(),
    syncHooksPreferenceOff: () => {
      // Durable writes are the executor's own atomic recordHooksDecline; this
      // only mirrors the live runtime ref the CLAUDE scanners read, so another
      // provider's answer can never flip Claude's fallback behavior.
      if (ctx.runtime && provider.id === claudeProvider.id) {
        ctx.runtime.hooksEnabled.current = false;
      }
    },
    reportHooksStatus: async () => {
      try {
        send({
          type: 'hooksStatus',
          providerId: provider.id,
          installed: await provider.areHooksInstalled(),
        });
      } catch {
        // Never let a status broadcast mask the error already surfaced.
      }
    },
  };
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  // 1. Provider capabilities (must arrive before any agent messages)
  send({
    type: 'providerCapabilities',
    readingTools: [...claudeProvider.readingTools],
    subagentToolNames: [...claudeProvider.subagentToolNames],
  });

  // 1b. Terminal availability. Gates the whole terminal UI (the + Agent button
  // and the drawer), so it must land before the client can act on agents.
  // Absent ptyManager = VS Code embedded mode, which owns its own terminals and
  // must not be told the standalone terminal is unavailable.
  // Availability is per CONNECTION, not per server: an untokened client is told
  // the terminal is unavailable (with the reason) because launchAgent and the
  // terminal socket would refuse it anyway -- better a disabled button that
  // says why than one that silently does nothing.
  if (ctx.ptyManager) {
    const privileged = ctx.privileged === true;
    send({
      type: 'terminalAvailability',
      available: privileged && ctx.ptyManager.isAvailable(),
      reason:
        ctx.ptyManager.unavailableReason() ??
        (privileged ? undefined : TERMINAL_REQUIRES_TOKEN_REASON),
    });
  }

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.pets) {
      send({
        type: 'petSpritesLoaded',
        pets: cache.pets.pets,
        petNames: cache.pets.manifests.map((m) => m.name),
      });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.carpetTiles) {
      send({ type: 'carpetTilesLoaded', sets: cache.carpetTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  // 3. Layout is sent AFTER existingAgents — see step 7 below. The webview
  // buffers agents from existingAgents and only materializes them on the next
  // layoutLoaded (useExtensionMessages.ts: "Buffer agents — they'll be added
  // in layoutLoaded"), so layout-first would leave a client that connects
  // after agent creation with no characters.

  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const watchAllSessions = adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false;
  // settingsLoaded.hooksEnabled stays a single boolean carrying the CLAUDE
  // provider's preference until the Settings UI grows a per-provider list —
  // its sole webview reader is the hooks tooltip gate.
  const hooksEnabled = getHooksEnabled(claudeProvider.id);
  const showAreas = adapter?.getSetting(KEY_SHOW_AREAS, false) ?? false;
  send({
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    ghostHeadlessAgents: adapter?.getSetting(KEY_GHOST_HEADLESS_AGENTS, false) ?? false,
    hooksEnabled,
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: cfg.externalAssetDirectories,
    showAreas,
    bypassPermissions: adapter?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false,
  });

  // 4a. Actual install state, distinct from the hooksEnabled preference —
  // hooksEnabled defaults true while first-run consent is still pending. The
  // provider checks are async, so these land as follow-ups right after the
  // synchronous handshake; the webview's default (not installed) is the safe
  // assumption until each arrives. One status + at most one ask PER PROVIDER.
  for (const provider of hookProviders) {
    // One provider's unreadable settings file must degrade to
    // installed=false (matching the executor's fail-closed read: no choice
    // ever uninstalls on a guess) rather than surface as an unhandled
    // rejection that can take the process down — and must never block the
    // other providers' statuses.
    void provider
      .areHooksInstalled()
      .catch((err: unknown) => {
        console.error(`[Pixel Agents] hooks status check failed for provider ${provider.id}:`, err);
        return false;
      })
      .then((installed) => {
        send({ type: 'hooksStatus', providerId: provider.id, installed });
        // 4a-bis. First-run consent, asked in the app: this connect is the moment the user can be asked, so the ask
        // rides the handshake and consentGate owns every condition (VS Code calls the same function). The record is
        // re-read here rather than taken from startup — another tab may have answered while this one loaded.
        // Dismissing sends nothing, so the ask returns on the next connect: fail-closed, never nagging in-session.
        const request = hooksConsentRequest(
          {
            installed,
            hooksEnabled: getHooksEnabled(provider.id),
            consentAnswered: getHooksConsent(provider.id) !== 'unanswered',
            privileged: ctx.privileged === true,
          },
          provider,
        );
        if (request) send({ ...request }); // spread: WsSend takes an index-signature shape
      });
  }

  // 4b. Directory→Area mappings (must arrive before existingAgents so the
  // webview seat-preference logic has the dict when characters are created).
  send({
    type: 'areaMappingsLoaded',
    mappings: cfg.standalone.areaMappings ?? {},
  });

  // 4c. Directories: the user-defined ones from the shared config merged with
  // standalone's native context, the directory the server was started from —
  // one read-only host entry, the counterpart of VS Code contributing its
  // workspace folders. Gated on ptyManager for the same reason
  // terminalAvailability is: no ptyManager means VS Code embedded mode, whose
  // adapter contributes its own Directories.
  if (ctx.ptyManager) {
    send({ type: 'directoriesLoaded', directories: listDirectories(hostDirectoriesFor(ctx)) });
  }

  // Sync runtime refs with the persisted settings so scanners behave correctly
  // from the first tick after a server restart.
  if (runtime) {
    runtime.watchAllSessions.current = watchAllSessions;
    runtime.hooksEnabled.current = hooksEnabled;
  }

  // 5. Restore persisted external agents (standalone only; VS Code handles its own restore)
  runtime?.restoreExternalAgents();

  // 6. Existing agents (either just restored, or from VS Code adapter if present)
  const agentIds: number[] = [];
  const directoryNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  const persistedSeats = adapter?.loadSeats() ?? {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.directoryName) {
      directoryNames[id] = agent.directoryName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
    const persisted = persistedSeats[String(id)];
    agentMeta[id] = {
      palette: agent.palette,
      hueShift: agent.hueShift,
      seatId: persisted?.seatId,
    };
  }
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    directoryNames,
    externalAgents,
  });

  // 7. Layout last (see step 3): flushes the webview's buffered existingAgents
  // into characters once seats are rebuilt.
  const savedLayout = readLayoutFromFile();
  send({ type: 'layoutLoaded', layout: savedLayout ?? cache?.defaultLayout ?? null });

  // 8. Agent state, AFTER layoutLoaded -- the characters they target only
  // exist once the layout flush creates them. Without this a reconnecting
  // client shows bare characters until each agent takes another turn.
  resendAgentActivity(send, store);

  // 9. Re-announce live terminals AFTER existingAgents, so a browser that
  // reloaded (or a second tab) rebuilds its drawer tabs. The PTY outlives the
  // socket, so these sessions are still attachable and their scrollback replays
  // on connect. Privileged connections only: an untokened client was told the
  // terminal is unavailable and could not attach anyway.
  if (ctx.ptyManager && ctx.privileged) {
    for (const id of agentIds) {
      if (ctx.ptyManager.has(id)) {
        send({ type: 'terminalSessionOpened', agentId: id });
      }
    }
  }
}
