import { resendAgentActivity } from './agentActivityResend.js';
import { buildAgentDiagnostics } from './agentDiagnostics.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import { readConfig, writeConfig } from './configPersistence.js';
import { HUE_SHIFT_MAX_DEG, PALETTE_COUNT } from './constants.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';
import { claudeProvider } from './providers/index.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (enabled: boolean) => Promise<void> | void;

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
}

// ── Setting key constants (mirror adapters/vscode/constants.ts) ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
const KEY_GHOST_HEADLESS_AGENTS = 'pixel-agents.ghostHeadlessAgents';
const KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
const KEY_HOOKS_ENABLED = 'pixel-agents.hooksEnabled';
const KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';
const KEY_SHOW_AREAS = 'pixel-agents.showAreas';

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

    case 'closeAgent': {
      // Standalone agents are always external (no terminal), so mirror the VS
      // Code external-agent branch: dismiss the file (so the external scanner
      // doesn't re-adopt it) then remove. removeAgent fires the agentRemoved
      // store event, which httpServer maps to an agentClosed broadcast.
      const id = msg.id as number;
      const agent = store.get(id);
      if (agent && runtime) {
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
      adapter?.setSetting(KEY_HOOKS_ENABLED, enabled);
      if (runtime) runtime.hooksEnabled.current = enabled;
      void ctx.onSetHooksEnabled?.(enabled);
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

    default:
      // focusAgent, exportLayout, importLayout
      // require IDE-specific handling (not yet implemented for standalone)
      break;
  }
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
  const hooksEnabled = adapter?.getSetting(KEY_HOOKS_ENABLED, true) ?? true;
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
  });

  // 4b. Folder→Area mappings (must arrive before existingAgents so the
  // webview seat-preference logic has the dict when characters are created).
  send({
    type: 'areaMappingsLoaded',
    mappings: cfg.standalone.areaMappings ?? {},
  });

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
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  const persistedSeats = adapter?.loadSeats() ?? {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
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
    folderNames,
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
}
